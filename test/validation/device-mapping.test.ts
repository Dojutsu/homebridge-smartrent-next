import { describe, expect, it } from 'vitest';
import type { SmartRentDevice } from '../../src/transport/types.js';
import type { AccountValidationConfig } from '../../src/validation/config.js';
import {
  DeviceMappingError,
  mapValidationDevices,
} from '../../src/validation/device-mapping.js';

const config: AccountValidationConfig = {
  deviceIds: {
    'front-door': '101',
    thermostat: '102',
    'washer-leak': '103',
    'kitchen-leak': '104',
  },
  observeSeconds: 1,
};

const inventory: SmartRentDevice[] = [
  device('101', 'entry_control', 'A configured display name'),
  device('102', 'thermostat', 'Another display name'),
  device('103', 'sensor_notification', 'Washer'),
  device('104', 'sensor_notification', 'Kitchen'),
];

describe('explicit account device mapping', () => {
  it('maps supported roles by configured ID and exact device type', () => {
    expect(
      mapValidationDevices(inventory, structuredClone(inventory), config).map(
        ({ alias }) => alias,
      ),
    ).toEqual(['front-door', 'thermostat', 'washer-leak', 'kitchen-leak']);
  });

  it('does not use display names to map device identity', () => {
    const renamed = inventory.map((item) => ({ ...item, name: 'Renamed' }));
    expect(
      mapValidationDevices(renamed, structuredClone(renamed), config),
    ).toHaveLength(4);
  });

  it('stops on an unknown device type without printing the device ID', () => {
    const devices = [
      ...inventory,
      device('private-device-id', 'unexpected_private_type', 'Private name'),
    ];
    expect(() => mapValidationDevices(devices, devices, config)).toThrow(
      'Unsupported SmartRent device type encountered (unexpected_private_type)',
    );
    try {
      mapValidationDevices(devices, devices, config);
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceMappingError);
      expect((error as Error).message).not.toContain('private-device-id');
      expect((error as Error).message).not.toContain('Private name');
    }
  });

  it('stops when IDs or device types are ambiguous or change between inventories', () => {
    expect(() =>
      mapValidationDevices(inventory, inventory.slice(1), config),
    ).toThrow('ambiguous or changing device IDs');
    expect(() =>
      mapValidationDevices(
        inventory,
        inventory.map((item) =>
          item.id === '101' ? { ...item, type: 'thermostat' } : item,
        ),
        config,
      ),
    ).toThrow('changing device IDs, types, or hubs');
    expect(() =>
      mapValidationDevices(
        inventory,
        inventory.map((item) =>
          item.id === '101' ? { ...item, hubId: 'different-hub' } : item,
        ),
        config,
      ),
    ).toThrow('changing device IDs, types, or hubs');
    expect(() =>
      mapValidationDevices(inventory, inventory, {
        ...config,
        deviceIds: { ...config.deviceIds, 'kitchen-leak': '101' },
      }),
    ).toThrow('Configured kitchen-leak resolved to type');
  });
});

function device(id: string, type: string, name: string): SmartRentDevice {
  return {
    id,
    hubId: 'synthetic-hub',
    type,
    name,
    online: true,
    attributes: {},
  };
}
