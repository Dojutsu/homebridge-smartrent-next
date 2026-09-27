import { StateReducer } from '../state/model.js';
import {
  SmartRentProtocolTransport,
  type SmartRentProtocolObservation,
  type SmartRentProtocolOptions,
} from '../transport/smartrent-transport.js';
import type {
  ConnectionChange,
  DeviceEvent,
  SmartRentDevice,
} from '../transport/types.js';
import {
  createEnvironmentCredentialsProvider,
  loadAccountValidationConfig,
} from './config.js';
import { formatSanitizedDiscoveryInventory } from './discovery-inventory.js';
import type { ValidationAlias } from './config.js';
import { isNumericDeviceId, mapValidationDevices } from './device-mapping.js';

const SAFE_ENUMS = new Set([
  'TRUE',
  'FALSE',
  'LOCKED',
  'UNLOCKED',
  'SECURED',
  'UNSECURED',
  'JAMMED',
  'OPEN',
  'CLOSED',
  'LEAK',
  'DRY',
  'WET',
  'DETECTED',
  'CLEAR',
  'HEAT',
  'COOL',
  'AUTO',
  'OFF',
  'AUX_HEAT',
  'HEATING',
  'COOLING',
  'IDLE',
  'FAN_ONLY',
  'ON',
]);
const WARNING_FIELDS = [
  'jammed',
  'jam',
  'warning',
  'warnings',
  'fault',
  'error',
];
const SAFE_ATTRIBUTE_NAMES = new Set([
  'locked',
  'leak',
  'mode',
  'operating_state',
  'current_temp',
  'current_humidity',
  'heating_setpoint',
  'cooling_setpoint',
  'fan_mode',
  'battery_level',
  'battery_powered',
  'jammed',
  'jam',
  'warning',
  'warnings',
  'fault',
  'error',
]);

export interface AccountValidationOptions {
  environment?: NodeJS.ProcessEnv;
  output?: (line: string) => void;
  transportFactory?: (
    options: SmartRentProtocolOptions,
  ) => SmartRentProtocolTransport;
}

interface CapturedEvent {
  deviceId: string;
  alias: ValidationAlias;
  attribute: string;
  value: unknown;
  timestamp?: string;
  eventIdPresent: boolean;
  epoch: number;
  receivedAt: number;
}

interface SafeState {
  label: string;
  representation: string;
  malformed: boolean;
}

