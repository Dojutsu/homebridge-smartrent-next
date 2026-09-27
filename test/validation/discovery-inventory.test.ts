import { describe, expect, it } from 'vitest';
import type { SmartRentDevice } from '../../src/transport/types.js';
import { formatSanitizedDiscoveryInventory } from '../../src/validation/discovery-inventory.js';

describe('sanitized discovery inventory', () => {
  it('prints useful candidate capabilities without IDs, private labels, or state values', () => {
    const inventory = [
      device('8614201', 'Front Door Lock', 'entry_control', {
        locked: true,
        battery_level: 37,
        jammed: false,
      }),
      {
        ...device('8614202', 'Thermostat', 'thermostat', {
          mode: 'cool',
          current_temp: 72,
          cooling_setpoint: 74,
        }),
        manufacturer: 'Honeywell',
        model: 'T1000-123456',
      },
      device('8614203', 'Washer Leak Sensor', 'sensor_notification', {
        leak: false,
        battery_level: 64,
      }),
      device(
        '8614204',
        'Kitchen Sink/Dishwasher Leak Sensor',
        'sensor_notification',
        { leak: false },
      ),
      {
        ...device(
          '8614205',
          'Alex Doe 123 Main Street',
          'private_custom_type',
          { private_attribute: 'private-state-sentinel' },
        ),
        hubId: '734225',
        manufacturer: 'resident-private-value',
        model: 'serial-private-value',
      },
    ];

    const report = formatSanitizedDiscoveryInventory(inventory).join('\n');
    expect(report).toContain('Candidate 1');
    expect(report).toContain('display name: front door lock');
    expect(report).toContain('category: LOCK CANDIDATE');
    expect(report).toContain(
      'supported attribute names: battery_level, jammed, locked',
    );
    expect(report).toContain('category: THERMOSTAT CANDIDATE');
    expect(report).toContain('manufacturer: Honeywell');
    expect(report).toContain('model: present; value withheld');
    expect(report).toContain('display name: washer leak sensor');
    expect(report).toContain('category: LEAK SENSOR CANDIDATE');
    expect(report).toContain(
      'display name: kitchen sink dishwasher leak sensor',
    );
    expect(report).toContain('category: UNCLASSIFIED CANDIDATE');
    expect(report).toContain('device type: unrecognized (value withheld)');
    expect(report).toContain(
      'display name: withheld (not a generic device label)',
    );
    expect(report).toContain('battery-powered: unknown');

    for (const privateValue of [
      '8614201',
      '8614202',
      '8614203',
      '8614204',
      '8614205',
      '734225',
      'Alex Doe',
      '123 Main Street',
      'private_attribute',
      'private-state-sentinel',
      'private_custom_type',
      'serial-private-value',
      'T1000-123456',
      'resident-private-value',
      'locked: true',
      'leak: false',
    ]) {
      expect(report).not.toContain(privateValue);
    }
  });

  it('does not call a generic sensor a leak candidate without a leak attribute', () => {
    const [line] = formatSanitizedDiscoveryInventory([
      device('private-sensor-id', 'Water Sensor', 'sensor_notification', {
        battery_level: 90,
      }),
    ]).filter((entry) => entry.startsWith('  category:'));

    expect(line).toBe('  category: SENSOR CANDIDATE');
  });
});

function device(
  id: string,
  name: string,
  type: string,
  attributes: Record<string, unknown>,
): SmartRentDevice {
  return {
    id,
    hubId: '734225',
    name,
    type,
    online: true,
    attributes,
  };
}
