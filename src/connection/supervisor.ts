import type { DeviceState, StateReducer } from '../state/model.js';
import type {
  ConnectionChange,
  DeviceEvent,
  SmartRentTransport,
} from '../transport/types.js';

export interface ConnectionSupervisorOptions {
  transport: SmartRentTransport;
  reducer: StateReducer;
  deviceIds: readonly string[];
  onStateChange?: (state: DeviceState) => void;
  onDiagnostic?: (
    event:
      | 'connected'
      | 'disconnected'
      | 'reconnected'
      | 'join-failed'
      | 'reconcile-failed'
      | 'heartbeat-failed',
    epoch: number,
  ) => void;
  heartbeatIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  random?: () => number;
  now?: () => number;
}

/** Owns one SmartRent socket and bounds reconnect work. It never polls lock state. */
export class ConnectionSupervisor {
  private running = false;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private failures = 0;
  private currentEpoch = 0;
  private readonly joinedEpochs = new Map<number, Promise<void>>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly options: ConnectionSupervisorOptions) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.unsubscribers.push(
      this.options.transport.onConnectionChange((change) =>
        this.connectionChanged(change),
      ),
      this.options.transport.onDeviceEvent((event, epoch) =>
        this.deviceEvent(event, epoch),
      ),
    );
    await this.connectNow();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.clearTimers();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await this.options.transport.disconnect();
  }

  private async connectNow(): Promise<void> {
    if (!this.running || this.connecting) return;
    this.connecting = true;
    try {
      const epoch = await this.options.transport.connect();
      await this.connected({ connected: true, epoch, reason: 'opened' });
    } catch {
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private connectionChanged(change: ConnectionChange): void {
    if (!this.running) return;
    if (change.connected) {
      void this.connected(change).catch(() => this.reconnectAfterFailure());
      return;
    }
    if (change.epoch < this.currentEpoch) return;
    if (
      change.epoch === this.currentEpoch ||
      change.epoch > this.currentEpoch
    ) {
      if (change.epoch > this.options.reducer.connectionEpoch) {
        this.options.reducer.startConnectionEpoch(change.epoch);
      }
      this.currentEpoch = Math.max(this.currentEpoch, change.epoch);
      this.options.reducer.setConnection(false, change.epoch);
      this.emitStateForAll();
      this.stopHeartbeat();
      this.options.onDiagnostic?.('disconnected', change.epoch);
    }
    this.scheduleReconnect();
  }

  private connected(change: ConnectionChange): Promise<void> {
    if (change.epoch < this.currentEpoch) return Promise.resolve();
    const existing = this.joinedEpochs.get(change.epoch);
    if (existing) return existing;
    for (const epoch of this.joinedEpochs.keys()) {
      if (epoch < change.epoch) this.joinedEpochs.delete(epoch);
    }
    const work = this.performConnected(change);
    this.joinedEpochs.set(change.epoch, work);
    return work;
  }

  private async performConnected(change: ConnectionChange): Promise<void> {
    if (!this.running) return;
    const newer = change.epoch > this.options.reducer.connectionEpoch;
    if (newer) this.options.reducer.startConnectionEpoch(change.epoch);
    this.currentEpoch = change.epoch;
    this.options.reducer.setConnection(true, change.epoch);
    this.emitStateForAll();
    this.options.onDiagnostic?.(
      change.epoch > 1 ? 'reconnected' : 'connected',
      change.epoch,
    );
    this.startHeartbeat(change.epoch);

    try {
      // Join every configured channel before reading. Events received during each read
      // advance the reducer generation and fence off stale REST results.
      await Promise.all(
        this.options.deviceIds.map((deviceId) =>
          this.options.transport.joinChannel(deviceId),
        ),
      );
    } catch {
      this.options.onDiagnostic?.('join-failed', change.epoch);
      await this.reconnectAfterFailure();
      return;
    }
    if (!this.running || change.epoch !== this.currentEpoch) return;

    await Promise.all(
      this.options.deviceIds.map((deviceId) =>
        this.reconcileOnce(deviceId, change.epoch),
      ),
    );
    this.failures = 0;
  }

  private async reconcileOnce(deviceId: string, epoch: number): Promise<void> {
    const fence = this.options.reducer.captureRestFence(deviceId);
    try {
      const device = await this.options.transport.getDeviceState(deviceId);
      if (!this.running || epoch !== this.currentEpoch) return;
      const result = this.options.reducer.applyRestSnapshot(
        deviceId,
        fence,
        {
          online: device.online,
          attributes: device.attributes,
          ...(device.updatedAt ? { smartrentTimestamp: device.updatedAt } : {}),
        },
        (this.options.now ?? Date.now)(),
      );
      if (result.kind === 'accepted')
        this.options.onStateChange?.(result.state);
    } catch {
      if (!this.running || epoch !== this.currentEpoch) return;
      const unknown = this.options.reducer.markDeviceUnknown(
        deviceId,
        'unavailable',
      );
      this.options.onStateChange?.(unknown);
      this.options.onDiagnostic?.('reconcile-failed', epoch);
    }
  }

  private deviceEvent(event: DeviceEvent, epoch: number): void {
    if (!this.running || epoch !== this.currentEpoch) return;
    const result = this.options.reducer.applyEvent(
      event.deviceId,
      event.attribute,
      event.value,
      epoch,
      (this.options.now ?? Date.now)(),
      event.eventId,
      event.smartrentTimestamp,
    );
    if (result.kind === 'accepted' || result.kind === 'conflict')
      this.options.onStateChange?.(result.state);
  }

  private startHeartbeat(epoch: number): void {
    this.stopHeartbeat();
    const schedule = () => {
      if (!this.running || epoch !== this.currentEpoch) return;
      this.heartbeatTimer = setTimeout(async () => {
        try {
          await this.options.transport.heartbeat();
          schedule();
        } catch {
          this.options.onDiagnostic?.('heartbeat-failed', epoch);
          await this.reconnectAfterFailure();
        }
      }, this.options.heartbeatIntervalMs ?? 30_000);
    };
    schedule();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async reconnectAfterFailure(): Promise<void> {
    if (!this.running) return;
    this.stopHeartbeat();
    try {
      await this.options.transport.disconnect();
    } catch {
      // Reconnect scheduling still proceeds; no payload or error text is logged.
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const base = this.options.reconnectBaseMs ?? 5_000;
    const maximum = this.options.reconnectMaxMs ?? 60_000;
    const exponential = Math.min(
      maximum,
      base * 2 ** Math.min(this.failures, 10),
    );
    const jitter =
      0.75 +
      Math.max(0, Math.min(1, (this.options.random ?? Math.random)())) * 0.5;
    const delay = Math.floor(exponential * jitter);
    this.failures += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectNow();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopHeartbeat();
  }

  private emitStateForAll(): void {
    for (const deviceId of this.options.deviceIds) {
      this.options.onStateChange?.(this.options.reducer.getDevice(deviceId));
    }
  }
}