/** Read-only, non-HomeKit account validation. No response object is logged. */
export async function runAccountValidation(
  options: AccountValidationOptions = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const output =
    options.output ?? ((line: string) => process.stdout.write(`${line}\n`));
  const config = loadAccountValidationConfig(environment);
  const protocolEvents: SmartRentProtocolObservation[] = [];
  let protocolWarningCount = 0;
  const transportOptions: SmartRentProtocolOptions = {
    credentials: createEnvironmentCredentialsProvider(environment),
    mode: config.mode,
    observeProtocol: (event) => protocolEvents.push(event),
    warn: () => {
      protocolWarningCount += 1;
    },
  };
  const makeTransport =
    options.transportFactory ??
    ((settings) => new SmartRentProtocolTransport(settings));
  const transport = makeTransport(transportOptions);

  if (config.mode === 'DISCOVERY_ONLY') {
    let disconnected = false;
    try {
      output('DISCOVERY_ONLY mode: centralized transport write guard enabled');
      output('HomeKit: not imported or advertised');
      await transport.authenticate();
      output('Authentication: succeeded; credentials and tokens suppressed');
      const totpRequired = protocolEvents.some(
        (event) => event.kind === 'totp' && event.phase === 'required',
      );
      const totpCompleted = protocolEvents.some(
        (event) => event.kind === 'totp' && event.phase === 'completed',
      );
      output(
        `Authentication: TOTP ${totpRequired ? (totpCompleted ? 'required and completed in memory' : 'required but incomplete') : 'not requested'}`,
      );
      const devices = await transport.discoverDevices();
      for (const line of formatSanitizedDiscoveryInventory(devices)) {
        output(line);
      }
      await transport.disconnect();
      disconnected = true;
      output('Disconnect: validator transport closed; no WebSocket was opened');
      output(
        'Discovery stopped: device-state reads=0; WebSocket connections=0; device writes=0',
      );
    } finally {
      if (!disconnected) await transport.disconnect();
    }
    return;
  }

  const reducer = new StateReducer();
  const connections: ConnectionChange[] = [];
  const events: CapturedEvent[] = [];
  const restSnapshots = new Map<string, SmartRentDevice>();
  const roleById = new Map<string, ValidationAlias>();
  let currentEpoch = 0;
  let unexpectedLockReport: string | undefined;
  let triggerSafetyStop: (() => void) | undefined;
  let expectedClientCloseObserved = false;
  let socketsConnected = 0;
  let joinedChannels = 0;
  let heartbeatAcks = 0;
  const unsubscribers = [
    transport.onConnectionChange((change) => {
      connections.push(change);
      if (change.connected) socketsConnected += 1;
      else if (change.epoch === currentEpoch) {
        if (expectedClientCloseObserved) expectedClientCloseObserved = false;
        reducer.setConnection(false, change.epoch);
      }
    }),
    transport.onDeviceEvent((event, epoch) => {
      handleDeviceEvent(event, epoch);
    }),
  ];

  function handleDeviceEvent(event: DeviceEvent, epoch: number): void {
    if (epoch !== currentEpoch) return;
    const alias = roleById.get(event.deviceId);
    if (!alias) return;
    reducer.applyEvent(
      event.deviceId,
      event.attribute,
      event.value,
      epoch,
      Date.now(),
      event.eventId,
      event.smartrentTimestamp,
    );
    const captured: CapturedEvent = {
      deviceId: event.deviceId,
      alias,
      attribute: safeAttributeName(event.attribute),
      value: event.value,
      ...(event.smartrentTimestamp
        ? { timestamp: safeTimestamp(event.smartrentTimestamp) }
        : {}),
      eventIdPresent: event.eventId !== undefined,
      epoch,
      receivedAt: Date.now(),
    };
    events.push(captured);
    if (alias === 'front-door' && event.attribute === 'locked') {
      const normalized = safeLockValue(event.value);
      if (normalized.malformed) {
        unexpectedLockReport = `front-door WebSocket locked field was ${normalized.representation}; CurrentLockState must remain UNKNOWN`;
        output(
          `front-door WebSocket locked: UNKNOWN; unexpected representation=${normalized.representation}; stopped without coercion`,
        );
        triggerSafetyStop?.();
      }
    }
  }

  try {
    output('READ_ONLY mode: enforced by SmartRentProtocolTransport');
    output('HomeKit: not imported or advertised');
    await transport.authenticate();
    output('Authentication: POST /authentication/sessions succeeded');

    const firstInventory = await transport.discoverDevices();
    const secondInventory = await transport.discoverDevices();
    const mapped = mapValidationDevices(
      firstInventory,
      secondInventory,
      config,
    );
    for (const item of mapped) {
      roleById.set(item.device.id, item.alias);
      reducer.registerDevice(item.device.id);
    }

    const unitsShape = protocolEvents.find(
      (event) => event.kind === 'units-envelope',
    );
    const deviceShape = protocolEvents.find(
      (event) => event.kind === 'device-list-envelope',
    );
    if (unitsShape?.kind === 'units-envelope') {
      output(
        `Discovery: /api/v3/units records=${unitsShape.recordsPath} count=${unitsShape.records}; valid hubs=${unitsShape.hubs}`,
      );
    }
    if (deviceShape?.kind === 'device-list-envelope') {
      output(
        `Device lists: records=${deviceShape.recordsPath}; discovery repeated twice with stable IDs/types/hubs`,
      );
      output(
        `Discovered inventory: devices=${firstInventory.length}; supported role mapping checked against explicit IDs and exact types`,
      );
    }
    output(
      `Configured role mapping: ${mapped.length}/4 by explicit device ID and exact type; display names are not used as identity`,
    );
    output(
      `Device IDs numeric: ${mapped.filter(({ device }) => isNumericDeviceId(device.id)).length}/4; values suppressed`,
    );

    const authEvents = protocolEvents;
    const totpRequired = authEvents.some(
      (event) => event.kind === 'totp' && event.phase === 'required',
    );
    const totpCompleted = authEvents.some(
      (event) => event.kind === 'totp' && event.phase === 'completed',
    );
    output(
      `Authentication: TOTP ${totpRequired ? (totpCompleted ? 'required and completed in memory' : 'required but not completed') : 'not requested'}`,
    );
    if (totpRequired && totpCompleted) {
      output('TOTP endpoint: POST /authentication/sessions/tfa succeeded');
    }
    const tokenMetadata = [...authEvents]
      .reverse()
      .find((event) => event.kind === 'access-token');
    if (tokenMetadata?.kind === 'access-token') {
      output(
        `Access token: format=${tokenMetadata.format}; expiry claim ${tokenMetadata.expiresInSeconds === undefined ? 'not available' : `approximately ${tokenMetadata.expiresInSeconds}s`}; token suppressed`,
      );
    }

    currentEpoch = await transport.connect();
    reducer.startConnectionEpoch(currentEpoch);
    reducer.setConnection(true, currentEpoch);
    output('WebSocket: connected; token query and URL suppressed');
    await joinAllChannels(mapped);
    await heartbeatBatch(3);
    await readAndApplySnapshots(mapped, 'initial');
    if (unexpectedLockReport) throw new Error(unexpectedLockReport);

    const firstUnitsShape = protocolEvents.find(
      (event) => event.kind === 'units-envelope',
    );
    const secondUnitsShape = [...protocolEvents]
      .reverse()
      .find((event) => event.kind === 'units-envelope');
    if (
      firstUnitsShape?.kind === 'units-envelope' &&
      secondUnitsShape?.kind === 'units-envelope' &&
      (firstUnitsShape.recordsPath !== secondUnitsShape.recordsPath ||
        firstUnitsShape.records !== secondUnitsShape.records ||
        firstUnitsShape.hubs !== secondUnitsShape.hubs)
    ) {
      throw new Error(
        'Repeated unit discovery changed response shape or counts',
      );
    }

    const waitForSafety = new Promise<void>((resolve) => {
      triggerSafetyStop = resolve;
    });
    await waitBoundedOrSafety(config.observeSeconds * 1000, waitForSafety);
    if (unexpectedLockReport) throw new Error(unexpectedLockReport);

    expectedClientCloseObserved = true;
    const authExchangesBeforeReconnect = protocolEvents.filter(
      (event) => event.kind === 'authentication',
    ).length;
    await transport.disconnect();
    const closeObserved = connections.some(
      (change) => !change.connected && change.epoch === currentEpoch,
    );
    output(
      `Controlled client close: ${closeObserved ? 'observed' : 'close callback not observed'}`,
    );

    currentEpoch = await transport.connect();
    reducer.startConnectionEpoch(currentEpoch);
    reducer.setConnection(true, currentEpoch);
    const authExchangesAfterReconnect = protocolEvents.filter(
      (event) => event.kind === 'authentication',
    ).length;
    output(
      `Reconnect: new WebSocket connected; WebSocket token reacquired; access token ${authExchangesAfterReconnect > authExchangesBeforeReconnect ? 'refreshed through authentication' : 'reused'}; token contents suppressed`,
    );
    await joinAllChannels(mapped);
    await heartbeatBatch(3);
    await readAndApplySnapshots(mapped, 'post-reconnect');
    if (unexpectedLockReport) throw new Error(unexpectedLockReport);
    await delay(Math.min(config.observeSeconds, 5) * 1000);
    if (unexpectedLockReport) throw new Error(unexpectedLockReport);

    const wsTokenAcquisitions = protocolEvents.filter(
      (event) => event.kind === 'websocket-token',
    ).length;
    const loginSuccesses = protocolEvents.filter(
      (event) => event.kind === 'authentication',
    ).length;
    output(
      `Recovery: channel joins acknowledged=${joinedChannels}; heartbeat acknowledgements=${heartbeatAcks}; WebSocket token acquisitions=${wsTokenAcquisitions}; login exchanges=${loginSuccesses}; socket connections=${socketsConnected}`,
    );
    const phoenixAcks = protocolEvents.filter(
      (event) => event.kind === 'acknowledgement',
    );
    const correlatedOkAcks = phoenixAcks.filter(
      (event) =>
        event.kind === 'acknowledgement' &&
        event.referenceCorrelated &&
        event.status === 'ok',
    ).length;
    output(
      `Phoenix acknowledgement evidence: join=${phoenixAcks.filter((event) => event.kind === 'acknowledgement' && event.action === 'join' && event.status === 'ok' && event.referenceCorrelated).length}; heartbeat=${phoenixAcks.filter((event) => event.kind === 'acknowledgement' && event.action === 'heartbeat' && event.status === 'ok' && event.referenceCorrelated).length}; correlated successful responses=${correlatedOkAcks}/${phoenixAcks.length}`,
    );
    const eventEnvelopes = protocolEvents.filter(
      (event) => event.kind === 'device-event-envelope',
    );
    output(
      eventEnvelopes.length === 0
        ? 'Phoenix device-event envelope: UNKNOWN (no natural device event observed)'
        : `Phoenix device-event envelopes: ${summarizeEventEnvelopes(eventEnvelopes)}`,
    );
    output(
      `Phoenix malformed/ignored protocol frames: ${protocolWarningCount}`,
    );
    printEventSummary(events, restSnapshots, output);
    output(
      `REST/WebSocket comparison: ${events.length === 0 ? 'no natural device events observed; no cross-source comparison possible' : 'event comparisons reported above without assuming source precedence'}`,
    );
  } finally {
    for (const unsubscribe of unsubscribers) unsubscribe();
    await transport.disconnect();
  }

  async function joinAllChannels(
    devices: ReturnType<typeof mapValidationDevices>,
  ): Promise<void> {
    for (const { device } of devices) {
      await transport.joinChannel(device.id);
      joinedChannels += 1;
    }
    output(
      `Phoenix channels: all ${devices.length} devices joined and acknowledged`,
    );
  }

  async function heartbeatBatch(count: number): Promise<void> {
    let acknowledged = 0;
    for (let index = 0; index < count; index += 1) {
      await transport.heartbeat();
      acknowledged += 1;
      heartbeatAcks += 1;
    }
    output(
      `Phoenix heartbeat: ${acknowledged}/${count} acknowledgements correlated by request reference`,
    );
  }

  async function readAndApplySnapshots(
    devices: ReturnType<typeof mapValidationDevices>,
    phase: string,
  ): Promise<void> {
    for (const { alias, device } of devices) {
      const fence = reducer.captureRestFence(device.id);
      const snapshot = await transport.getDeviceState(device.id);
      if (phase === 'initial') restSnapshots.set(device.id, snapshot);
      const result = reducer.applyRestSnapshot(
        device.id,
        fence,
        {
          online: snapshot.online,
          attributes: {
            ...snapshot.attributes,
            ...(snapshot.batteryLevel === undefined
              ? {}
              : { battery_level: snapshot.batteryLevel }),
          },
          ...(snapshot.updatedAt
            ? { smartrentTimestamp: snapshot.updatedAt }
            : {}),
        },
        Date.now(),
      );
      if (result.kind === 'stale' || result.kind === 'ignored') {
        output(
          `${alias}: ${phase} REST snapshot was fenced by a newer observation`,
        );
        continue;
      }
      if (alias === 'front-door') {
        const value = snapshot.attributes.locked;
        const safe = safeLockValue(value);
        if (safe.malformed) {
          output(
            `front-door locked: UNKNOWN (unexpected ${safe.representation}; parser coercion not applied)`,
          );
          unexpectedLockReport = `front-door REST locked field was ${safe.representation}; stopped with lock state UNKNOWN`;
          throw new Error(unexpectedLockReport);
        }
      }
      if (phase === 'initial') printDeviceSummary(alias, snapshot, output);
      else
        output(`${alias}: one post-reconnect REST snapshot read; source=REST`);
    }
  }
}

