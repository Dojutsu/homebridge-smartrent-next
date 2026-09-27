import type { SmartRentDevice } from '../transport/types.js';
import type {
  ReadOnlyAccountValidationConfig,
  ValidationAlias,
} from './config.js';

const KNOWN_DEVICE_TYPES = new Set([
  'entry_control',
  'sensor_notification',
  'switch_binary',
  'thermostat',
  'switch_multilevel',
]);

const EXPECTED_TYPES: Record<ValidationAlias, string> = {
  'front-door': 'entry_control',
  thermostat: 'thermostat',
  'washer-leak': 'sensor_notification',
  'kitchen-leak': 'sensor_notification',
};

export interface MappedValidationDevice {
  alias: ValidationAlias;
  device: SmartRentDevice;
}

export class DeviceMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceMappingError';
  }
}

/** Matches by configured stable ID, then verifies the code-only device type. */
export function mapValidationDevices(
  firstInventory: readonly SmartRentDevice[],
  secondInventory: readonly SmartRentDevice[],
  config: ReadOnlyAccountValidationConfig,
): MappedValidationDevice[] {
  assertInventoryStable(firstInventory, secondInventory);
  for (const device of firstInventory) {
    if (!KNOWN_DEVICE_TYPES.has(device.type)) {
      const type = safeType(device.type);
      throw new DeviceMappingError(
        `Unsupported SmartRent device type encountered (${type}); stopped before state reads`,
      );
    }
  }

  const matches: MappedValidationDevice[] = [];
  const usedIds = new Set<string>();
  for (const [alias, deviceId] of Object.entries(config.deviceIds) as Array<
    [ValidationAlias, string]
  >) {
    const candidates = firstInventory.filter(
      (device) => device.id === deviceId,
    );
    if (candidates.length !== 1) {
      throw new DeviceMappingError(
        `Configured ${alias} ID did not resolve to exactly one discovered device`,
      );
    }
    const device = candidates[0]!;
    const expectedType = EXPECTED_TYPES[alias];
    if (device.type !== expectedType) {
      throw new DeviceMappingError(
        `Configured ${alias} resolved to type ${safeType(device.type)}; expected ${expectedType}`,
      );
    }
    if (usedIds.has(device.id)) {
      throw new DeviceMappingError(
        'Configured roles resolve to a duplicate SmartRent device ID',
      );
    }
    usedIds.add(device.id);
    matches.push({ alias, device });
  }
  return matches;
}

export function isNumericDeviceId(deviceId: string): boolean {
  return /^\d+$/.test(deviceId);
}

function assertInventoryStable(
  first: readonly SmartRentDevice[],
  second: readonly SmartRentDevice[],
): void {
  const signature = (device: SmartRentDevice) =>
    JSON.stringify([device.type, device.hubId]);
  const firstById = new Map(
    first.map((device) => [device.id, signature(device)]),
  );
  const secondById = new Map(
    second.map((device) => [device.id, signature(device)]),
  );
  if (
    firstById.size !== first.length ||
    secondById.size !== second.length ||
    firstById.size !== secondById.size
  ) {
    throw new DeviceMappingError(
      'Repeated discovery returned ambiguous or changing device IDs; stopped before state reads',
    );
  }
  for (const [id, type] of firstById) {
    if (secondById.get(id) !== type) {
      throw new DeviceMappingError(
        'Repeated discovery returned changing device IDs, types, or hubs; stopped before state reads',
      );
    }
  }
}

function safeType(value: string): string {
  return /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : '[redacted-type]';
}
