import * as hap from 'hap-nodejs';
import { PlatformAccessory as HomebridgePlatformAccessory } from 'homebridge/lib/platformAccessory.js';
import type { API, Logging, PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';
import {
  PLATFORM_NAME,
  SmartRentPlatform,
  type SmartRentPlatformConfig,
} from '../../src/platform/smart-rent-platform.js';
import type {
  ConnectionChange,
  DeviceAttribute,
  DeviceEvent,
  SmartRentDevice,
  SmartRentTransport,
} from '../../src/transport/types.js';

const configuredIds = {
  lock: 'synthetic-lock',
  thermostat: 'synthetic-thermostat',
  washerLeak: 'synthetic-washer-leak',
  kitchenLeak: 'synthetic-kitchen-leak',
};

function makeDevices(): SmartRentDevice[] {
  return [
    {
      id: configuredIds.lock,
      hubId: 'hub',
      name: 'lock',
      type: 'door_lock',
      online: true,
      attributes: { locked: true },
      batteryLevel: 88,
    },
    {
      id: configuredIds.thermostat,
      hubId: 'hub',
      name: 'thermostat',
      type: 'thermostat',
      online: true,
      attributes: {
        mode: 'heat',
        operating_state: 'idle',
        current_temp: '68',
        current_humidity: '50',
        heating_setpoint: '70',
        cooling_setpoint: '75',
      },
    },
    {
      id: configuredIds.washerLeak,
      hubId: 'hub',
      name: 'washer',
      type: 'leak_sensor',
      online: true,
      attributes: { leak: false },
      batteryLevel: 70,
    },
    {
      id: configuredIds.kitchenLeak,
      hubId: 'hub',
      name: 'kitchen',
      type: 'leak_sensor',
      online: true,
      attributes: { leak: true },
      batteryLevel: 65,
    },
  ];
}

class FakeTransport implements SmartRentTransport {
  readonly devices = makeDevices();
  readonly joined: string[] = [];
  readonly reads: string[] = [];
  readonly writes: Array<{ id: string; attributes: DeviceAttribute[] }> = [];
  readonly connectionListeners = new Set<(change: ConnectionChange) => void>();
  readonly eventListeners = new Set<
    (event: DeviceEvent, epoch: number) => void
  >();
  epoch = 0;
  connected = false;

  async authenticate(): Promise<void> {}
  async completeTotp(): Promise<void> {}
  async refreshOrReauthenticate(): Promise<void> {}
  async discoverDevices(): Promise<SmartRentDevice[]> {
    return this.devices;
  }
  async getDeviceState(deviceId: string): Promise<SmartRentDevice> {
    this.reads.push(deviceId);
    const device = this.devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw new Error('synthetic unknown device');
    return device;
  }
  async setDeviceAttributes(
    deviceId: string,
    attributes: DeviceAttribute[],
  ): Promise<{ accepted: true }> {
    this.writes.push({ id: deviceId, attributes });
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
    this.joined.push(deviceId);
  }
  async heartbeat(): Promise<void> {}
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
}

function homebridgeHarness() {
  const handlers = new Map<string, () => void>();
  const registered: PlatformAccessory[] = [];
  const log = {
    prefix: 'test',
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  } as unknown as Logging;
  const api = {
    hap,
    platformAccessory: HomebridgePlatformAccessory,
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
    }),
    registerPlatformAccessories: vi.fn(
      (
        _plugin: string,
        _platform: string,
        accessories: PlatformAccessory[],
      ) => {
        registered.push(...accessories);
      },
    ),
    unregisterPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
  } as unknown as API;
  return {
    api,
    log,
    registered,
    fire: (event: string) => handlers.get(event)?.(),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for synthetic Homebridge platform');
}