function printDeviceSummary(
  alias: ValidationAlias,
  device: SmartRentDevice,
  output: (line: string) => void,
): void {
  const online = device.online === null ? 'UNKNOWN' : String(device.online);
  const lines = [
    `${alias}`,
    `  type: ${device.type}`,
    `  online: ${online}`,
    '  state source: REST',
  ];
  const fieldPresence = new Set(device.fieldPresence ?? []);
  if (alias === 'front-door') {
    const lock = safeLockValue(device.attributes.locked);
    const jammed = safeBoolean(device.attributes.jammed);
    const current =
      device.online === false
        ? 'UNKNOWN (offline)'
        : jammed === true
          ? 'JAMMED'
          : lock.label;
    lines.push(`  locked: ${current}; representation=${lock.representation}`);
    lines.push(
      `  battery: ${safeBattery(device.batteryLevel)}; battery_powered field: ${fieldPresence.has('battery_powered') ? 'present' : 'absent'}`,
    );
    const auxiliary = WARNING_FIELDS.filter(
      (field) =>
        fieldPresence.has(field) || Object.hasOwn(device.attributes, field),
    );
    lines.push(
      `  jam/warning fields: ${auxiliary.length ? auxiliary.join(', ') : 'none of the inspected fields present'}`,
    );
    lines.push(
      `  jammed attribute: ${jammed === undefined ? 'UNKNOWN/absent' : String(jammed)}`,
    );
    lines.push(`  timestamps: ${timestampSummary(device, ['locked'])}`);
  } else if (alias === 'thermostat') {
    lines.push(
      `  mode: ${safeEnum(device.attributes.mode, ['HEAT', 'COOL', 'OFF', 'AUTO', 'AUX_HEAT'])}`,
    );
    lines.push(
      `  current temperature: ${safeNumber(device.attributes.current_temp, -100, 150)}`,
    );
    lines.push(
      `  humidity: ${safeNumber(device.attributes.current_humidity, 0, 100)}`,
    );
    lines.push(
      `  operating state: ${safeEnum(device.attributes.operating_state, ['HEATING', 'COOLING', 'IDLE', 'OFF', 'FAN_ONLY'])}`,
    );
    lines.push(
      `  fan mode: ${safeEnum(device.attributes.fan_mode, ['AUTO', 'ON', 'CIRCULATE', 'OFF'])}`,
    );
    lines.push(
      `  heating setpoint: ${safeNumber(device.attributes.heating_setpoint, 30, 110)}`,
    );
    lines.push(
      `  cooling setpoint: ${safeNumber(device.attributes.cooling_setpoint, 30, 110)}`,
    );
    lines.push(
      `  target fields present: heat=${Object.hasOwn(device.attributes, 'heating_setpoint') ? 'yes' : 'no'}; cool=${Object.hasOwn(device.attributes, 'cooling_setpoint') ? 'yes' : 'no'}`,
    );
    lines.push(
      `  timestamps: ${timestampSummary(device, ['mode', 'current_temp', 'current_humidity', 'heating_setpoint', 'cooling_setpoint', 'operating_state', 'fan_mode'])}`,
    );
  } else {
    const leak = safeLeakValue(device.attributes.leak);
    const current = device.online === false ? 'UNKNOWN (offline)' : leak.label;
    lines.push(`  leak: ${current}`);
    lines.push(`  battery: ${safeBattery(device.batteryLevel)}`);
    lines.push(`  timestamps: ${timestampSummary(device, ['leak'])}`);
  }
  for (const line of lines) output(line);
}

