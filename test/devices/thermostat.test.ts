import * as hap from 'hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it } from 'vitest';
import { RedactedDiagnosticLogger } from '../../src/diagnostics/redacted-logger.js';
import { ThermostatAccessory } from '../../src/devices/thermostat.js';
import { StateReducer } from '../../src/state/model.js';
import type {
  DeviceAttribute,
  SmartRentDevice,
  SmartRentTransport,
} from '../../src/transport/types.js';

const thermostatId = 'synthetic-thermostat';

const attributes = {
  mode: 'cool',
  operating_state: 'cooling',
  current_temp: '68',
  current_humidity: '51',
  heating_setpoint: '69',
  cooling_setpoint: '70',
};

class FakeTransport implements SmartRentTransport {
  getCount = 0;
  writes: DeviceAttribute[][] = [];
  responseAttributes: Record<string, unknown> = { ...attributes };
  failRead = false;
  readGate: Promise<void> | undefined;

  async authenticate(): Promise<void> {}
  async completeTotp(): Promise<void> {}
  async refreshOrReauthenticate(): Promise<void> {}
  async discoverDevices(): Promise<SmartRentDevice[]> {
    return [];
  }
  async getDeviceState(deviceId: string): Promise<SmartRentDevice> {
    this.getCount += 1;
    if (this.failRead) throw new Error('synthetic REST failure');
    await this.readGate;
    return {
      id: deviceId,
      hubId: 'synthetic-hub',
      name: 'Synthetic Thermostat',
      type: 'thermostat',
      online: true,
      attributes: { ...this.responseAttributes },
      updatedAt: '2026-09-01T00:00:03.000Z',
    };
  }
  async setDeviceAttributes(
    _deviceId: string,
    newAttributes: DeviceAttribute[],
  ): Promise<{ accepted: true }> {
    this.writes.push(newAttributes);
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

function setup(
  overrides: Record<string, unknown> = {},
  options: {
    temperatureUnit?: 'celsius' | 'fahrenheit';
    includeMode?: boolean;
  } = {},
) {
  const reducer = new StateReducer();
  reducer.registerDevice(thermostatId);
  const initial = { ...attributes, ...overrides };
  if (options.includeMode === false) delete initial.mode;
  const fence = reducer.captureRestFence(thermostatId);
  reducer.applyRestSnapshot(
    thermostatId,
    fence,
    { online: true, attributes: initial },
    1_000,
  );
  const transport = new FakeTransport();
  const service = new hap.Service.Thermostat('Thermostat', thermostatId);
  const accessory = {
    context: {},
    getServiceById: () => service,
    addService: () => service,
  } as unknown as PlatformAccessory;
  const diagnostics = new RedactedDiagnosticLogger({
    info: () => undefined,
    warn: () => undefined,
  } as never);
  const thermostat = new ThermostatAccessory({
    alias: 'Thermostat',
    deviceId: thermostatId,
    reducer,
    transport,
    diagnostics,
    api: hap,
    accessory,
    logger: { warn: () => undefined } as never,
    ...(options.temperatureUnit
      ? { temperatureUnit: options.temperatureUnit }
      : {}),
  });
  return { reducer, transport, service, thermostat };
}

describe('ThermostatAccessory', () => {
  it('serves cached reported state immediately without REST reads or fallback values', async () => {
    const { transport, service } = setup();
    await expect(
      service
        .getCharacteristic(hap.Characteristic.CurrentTemperature)
        .handleGetRequest(),
    ).resolves.toBe(20);
    await expect(
      service
        .getCharacteristic(hap.Characteristic.CurrentRelativeHumidity)
        .handleGetRequest(),
    ).resolves.toBe(51);
    await expect(
      service
        .getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
        .handleGetRequest(),
    ).resolves.toBe(hap.Characteristic.CurrentHeatingCoolingState.COOL);
    await expect(
      service
        .getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
        .handleGetRequest(),
    ).resolves.toBe(hap.Characteristic.TargetHeatingCoolingState.COOL);
    await expect(
      service
        .getCharacteristic(hap.Characteristic.TargetTemperature)
        .handleGetRequest(),
    ).resolves.toBe(21.1);
    expect(transport.getCount).toBe(0);
  });

  it('writes a target setpoint to the reported cool mode field without a preliminary GET', async () => {
    const { reducer, transport, service } = setup();
    await service
      .getCharacteristic(hap.Characteristic.TargetTemperature)
      .handleSetRequest(20);
    expect(transport.getCount).toBe(0);
    expect(transport.writes).toEqual([
      [{ name: 'cooling_setpoint', state: '68' }],
    ]);
    expect(
      reducer.getDevice(thermostatId).requested.cooling_setpoint?.status,
    ).toBe('accepted');
    await expect(
      service
        .getCharacteristic(hap.Characteristic.TargetTemperature)
        .handleGetRequest(),
    ).resolves.toBe(21.1);
  });

  it('uses the cached heat mode and keeps a mode request separate from reported mode', async () => {
    const { reducer, transport, service } = setup({
      mode: 'heat',
      operating_state: 'idle',
    });
    await service
      .getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
      .handleSetRequest(hap.Characteristic.TargetHeatingCoolingState.OFF);
    expect(transport.writes).toEqual([[{ name: 'mode', state: 'off' }]]);
    expect(reducer.getDevice(thermostatId).requested.mode?.status).toBe(
      'accepted',
    );
    await expect(
      service
        .getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
        .handleGetRequest(),
    ).resolves.toBe(hap.Characteristic.TargetHeatingCoolingState.HEAT);
    expect(transport.getCount).toBe(0);
  });

  it('performs one bounded state read when cached mode is unknown', async () => {
    const { transport, service } = setup({}, { includeMode: false });
    await service
      .getCharacteristic(hap.Characteristic.TargetTemperature)
      .handleSetRequest(20);
    expect(transport.getCount).toBe(1);
    expect(transport.writes).toEqual([
      [{ name: 'cooling_setpoint', state: '68' }],
    ]);
  });

  it('does not write when the required mode read fails', async () => {
    const { reducer, transport, service } = setup({}, { includeMode: false });
    transport.failRead = true;
    await expect(
      service
        .getCharacteristic(hap.Characteristic.TargetTemperature)
        .handleSetRequest(20),
    ).rejects.toBe(-70402);
    expect(transport.getCount).toBe(1);
    expect(transport.writes).toHaveLength(0);
    expect(reducer.getDevice(thermostatId).fault).toBe('unavailable');
  });

  it('uses a newer WebSocket mode instead of a delayed pre-command REST response', async () => {
    const { reducer, transport, service } = setup({}, { includeMode: false });
    let releaseRead!: () => void;
    transport.readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    transport.responseAttributes = { ...attributes, mode: 'cool' };
    const set = service
      .getCharacteristic(hap.Characteristic.TargetTemperature)
      .handleSetRequest(20);
    await viTick();
    reducer.applyEvent(
      thermostatId,
      'mode',
      'heat',
      0,
      2_000,
      'new-mode-event',
    );
    releaseRead();
    await set;
    expect(transport.getCount).toBe(1);
    expect(transport.writes).toEqual([
      [{ name: 'heating_setpoint', state: '68' }],
    ]);
  });

  it('keeps missing current temperature and humidity unknown', async () => {
    const { service } = setup({ current_temp: null, current_humidity: 'bad' });
    await expect(
      service
        .getCharacteristic(hap.Characteristic.CurrentTemperature)
        .handleGetRequest(),
    ).rejects.toBe(-70402);
    await expect(
      service
        .getCharacteristic(hap.Characteristic.CurrentRelativeHumidity)
        .handleGetRequest(),
    ).rejects.toBe(-70402);
  });

  it('maps explicit threshold writes to distinct heating and cooling attributes', async () => {
    const { transport, service } = setup();
    await service
      .getCharacteristic(hap.Characteristic.HeatingThresholdTemperature)
      .handleSetRequest(19);
    await service
      .getCharacteristic(hap.Characteristic.CoolingThresholdTemperature)
      .handleSetRequest(23);
    expect(transport.getCount).toBe(0);
    expect(transport.writes).toEqual([
      [{ name: 'heating_setpoint', state: '66' }],
      [{ name: 'cooling_setpoint', state: '73' }],
    ]);
  });

  it('honors the HomeKit Fahrenheit display unit', async () => {
    const { transport, service } = setup({}, { temperatureUnit: 'fahrenheit' });
    await expect(
      service
        .getCharacteristic(hap.Characteristic.CurrentTemperature)
        .handleGetRequest(),
    ).resolves.toBe(68);
    await service
      .getCharacteristic(hap.Characteristic.TargetTemperature)
      .handleSetRequest(72);
    expect(transport.writes).toEqual([
      [{ name: 'cooling_setpoint', state: '72' }],
    ]);
  });

  it('rejects out-of-range targets instead of clamping or inventing a value', async () => {
    const { transport, service } = setup();
    await expect(
      service
        .getCharacteristic(hap.Characteristic.TargetTemperature)
        .handleSetRequest(40),
    ).rejects.toBe(-70402);
    expect(transport.writes).toHaveLength(0);
  });
});

async function viTick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
