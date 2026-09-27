import * as hap from 'hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it } from 'vitest';
import { RedactedDiagnosticLogger } from '../../src/diagnostics/redacted-logger.js';
import {
  LeakSensorAccessory,
  normalizeLeakReport,
} from '../../src/devices/leak-sensor.js';
import { StateReducer } from '../../src/state/model.js';

function setup(value?: unknown) {
  const reducer = new StateReducer();
  reducer.registerDevice('synthetic-leak-sensor');
  if (value !== undefined) {
    const fence = reducer.captureRestFence('synthetic-leak-sensor');
    reducer.applyRestSnapshot(
      'synthetic-leak-sensor',
      fence,
      {
        online: true,
        attributes: { leak: value },
      },
      1_000,
    );
  }
  const service = new hap.Service.LeakSensor(
    'Synthetic leak sensor',
    'synthetic-leak-sensor',
  );
  const accessory = {
    getServiceById: () => service,
    addService: () => service,
  } as unknown as PlatformAccessory;
  const diagnostics = new RedactedDiagnosticLogger({
    info: () => undefined,
    warn: () => undefined,
  } as never);
  const sensor = new LeakSensorAccessory({
    alias: 'Synthetic leak sensor',
    deviceId: 'synthetic-leak-sensor',
    reducer,
    diagnostics,
    api: hap,
    accessory,
    logger: { warn: () => undefined } as never,
  });
  return { reducer, service, sensor };
}

describe('LeakSensorAccessory', () => {
  it.each([
    [true, 'leak'],
    ['true', 'leak'],
    [false, 'dry'],
    ['false', 'dry'],
    [null, 'unknown'],
    ['unknown', 'unknown'],
  ])('normalizes %s to %s', (value, expected) => {
    expect(normalizeLeakReport(value)).toBe(expected);
  });

  it('reports only an explicit dry or leak value', async () => {
    const dry = setup(false);
    await expect(
      dry.service
        .getCharacteristic(hap.Characteristic.LeakDetected)
        .handleGetRequest(),
    ).resolves.toBe(hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED);

    const leak = setup(true);
    await expect(
      leak.service
        .getCharacteristic(hap.Characteristic.LeakDetected)
        .handleGetRequest(),
    ).resolves.toBe(hap.Characteristic.LeakDetected.LEAK_DETECTED);
  });

  it('fails HomeKit reads instead of returning dry when state is missing or malformed', async () => {
    for (const value of [undefined, null, 'not-a-state']) {
      const setupResult = setup(value);
      const characteristic = setupResult.service.getCharacteristic(
        hap.Characteristic.LeakDetected,
      );
      await expect(characteristic.handleGetRequest()).rejects.toBe(-70402);
    }
  });

  it('retains but marks the last explicit value faulted after offline state', async () => {
    const { reducer, service, sensor } = setup(false);
    const characteristic = service.getCharacteristic(
      hap.Characteristic.LeakDetected,
    );
    reducer.setConnection(false, 0);
    sensor.refreshFromState();
    expect(characteristic.value).toBe(
      hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED,
    );
    expect(
      service.getCharacteristic(hap.Characteristic.StatusFault).value,
    ).toBe(hap.Characteristic.StatusFault.GENERAL_FAULT);
    await expect(characteristic.handleGetRequest()).rejects.toBe(-70402);
  });
});
