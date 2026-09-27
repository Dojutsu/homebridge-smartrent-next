import type { SmartRentDevice } from '../transport/types.js';

const SAFE_DEVICE_TYPES = new Set([
  'entry_control',
  'thermostat',
  'sensor_notification',
  'switch_binary',
  'switch_multilevel',
]);

const SAFE_DISPLAY_WORDS = new Set([
  'bathroom',
  'basement',
  'bedroom',
  'climate',
  'cool',
  'dishwasher',
  'door',
  'downstairs',
  'entry',
  'front',
  'garage',
  'guest',
  'hall',
  'heat',
  'hvac',
  'kitchen',
  'laundry',
  'leak',
  'living',
  'lock',
  'main',
  'office',
  'pantry',
  'primary',
  'room',
  'secondary',
  'sensor',
  'sink',
  'thermostat',
  'upstairs',
  'utility',
  'washer',
  'water',
]);

const SAFE_ATTRIBUTES = new Set([
  'battery_level',
  'battery_powered',
  'cooling_setpoint',
  'current_humidity',
  'current_temp',
  'error',
  'fan_mode',
  'fault',
  'heating_setpoint',
  'jam',
  'jammed',
  'leak',
  'locked',
  'mode',
  'operating_state',
  'warning',
  'warnings',
]);

const SAFE_MANUFACTURERS = new Map([
  ['ecobee', 'ecobee'],
  ['honeywell', 'Honeywell'],
  ['kwikset', 'Kwikset'],
  ['resideo', 'Resideo'],
  ['schlage', 'Schlage'],
  ['smartrent', 'SmartRent'],
  ['yale', 'Yale'],
  ['z-wave', 'Z-Wave'],
  ['zwave', 'Z-Wave'],
]);

export function formatSanitizedDiscoveryInventory(
  devices: readonly SmartRentDevice[],
): string[] {
  const lines = [
    `Sanitized inventory: ${devices.length} device candidate(s)`,
    'Candidate numbers are temporary list positions; they do not assign household roles.',
  ];

  devices.forEach((device, index) => {
    const attributes = safeAttributeNames(device);
    const category = classifyCandidate(device, attributes);
    const manufacturer = sanitizeManufacturer(device.manufacturer);
    const name = sanitizeGenericDisplayName(device.name);
    const online = device.online === null ? 'unknown' : String(device.online);
    const batteryPowered =
      device.batteryPowered === null || device.batteryPowered === undefined
        ? 'unknown'
        : device.batteryPowered
          ? 'yes'
          : 'no';
    const capabilitySummary = summarizeCapabilities(category, attributes);

    lines.push(
      `Candidate ${index + 1}`,
      `  display name: ${name ?? 'withheld (not a generic device label)'}`,
      `  category: ${category}`,
      `  device type: ${SAFE_DEVICE_TYPES.has(device.type) ? device.type : 'unrecognized (value withheld)'}`,
      `  manufacturer: ${manufacturer ?? (device.manufacturer ? 'present; value withheld' : 'not provided')}`,
      `  model: ${device.model ? 'present; value withheld' : 'not provided'}`,
      `  online: ${online}`,
      `  battery-powered: ${batteryPowered}`,
      `  supported attribute names: ${attributes.length > 0 ? attributes.join(', ') : 'none recognized'}`,
      `  capabilities: ${capabilitySummary}`,
    );
  });

  return lines;
}

function safeAttributeNames(device: SmartRentDevice): string[] {
  const names = new Set([
    ...Object.keys(device.attributes),
    ...(device.fieldPresence ?? []),
  ]);
  return [...names]
    .map((name) => name.toLowerCase())
    .filter((name) => SAFE_ATTRIBUTES.has(name))
    .sort();
}

function classifyCandidate(
  device: SmartRentDevice,
  attributes: readonly string[],
): string {
  if (device.type === 'entry_control') return 'LOCK CANDIDATE';
  if (device.type === 'thermostat') return 'THERMOSTAT CANDIDATE';
  if (device.type === 'sensor_notification' && attributes.includes('leak')) {
    return 'LEAK SENSOR CANDIDATE';
  }
  if (device.type === 'sensor_notification') return 'SENSOR CANDIDATE';
  return 'UNCLASSIFIED CANDIDATE';
}

function summarizeCapabilities(
  category: string,
  attributes: readonly string[],
): string {
  const capabilities: string[] = [];
  if (category === 'LOCK CANDIDATE' && attributes.includes('locked')) {
    capabilities.push('lock state reporting');
  }
  if (category === 'THERMOSTAT CANDIDATE') {
    if (attributes.includes('mode')) capabilities.push('HVAC mode');
    if (attributes.includes('current_temp')) {
      capabilities.push('current temperature');
    }
    if (
      attributes.includes('heating_setpoint') ||
      attributes.includes('cooling_setpoint')
    ) {
      capabilities.push('heat/cool setpoint fields');
    }
  }
  if (category === 'LEAK SENSOR CANDIDATE') {
    capabilities.push('leak state reporting');
  }
  if (
    attributes.includes('battery_level') ||
    attributes.includes('battery_powered')
  ) {
    capabilities.push('battery metadata present');
  }
  if (
    attributes.some((name) =>
      ['error', 'fault', 'jam', 'jammed', 'warning', 'warnings'].includes(name),
    )
  ) {
    capabilities.push('fault/warning fields present');
  }
  return capabilities.length > 0
    ? capabilities.join('; ')
    : 'no recognized attributes';
}

function sanitizeGenericDisplayName(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 64 ||
    !/^[a-z /&-]+$/.test(normalized)
  ) {
    return undefined;
  }
  const words = normalized.split(/[ /&-]+/).filter(Boolean);
  if (
    words.length === 0 ||
    !words.every((word) => SAFE_DISPLAY_WORDS.has(word))
  ) {
    return undefined;
  }
  return words.join(' ');
}

function sanitizeManufacturer(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return SAFE_MANUFACTURERS.get(value.trim().toLowerCase());
}
