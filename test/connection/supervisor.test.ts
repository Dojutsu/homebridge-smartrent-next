import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionSupervisor } from '../../src/connection/supervisor.js';
import {
  readAuthoritativeAttribute,
  StateReducer,
} from '../../src/state/model.js';
import type {
  ConnectionChange,
  DeviceEvent,
  SmartRentDevice,
  SmartRentTransport,
} from '../../src/transport/types.js';

class FakeTransport implements SmartRentTransport {
  epoch = 0;
  connected = false;
  joins: string[] = [];
  reads: string[] = [];
  heartbeats = 0;
  failHeartbeat = false;
  deferReads: Promise<void> | undefined;
  readonly connectionListeners = new Set<(change: ConnectionChange) => void>();
  readonly eventListeners = new Set<
    (event: DeviceEvent, epoch: number) => void
  >();

  async authenticate(): Promise<void> {}
  async completeTotp(): Promise<void> {}
  async refreshOrReauthenticate(): Promise<void> {}
  async discoverDevices(): Promise<SmartRentDevice[]> {
    return [];
  }
  async getDeviceState(deviceId: string): Promise<SmartRentDevice> {
    this.reads.push(deviceId);
    await this.deferReads;
    return {
      id: deviceId,
      hubId: 'synthetic-hub',
      name: deviceId,
      type: 'synthetic',
      online: true,
      attributes: { locked: true },
      updatedAt: '2026-09-01T00:00:01.000Z',
    };
  }
  async setDeviceAttributes(): Promise<{ accepted: true }> {
    return { accepted: true };
  }
  async connect(): Promise<number> {
    this.epoch += 1;
    this.connected = true;
    this.connectionListeners.forEach((listener) =>
      listener({ connected: true, epoch: this.epoch, reason: 'opened' }),
    );
    return this.epoch;
  }
  async joinChannel(deviceId: string): Promise<void> {
    this.joins.push(deviceId);
  }
  async heartbeat(): Promise<void> {
    this.heartbeats += 1;
    if (this.failHeartbeat) throw new Error('synthetic missed acknowledgement');
  }
  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    this.connectionListeners.forEach((listener) =>
      listener({ connected: false, epoch: this.epoch, reason: 'closed' }),
    );
  }
  async reconnect(): Promise<number> {
    return this.connect();
  }
  onDeviceEvent(
    listener: (event: DeviceEvent, epoch: number) => void,
  ): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onConnectionChange(listener: (change: ConnectionChange) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }
  emitEvent(event: DeviceEvent, epoch = this.epoch): void {
    this.eventListeners.forEach((listener) => listener(event, epoch));
  }
}

const deviceIds = ['synthetic-lock', 'synthetic-thermostat'] as const;

afterEach(() => vi.useRealTimers());

describe('ConnectionSupervisor', () => {
  it('joins each channel and performs exactly one read per device after acknowledgement', async () => {
    const transport = new FakeTransport();
    const reducer = new StateReducer();
    const supervisor = new ConnectionSupervisor({
      transport,
      reducer,
      deviceIds,
      heartbeatIntervalMs: 30_000,
      random: () => 0.5,
    });
    await supervisor.start();

    expect(transport.joins).toEqual([...deviceIds]);
    expect(transport.reads).toEqual([...deviceIds]);
    transport.connectionListeners.forEach((listener) =>
      listener({ connected: true, epoch: 1, reason: 'opened' }),
    );
    await Promise.resolve();
    expect(transport.reads).toEqual([...deviceIds]);

    await supervisor.stop();
  });

  it('lets a WebSocket report fence off the single stale rejoin snapshot', async () => {
    let releaseRead!: () => void;
    const waitForRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const transport = new FakeTransport();
    transport.deferReads = waitForRead;
    const reducer = new StateReducer();
    const supervisor = new ConnectionSupervisor({
      transport,
      reducer,
      deviceIds: ['synthetic-lock'],
    });
    const startup = supervisor.start();
    await vi.waitFor(() => expect(transport.reads).toEqual(['synthetic-lock']));
    transport.emitEvent({
      deviceId: 'synthetic-lock',
      eventId: 'synthetic-event-newer',
      attribute: 'locked',
      value: false,
      smartrentTimestamp: '2026-09-01T00:00:02.000Z',
    });
    releaseRead();
    await startup;
    expect(
      readAuthoritativeAttribute(reducer.getDevice('synthetic-lock'), 'locked'),
    ).toBe(false);
    expect(transport.reads).toHaveLength(1);
    await supervisor.stop();
  });

  it('rejoins and reads once after disconnect using bounded jittered backoff', async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const reducer = new StateReducer();
    const supervisor = new ConnectionSupervisor({
      transport,
      reducer,
      deviceIds: ['synthetic-lock'],
      reconnectBaseMs: 4_000,
      random: () => 0.5,
    });
    await supervisor.start();
    await transport.disconnect();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(transport.epoch).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.epoch).toBe(2);
    expect(transport.joins).toEqual(['synthetic-lock', 'synthetic-lock']);
    expect(transport.reads).toEqual(['synthetic-lock', 'synthetic-lock']);
    await supervisor.stop();
  });

  it('uses heartbeat acknowledgements for connection health and does not poll state', async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const reducer = new StateReducer();
    const supervisor = new ConnectionSupervisor({
      transport,
      reducer,
      deviceIds: ['synthetic-lock'],
      heartbeatIntervalMs: 1_000,
      reconnectBaseMs: 2_000,
      random: () => 0.5,
    });
    await supervisor.start();
    transport.failHeartbeat = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.heartbeats).toBe(1);
    expect(transport.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(transport.epoch).toBe(2);
    expect(transport.reads).toHaveLength(2);
    await supervisor.stop();
  });
});