describe('SmartRent dynamic platform', () => {
  it('does not connect, register accessories, or attempt discovery without an authorized transport provider', async () => {
    const harness = homebridgeHarness();
    new SmartRentPlatform(
      harness.log,
      { platform: PLATFORM_NAME, devices: configuredIds },
      harness.api,
    );
    harness.fire('didFinishLaunching');
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.registered).toHaveLength(0);
    expect(harness.api.registerPlatformAccessories).not.toHaveBeenCalled();
  });

  it('registers the four configured synthetic accessories with stable UUIDs and native services', async () => {
    const harness = homebridgeHarness();
    const transport = new FakeTransport();
    new SmartRentPlatform(
      harness.log,
      {
        platform: PLATFORM_NAME,
        devices: configuredIds,
        temperatureUnit: 'celsius',
      },
      harness.api,
      () => transport,
    );
    harness.fire('didFinishLaunching');
    await waitUntil(
      () => harness.registered.length === 4 && transport.reads.length === 4,
    );

    expect(harness.registered).toHaveLength(4);
    for (const accessory of harness.registered) {
      const id = (accessory.context.smartRentNext as { deviceId: string })
        .deviceId;
      expect(accessory.UUID).toBe(hap.uuid.generate(id.toString()));
      expect(
        accessory
          .getService(hap.Service.AccessoryInformation)
          ?.getCharacteristic(hap.Characteristic.SerialNumber).value,
      ).toBe(id);
    }
    const lock = harness.registered.find(
      (accessory) => accessory.UUID === hap.uuid.generate(configuredIds.lock),
    );
    const thermostat = harness.registered.find(
      (accessory) =>
        accessory.UUID === hap.uuid.generate(configuredIds.thermostat),
    );
    const washer = harness.registered.find(
      (accessory) =>
        accessory.UUID === hap.uuid.generate(configuredIds.washerLeak),
    );
    const kitchen = harness.registered.find(
      (accessory) =>
        accessory.UUID === hap.uuid.generate(configuredIds.kitchenLeak),
    );
    expect(
      lock?.getServiceById(hap.Service.LockMechanism, configuredIds.lock),
    ).toBeDefined();
    expect(
      thermostat?.getServiceById(
        hap.Service.Thermostat,
        configuredIds.thermostat,
      ),
    ).toBeDefined();
    expect(
      washer?.getServiceById(hap.Service.LeakSensor, configuredIds.washerLeak),
    ).toBeDefined();
    expect(
      kitchen?.getServiceById(
        hap.Service.LeakSensor,
        configuredIds.kitchenLeak,
      ),
    ).toBeDefined();

    harness.fire('shutdown');
  });

  it('restores cached accessory identity and display name without re-registering it', async () => {
    const harness = homebridgeHarness();
    const transport = new FakeTransport();
    const uuid = hap.uuid.generate(configuredIds.washerLeak.toString());
    const cached = new HomebridgePlatformAccessory('Laundry leak', uuid);
    cached.context.smartRentNext = {
      schemaVersion: 1,
      deviceId: configuredIds.washerLeak,
      role: 'washerLeak',
      alias: 'Laundry leak',
    };
    const platform = new SmartRentPlatform(
      harness.log,
      { platform: PLATFORM_NAME, devices: configuredIds },
      harness.api,
      () => transport,
    );
    platform.configureAccessory(cached);
    harness.fire('didFinishLaunching');
    await waitUntil(() => transport.reads.length === 4);

    expect(cached.UUID).toBe(uuid);
    expect(cached.displayName).toBe('Laundry leak');
    expect(
      cached.getServiceById(hap.Service.LeakSensor, configuredIds.washerLeak),
    ).toBeDefined();
    const registered = harness.registered.find(
      (accessory) => accessory.UUID === uuid,
    );
    expect(registered).toBeUndefined();
    expect(transport.devices.length).toBe(4);
    harness.fire('shutdown');
  });

  it('skips duplicate configured device IDs to avoid duplicate HomeKit accessories', async () => {
    const harness = homebridgeHarness();
    const transport = new FakeTransport();
    const config: SmartRentPlatformConfig = {
      platform: PLATFORM_NAME,
      devices: { lock: configuredIds.lock, washerLeak: configuredIds.lock },
    };
    new SmartRentPlatform(harness.log, config, harness.api, () => transport);
    harness.fire('didFinishLaunching');
    await waitUntil(
      () => harness.registered.length === 1 && transport.reads.length === 1,
    );
    expect(harness.registered).toHaveLength(1);
    harness.fire('shutdown');
  });
});
