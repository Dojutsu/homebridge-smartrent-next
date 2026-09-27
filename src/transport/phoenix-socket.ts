import WebSocket from 'ws';
import type { ConnectionChange, DeviceEvent } from './types.js';
import { SmartRentTransportError } from './errors.js';

type PhoenixFrame = [null, string | null, string, string, unknown];
type Reply = { status?: string; response?: unknown };
type Pending = {
  action: 'join' | 'heartbeat';
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};
export type PhoenixProtocolObservation =
  | {
      kind: 'acknowledgement';
      action: 'join' | 'heartbeat';
      status: 'ok' | 'error';
      referenceCorrelated: true;
    }
  | {
      kind: 'device-event-envelope';
      shape: 'nested-attribute_state' | 'direct-attribute_state';
      event: 'attribute_state_updated' | 'other-attribute-state';
    };
export type SocketFactory = (url: string) => WebSocket;

export interface PhoenixSocketOptions {
  socketUrl: string;
  heartbeatTimeoutMs?: number;
  joinTimeoutMs?: number;
  socketFactory?: SocketFactory;
  onDeviceEvent: (event: DeviceEvent, epoch: number) => void;
  onConnectionChange: (change: ConnectionChange) => void;
  warn: (message: string) => void;
  observeProtocol?: (event: PhoenixProtocolObservation) => void;
}

export class PhoenixSocket {
  private socket: WebSocket | undefined;
  private connecting: Promise<number> | undefined;
  private epoch = 0;
  private ref = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly joined = new Set<string>();
  private readonly makeSocket: SocketFactory;

  constructor(private readonly options: PhoenixSocketOptions) {
    this.makeSocket = options.socketFactory ?? ((url) => new WebSocket(url));
  }