function printEventSummary(
  events: readonly CapturedEvent[],
  restSnapshots: ReadonlyMap<string, SmartRentDevice>,
  output: (line: string) => void,
): void {
  if (events.length === 0) {
    output('WebSocket events: none observed during bounded windows');
    return;
  }
  output(`WebSocket events: ${events.length} sanitized event(s) observed`);
  for (const event of events.slice(0, 20)) {
    const safe = safeEventValue(event.alias, event.attribute, event.value);
    const rest = restSnapshots.get(event.deviceId);
    const hasRestValue =
      rest && Object.hasOwn(rest.attributes, event.attribute);
    const restValue = rest?.attributes[event.attribute];
    const restTimestamp = rest?.attributeTimestamps?.[event.attribute];
    const comparison = !hasRestValue
      ? 'no corresponding REST attribute'
      : valuesEquivalent(restValue, event.value)
        ? 'matches REST baseline'
        : 'DIFFERS from REST baseline';
    const restSafe = hasRestValue
      ? safeEventValue(event.alias, event.attribute, restValue).label
      : 'UNKNOWN';
    output(
      `  ${event.alias} attribute=${event.attribute} websocket=${safe.label} REST=${restSafe} comparison=${comparison} epoch=${event.epoch} REST-baseline-age-ms=${Math.max(0, event.receivedAt - (rest ? Date.parse(rest.updatedAt ?? '') || event.receivedAt : event.receivedAt))} event-id=${event.eventIdPresent ? 'present' : 'absent'} timestamp=${event.timestamp ?? 'absent'} REST-field-timestamp=${restTimestamp ? safeTimestamp(restTimestamp) : 'absent'}`,
    );
  }
  if (events.length > 20) output('  additional events suppressed');
}

