import * as hap from 'hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';
import { RedactedDiagnosticLogger } from '../../src/diagnostics/redacted-logger.js';
import {
  currentLockLabel,
  LockMechanismAccessory,
} from '../../src/devices/lock.js';
import { StateReducer } from '../../src/state/model.js';
import type {
  DeviceAttribute,
  SmartRentTransport,
} from '../../src/transport/types.js';

const deviceId = 'synthetic-lock';

class FakeTransport implements SmartRentTransport {
  writes: DeviceAttribute[][] = [];
  rejectWrite = false;

  async authenticate(): Promise<void> {}
  async completeTotp(): Promise<void> {}
  async refreshOrReauthenticate(): Promise<void> {}
  async discoverDevices(): Promise<[]> {
    return [];
  }
  async getDeviceState(): Promise<never> {
    throw new Error('unused');
  }
  async setDeviceAttributes(
    _id: string,
    attributes: DeviceAttribute[],
  ): Promise<{ accepted: true }> {
    this.writes.push(attributes);
    if (this.rejectWrite) throw new Error('synthetic timeout');
    return { accepted: true };
  }
  async connect(): Promise<number> {
    return 1;
  }
  async joinChannel(): Promise<void> {}
  async heartbeat(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async reconnect(): Promise<number> {
    return 1;
  }
  onDeviceEvent(): () => void {
    return () => undefined;
  }
  onConnectionChange(): () => void {
    return () => undefined;
  }
}

function seed(reducer: StateReducer, value: unknown = true): void {
  reducer.registerDevice(deviceId);
  const fence = reducer.captureRestFence(deviceId);
  reducer.applyRestSnapshot(
    deviceId,
    fence,
    {
      online: true,
      attributes: { locked: value },
      smartrentTimestamp: '2026-09-01T00:00:00.000Z',
    },
    1_000,
  );
}

function setup() {
  const reducer = new StateReducer();
  seed(reducer);
  const transport = new FakeTransport();
  const lines: string[] = [];
  const diagnostics = new RedactedDiagnosticLogger({
    info: (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    },
    warn: (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    },
  } as never);
  const service = new hap.Service.LockMechanism('Front Door', deviceId);
  const accessory = {
    getServiceById: vi.fn(() => service),
    addService: vi.fn(() => service),
  } as unknown as PlatformAccessory;
  const lock = new LockMechanismAccessory({
    alias: 'Front Door',
    deviceId,
    reducer,
    transport,
    diagnostics,
    api: hap,
    accessory,
    logger: { warn: () => undefined } as never,
    now: () => 1_000,
  });
  return { reducer, transport, diagnostics, lines, service, lock };
}

describe('SmartRent lock mapping and HomeKit behavior', () => {
  it.each([
    [true, 'SECURED'],
    ['true', 'SECURED'],
    [false, 'UNSECURED'],
    ['false', 'UNSECURED'],
    [null, 'UNKNOWN'],
    ['unexpected', 'UNKNOWN'],
  ])('maps explicit %s report to %s', (value, expected) => {
    const reducer = new StateReducer();
    seed(reducer, value);
    expect(currentLockLabel(reducer.getDevice(deviceId))).toBe(expected);
  });

  it('uses native LockMechanism, cache-only reads, and one accepted write without changing current state', async () => {
    const { reducer, transport, service, lock } = setup();
    const current = service.getCharacteristic(
      hap.Characteristic.LockCurrentState,
    );
    const target = service.getCharacteristic(
      hap.Characteristic.LockTargetState,
    );

    await expect(current.handleGetRequest()).resolves.toBe(
      hap.Characteristic.LockCurrentState.SECURED,
    );
    await target.handleSetRequest(hap.Characteristic.LockTargetState.UNSECURED);
    expect(transport.writes).toEqual([[{ name: 'locked', state: false }]]);
    expect(reducer.getDevice(deviceId).requested.locked?.status).toBe(
      'accepted',
    );
    await expect(current.handleGetRequest()).resolves.toBe(
      hap.Characteristic.LockCurrentState.SECURED,
    );

    reducer.applyEvent(
      deviceId,
      'locked',
      false,
      0,
      2_000,
      'reported-unlocked',
    );
    lock.refreshFromState();
    await expect(current.handleGetRequest()).resolves.toBe(
      hap.Characteristic.LockCurrentState.UNSECURED,
    );
  });

  it('returns UNKNOWN on disconnect and after ambiguous command timeout without retry', async () => {
    const { reducer, transport, service } = setup();
    const current = service.getCharacteristic(
      hap.Characteristic.LockCurrentState,
    );
    reducer.setConnection(false, 0);
    await expect(current.handleGetRequest()).resolves.toBe(
      hap.Characteristic.LockCurrentState.UNKNOWN,
    );

    transport.rejectWrite = true;
    const target = service.getCharacteristic(
      hap.Characteristic.LockTargetState,
    );
    await expect(
      target.handleSetRequest(hap.Characteristic.LockTargetState.UNSECURED),
    ).rejects.toBe(-70402);
    expect(transport.writes).toHaveLength(1);
    expect(reducer.getDevice(deviceId).requested.locked?.status).toBe(
      'unresolved',
    );
    await expect(current.handleGetRequest()).resolves.toBe(
      hap.Characteristic.LockCurrentState.UNKNOWN,
    );
  });

  it('logs only allow-listed state fields and excludes unsafe aliases', async () => {
    const { lines, service } = setup();
    await service
      .getCharacteristic(hap.Characteristic.LockTargetState)
      .handleSetRequest(hap.Characteristic.LockTargetState.SECURED);
    expect(lines.some((line) => line.includes('APPLE_REQUESTED'))).toBe(true);
    expect(lines.some((line) => line.includes('synthetic-access-token'))).toBe(
      false,
    );
    expect(lines.some((line) => line.includes('synthetic-lock'))).toBe(false);
  });
});