  get connectionEpoch(): number {
    return this.epoch;
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(token: string): Promise<number> {
    if (this.isConnected) return this.epoch;
    if (this.connecting) return this.connecting;

    await this.disconnect('replaced', false);
    const epoch = ++this.epoch;
    const url = new URL(this.options.socketUrl);
    url.searchParams.set('token', token);
    url.searchParams.set('vsn', '2.0.0');
    const socket = this.makeSocket(url.toString());
    this.socket = socket;

    this.connecting = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new SmartRentTransportError('WebSocket open timed out'));
      }, 30_000);
      socket.once('open', () => {
        clearTimeout(timeout);
        if (this.socket !== socket)
          return reject(
            new SmartRentTransportError('WebSocket was replaced while opening'),
          );
        this.options.onConnectionChange({
          connected: true,
          epoch,
          reason: 'opened',
        });
        resolve(epoch);
      });
      socket.once('error', () => {
        clearTimeout(timeout);
        if (this.socket === socket) {
          this.options.onConnectionChange({
            connected: false,
            epoch,
            reason: 'error',
          });
        }
        reject(new SmartRentTransportError('WebSocket connection failed'));
      });
      socket.on('message', (data) =>
        this.handleMessage(socket, epoch, data.toString()),
      );
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.joined.clear();
        this.rejectPending('WebSocket closed');
        this.options.onConnectionChange({
          connected: false,
          epoch,
          reason: 'closed',
        });
      });
    }).finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  async joinChannel(deviceId: string): Promise<void> {
    if (!this.isConnected || !this.socket)
      throw new SmartRentTransportError('WebSocket is not connected');
    if (this.joined.has(deviceId)) return;
    const ref = this.nextRef();
    await this.sendAndWait(
      ref,
      [null, ref, `devices:${deviceId}`, 'phx_join', {}],
      this.options.joinTimeoutMs ?? 5_000,
      'join',
    );
    this.joined.add(deviceId);
  }

  async heartbeat(): Promise<void> {
    if (!this.isConnected || !this.socket)
      throw new SmartRentTransportError('WebSocket is not connected');
    const ref = this.nextRef();
    await this.sendAndWait(
      ref,
      [null, ref, 'phoenix', 'heartbeat', {}],
      this.options.heartbeatTimeoutMs ?? 10_000,
      'heartbeat',
    );
  }

  async disconnect(
    reason: ConnectionChange['reason'] = 'closed',
    notify = true,
  ): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    this.socket = undefined;
    this.joined.clear();
    this.rejectPending('WebSocket disconnected');
    if (notify)
      this.options.onConnectionChange({
        connected: false,
        epoch: this.epoch,
        reason,
      });
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close();
    }
  }

  private nextRef(): string {
    this.ref += 1;
    return String(this.ref);
  }

  private async sendAndWait(
    ref: string,
    frame: PhoenixFrame,
    timeoutMs: number,
    action: Pending['action'],
  ): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      throw new SmartRentTransportError('WebSocket is not connected');
    const result = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(ref);
        reject(
          new SmartRentTransportError('Phoenix acknowledgement timed out'),
        );
      }, timeoutMs);
      this.pending.set(ref, { action, resolve, reject, timeout });
    });
    socket.send(JSON.stringify(frame), (error) => {
      if (!error) return;
      const pending = this.pending.get(ref);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(ref);
      pending.reject(new SmartRentTransportError('Phoenix frame send failed'));
    });
    return result;
  }

  private handleMessage(socket: WebSocket, epoch: number, raw: string): void {
    if (this.socket !== socket || epoch !== this.epoch) return;
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      this.options.warn('Ignored malformed Phoenix message');
      return;
    }
    if (!Array.isArray(frame) || frame.length < 5) {
      this.options.warn('Ignored malformed Phoenix frame');
      return;
    }
    const [, refValue, topic, eventName, payload] = frame as unknown[];
    if (eventName === 'phx_reply' && typeof refValue === 'string') {
      const pending = this.pending.get(refValue);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(refValue);
      const status =
        (payload as Reply | null)?.status === 'ok' ? 'ok' : 'error';
      this.options.observeProtocol?.({
        kind: 'acknowledgement',
        action: pending.action,
        status,
        referenceCorrelated: true,
      });
      if (status === 'ok') pending.resolve();
      else
        pending.reject(
          new SmartRentTransportError('Phoenix acknowledgement was not ok'),
        );
      return;
    }
    if (
      typeof topic !== 'string' ||
      !topic.startsWith('devices:') ||
      typeof eventName !== 'string' ||
      !eventName.includes('attribute_state')
    )
      return;
    const deviceId = topic.slice('devices:'.length);
    const eventPayload = payload as Record<string, unknown> | null;
    const nested = Boolean(
      eventPayload && typeof eventPayload.attribute_state === 'object',
    );
    const attributeState =
      nested && eventPayload
        ? (eventPayload.attribute_state as Record<string, unknown>)
        : eventPayload;
    if (
      !attributeState ||
      typeof attributeState.name !== 'string' ||
      !('last_read_state' in attributeState)
    ) {
      this.options.warn('Ignored malformed SmartRent attribute event');
      return;
    }
    this.options.observeProtocol?.({
      kind: 'device-event-envelope',
      shape: nested ? 'nested-attribute_state' : 'direct-attribute_state',
      event:
        eventName === 'attribute_state_updated'
          ? 'attribute_state_updated'
          : 'other-attribute-state',
    });
    const normalized: DeviceEvent = {
      deviceId,
      attribute: attributeState.name,
      value: attributeState.last_read_state,
      ...(typeof attributeState.id === 'string' ||
      typeof attributeState.id === 'number'
        ? { eventId: String(attributeState.id) }
        : {}),
      ...(typeof attributeState.last_read_state_changed_at === 'string'
        ? { smartrentTimestamp: attributeState.last_read_state_changed_at }
        : {}),
    };
    this.options.onDeviceEvent(normalized, epoch);
  }

  private rejectPending(message: string): void {
    for (const [ref, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new SmartRentTransportError(message));
      this.pending.delete(ref);
    }
  }
}