function valuesEquivalent(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if ((left === true || left === false) && right === String(left)) return true;
  if ((right === true || right === false) && left === String(right))
    return true;
  if (
    (typeof left === 'number' ||
      (typeof left === 'string' && /^-?\d+(?:\.\d+)?$/.test(left))) &&
    (typeof right === 'number' ||
      (typeof right === 'string' && /^-?\d+(?:\.\d+)?$/.test(right)))
  ) {
    return Number(left) === Number(right);
  }
  return false;
}

function summarizeEventEnvelopes(
  events: readonly SmartRentProtocolObservation[],
): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== 'device-event-envelope') continue;
    const key = `${event.shape}/${event.event}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([shape, count]) => `${shape}=${count}`).join(', ');
}

function safeEventValue(
  alias: ValidationAlias,
  attribute: string,
  value: unknown,
): SafeState {
  if (alias === 'front-door' && attribute === 'locked')
    return safeLockValue(value);
  if (
    (alias === 'washer-leak' || alias === 'kitchen-leak') &&
    attribute === 'leak'
  ) {
    return safeLeakValue(value);
  }
  return {
    label: 'observed',
    representation: safeRepresentation(value),
    malformed: false,
  };
}

function safeLockValue(value: unknown): SafeState {
  if (value === true || value === 'true') {
    return {
      label: 'SECURED',
      representation: safeRepresentation(value),
      malformed: false,
    };
  }
  if (value === false || value === 'false') {
    return {
      label: 'UNSECURED',
      representation: safeRepresentation(value),
      malformed: false,
    };
  }
  if (value === null || value === undefined) {
    return {
      label: 'UNKNOWN',
      representation: value === null ? 'null' : 'missing',
      malformed: false,
    };
  }
  return {
    label: 'UNKNOWN',
    representation: safeRepresentation(value),
    malformed: true,
  };
}

function safeLeakValue(value: unknown): SafeState {
  if (value === true || value === 'true') {
    return {
      label: 'LEAK',
      representation: safeRepresentation(value),
      malformed: false,
    };
  }
  if (value === false || value === 'false') {
    return {
      label: 'DRY',
      representation: safeRepresentation(value),
      malformed: false,
    };
  }
  return {
    label: 'UNKNOWN',
    representation: safeRepresentation(value),
    malformed: false,
  };
}

function safeBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function safeBattery(value: unknown): string {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
    ? `${value}%`
    : 'UNKNOWN';
}

function safeNumber(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  )
    return String(value);
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    if (parsed >= minimum && parsed <= maximum) return String(parsed);
  }
  return 'UNKNOWN';
}

function safeEnum(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== 'string') return 'UNKNOWN';
  const normalized = value.toUpperCase();
  return allowed.includes(normalized) ? normalized.toLowerCase() : 'UNKNOWN';
}

function safeRepresentation(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return `boolean:${value}`;
  if (typeof value === 'number') return 'number:[suppressed]';
  if (typeof value === 'string') {
    const token = value.toUpperCase();
    return SAFE_ENUMS.has(token) ? `string:${token}` : 'string:[suppressed]';
  }
  return Array.isArray(value) ? 'array' : 'object';
}

function safeAttributeName(value: string): string {
  return SAFE_ATTRIBUTE_NAMES.has(value) ? value : '[redacted-field]';
}

function safeTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : 'unparseable';
}

function timestampSummary(
  device: SmartRentDevice,
  fields: readonly string[],
): string {
  const summaries = fields.map((field) => {
    const timestamp = device.attributeTimestamps?.[field];
    return `${field}=${timestamp ? safeTimestamp(timestamp) : 'absent'}`;
  });
  return `device=${device.updatedAt ? safeTimestamp(device.updatedAt) : 'absent'}; ${summaries.join(', ')}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitBoundedOrSafety(
  milliseconds: number,
  safetySignal: Promise<void>,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
      safetySignal,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
