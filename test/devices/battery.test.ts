import * as hap from 'hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it } from 'vitest';
import {
  BatteryModel,
  BatteryServiceAdapter,
} from '../../src/devices/battery.js';

function makeBattery(model: BatteryModel) {
  const service = new hap.Service.Battery('Battery');
  let created = false;
  const accessory = {
    getServiceById: () => (created ? service : undefined),
    addService: () => {
      created = true;
      return service;
    },
  } as unknown as PlatformAccessory;
  const adapter = new BatteryServiceAdapter({ accessory, api: hap, model });
  return { adapter, service, hasService: () => created };
}

describe('BatteryModel', () => {
  it.each([
    [0, 0],
    [100, 100],
    ['42', 42],
  ])('accepts an explicit battery percentage %s', (input, expected) => {
    const model = new BatteryModel();
    expect(model.observe(input, 'rest', 1_000)).toMatchObject({
      percentage: expected,
      observedAt: 1_000,
      source: 'rest',
      freshness: 'fresh',
    });
  });

  it.each([undefined, null, -1, 101, 3.5, 'unknown'])(
    'does not fabricate a percentage from %s',
    (value) => {
      const model = new BatteryModel();
      const snapshot = model.observe(value, 'rest', 1_000);
      expect(snapshot.percentage).toBeUndefined();
      expect(snapshot.freshness).toBe('unknown');
      expect(model.isLow()).toBeUndefined();
    },
  );

  it('does not create a HomeKit Battery service before a valid reading', () => {
    const model = new BatteryModel();
    model.markUnavailable();
    const battery = makeBattery(model);
    battery.adapter.refresh();
    expect(battery.hasService()).toBe(false);
  });

  it('creates the service after a valid report and marks retained stale data faulted', async () => {
    const model = new BatteryModel(20);
    const battery = makeBattery(model);
    model.observe(55, 'websocket', 1_000);
    battery.adapter.refresh();
    expect(battery.hasService()).toBe(true);
    const level = battery.service.getCharacteristic(
      hap.Characteristic.BatteryLevel,
    );
    const low = battery.service.getCharacteristic(
      hap.Characteristic.StatusLowBattery,
    );
    await expect(level.handleGetRequest()).resolves.toBe(55);
    await expect(low.handleGetRequest()).resolves.toBe(
      hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );

    model.markUnavailable();
    battery.adapter.refresh();
    expect(level.value).toBe(55);
    await expect(level.handleGetRequest()).rejects.toBe(-70402);

    model.observe(17, 'rest', 2_000);
    battery.adapter.refresh();
    await expect(level.handleGetRequest()).resolves.toBe(17);
    expect(
      battery.service.getCharacteristic(hap.Characteristic.StatusFault).value,
    ).toBe(hap.Characteristic.StatusFault.NO_FAULT);
  });

  it('uses a defined low-battery threshold without assuming an unknown value', () => {
    const model = new BatteryModel(20);
    expect(model.isLow()).toBeUndefined();
    expect(model.observe(20, 'rest', 1).percentage).toBe(20);
    expect(model.isLow()).toBe(true);
    model.observe(21, 'rest', 2);
    expect(model.isLow()).toBe(false);
  });

  it('rejects invalid thresholds', () => {
    expect(() => new BatteryModel(-1)).toThrow(RangeError);
    expect(() => new BatteryModel(101)).toThrow(RangeError);
  });
});
