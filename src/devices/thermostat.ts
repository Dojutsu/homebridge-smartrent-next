import type {
  CharacteristicValue,
  Characteristic,
  HAP,
  Logging,
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge';
import type { RedactedDiagnosticLogger } from '../diagnostics/redacted-logger.js';
import {
  readAuthoritativeAttribute,
  type DeviceState,
  type StateReducer,
} from '../state/model.js';
import type { SmartRentTransport } from '../transport/types.js';

export type ThermostatMode = 'off' | 'cool' | 'heat' | 'auto' | 'aux_heat';
export type ThermostatUnit = 'celsius' | 'fahrenheit';

export function normalizeThermostatMode(
  value: unknown,
): ThermostatMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  return ['off', 'cool', 'heat', 'auto', 'aux_heat'].includes(normalized)
    ? (normalized as ThermostatMode)
    : undefined;
}

export class ThermostatController {
  private commandSequence = 0;

  constructor(
    private readonly alias: string,
    private readonly deviceId: string,
    private readonly reducer: StateReducer,
    private readonly transport: SmartRentTransport,
    private readonly diagnostics: RedactedDiagnosticLogger,
    private readonly unit: () => ThermostatUnit,
    private readonly onStateChange: () => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  async requestMode(mode: ThermostatMode): Promise<void> {
    await this.writeOnce('mode', mode, 'mode', mode);
  }

  async requestTargetTemperature(value: number): Promise<void> {
    const fahrenheit = this.toSmartRentFahrenheit(value);
    const mode = await this.getFreshMode();
    const attribute = selectSetpointAttribute(mode);
    await this.writeOnce(
      attribute,
      String(fahrenheit),
      'targetTemperature',
      value,
    );
  }

  async requestHeatingThreshold(value: number): Promise<void> {
    const fahrenheit = this.toSmartRentFahrenheit(value);
    await this.writeOnce(
      'heating_setpoint',
      String(fahrenheit),
      'heatingSetpoint',
      value,
    );
  }

  async requestCoolingThreshold(value: number): Promise<void> {
    const fahrenheit = this.toSmartRentFahrenheit(value);
    await this.writeOnce(
      'cooling_setpoint',
      String(fahrenheit),
      'coolingSetpoint',
      value,
    );
  }

  private async getFreshMode(): Promise<ThermostatMode> {
    const cached = normalizeThermostatMode(
      readAuthoritativeAttribute(this.reducer.getDevice(this.deviceId), 'mode'),
    );
    if (cached) return cached;

    const fence = this.reducer.captureRestFence(this.deviceId);
    try {
      const device = await this.transport.getDeviceState(this.deviceId);
      this.reducer.applyRestSnapshot(
        this.deviceId,
        fence,
        {
          online: device.online,
          attributes: device.attributes,
          ...(device.updatedAt ? { smartrentTimestamp: device.updatedAt } : {}),
        },
        this.now(),
      );
      this.onStateChange();
    } catch {
      this.reducer.markDeviceUnknown(this.deviceId, 'unavailable');
      this.onStateChange();
      throw new Error('Thermostat mode unavailable; setpoint was not sent');
    }

    const refreshed = normalizeThermostatMode(
      readAuthoritativeAttribute(this.reducer.getDevice(this.deviceId), 'mode'),
    );
    if (!refreshed)
      throw new Error('Thermostat mode unavailable; setpoint was not sent');
    return refreshed;
  }

  private toSmartRentFahrenheit(value: number): number {
    if (!Number.isFinite(value))
      throw new RangeError('Thermostat target must be a finite number');
    const fahrenheit =
      this.unit() === 'celsius'
        ? Math.round((value * 9) / 5 + 32)
        : Math.round(value);
    // The prior implementation uses 50–90°F as SmartRent's setpoint range.
    if (fahrenheit < 50 || fahrenheit > 90) {
      throw new RangeError('Thermostat target must map to 50–90°F');
    }
    return fahrenheit;
  }

  private async writeOnce(
    attribute: string,
    requestedValue: string,
    field: 'mode' | 'targetTemperature' | 'heatingSetpoint' | 'coolingSetpoint',
    displayValue: string | number,
  ): Promise<void> {
    const commandId = `thermostat-command-${++this.commandSequence}`;
    const requested = this.reducer.recordRequested(
      this.deviceId,
      attribute,
      requestedValue,
      commandId,
      this.now(),
    );
    this.diagnostics.thermostat({
      event: 'APPLE_REQUESTED',
      alias: this.alias,
      generation: requested.generation,
      connectionEpoch: requested.connectionEpoch,
      field,
      value: displayValue,
    });
    try {
      await this.transport.setDeviceAttributes(this.deviceId, [
        { name: attribute, state: requestedValue },
      ]);
      const accepted = this.reducer.markCommandAccepted(
        this.deviceId,
        attribute,
        commandId,
      );
      this.diagnostics.thermostat({
        event: 'SMARTRENT_ACCEPTED',
        alias: this.alias,
        generation: accepted.generation,
        connectionEpoch: accepted.connectionEpoch,
        field,
        value: displayValue,
      });
    } catch (error) {
      const unresolved = this.reducer.markCommandUnresolved(
        this.deviceId,
        attribute,
        commandId,
      );
      this.diagnostics.thermostat({
        event: 'UNKNOWN',
        alias: this.alias,
        generation: unresolved.generation,
        connectionEpoch: unresolved.connectionEpoch,
        field,
      });
      this.onStateChange();
      throw error;
    }
  }
}

export function selectSetpointAttribute(
  mode: ThermostatMode,
): 'heating_setpoint' | 'cooling_setpoint' {
  // VERIFIED in the reviewed plugin: cooling mode selects cooling_setpoint;
  // every other reported mode selects heating_setpoint. SmartRent semantics for
  // auto/off are UNKNOWN and must be validated against a non-production test device.
  return mode === 'cool' ? 'cooling_setpoint' : 'heating_setpoint';
}

export interface ThermostatAccessoryOptions {
  alias: string;
  deviceId: string;
  reducer: StateReducer;
  transport: SmartRentTransport;
  diagnostics: RedactedDiagnosticLogger;
  api: Pick<HAP, 'Service' | 'Characteristic'>;
  accessory: PlatformAccessory;
  logger: Pick<Logging, 'warn'>;
  temperatureUnit?: ThermostatUnit;
  now?: () => number;
}

/** Native HomeKit Thermostat service with immediate cache-backed getters. */
export class ThermostatAccessory {
  private readonly service: Service;
  private readonly controller: ThermostatController;
  private unit: ThermostatUnit;
  private lastGeneration = -1;

  constructor(private readonly options: ThermostatAccessoryOptions) {
    const { api, accessory, alias, deviceId } = options;
    this.unit = validUnit(accessory.context.temperatureUnit)
      ? accessory.context.temperatureUnit
      : (options.temperatureUnit ?? 'celsius');
    this.service =
      accessory.getServiceById(api.Service.Thermostat, deviceId) ??
      accessory.addService(api.Service.Thermostat, alias, deviceId);
    this.controller = new ThermostatController(
      alias,
      deviceId,
      options.reducer,
      options.transport,
      options.diagnostics,
      () => this.unit,
      () => this.refreshFromState(),
      options.now,
    );
    this.bindCharacteristics();
    this.refreshFromState();
  }

  refreshFromState(): void {
    const state = this.options.reducer.getDevice(this.options.deviceId);
    if (state.generation === this.lastGeneration) return;
    this.lastGeneration = state.generation;
    const { Characteristic: C } = this.options.api;
    this.updateNumber(
      'current_temp',
      C.CurrentTemperature,
      'currentTemperature',
    );
    this.updateNumber(
      'current_humidity',
      C.CurrentRelativeHumidity,
      'humidity',
    );
    this.updateMode(state);
    this.updateOperatingState(state);
    this.updateNumber(
      'heating_setpoint',
      C.HeatingThresholdTemperature,
      'heatingSetpoint',
      true,
    );
    this.updateNumber(
      'cooling_setpoint',
      C.CoolingThresholdTemperature,
      'coolingSetpoint',
      true,
    );
    this.updateTargetTemperature(state);

    this.configureTemperatureProperties();
  }

  private bindCharacteristics(): void {
    const C = this.options.api.Characteristic;
    this.service
      .getCharacteristic(C.CurrentTemperature)
      .onGet(() => this.readTemperature('current_temp'));
    this.service
      .getCharacteristic(C.CurrentRelativeHumidity)
      .onGet(() => this.readHumidity());
    this.service
      .getCharacteristic(C.CurrentHeatingCoolingState)
      .onGet(() => this.readOperatingState());
    this.service
      .getCharacteristic(C.TargetHeatingCoolingState)
      .onGet(() => this.readTargetMode())
      .onSet((value) => this.setMode(value));
    this.service
      .getCharacteristic(C.TargetTemperature)
      .onGet(() => this.readTargetTemperature())
      .onSet((value) => this.setTargetTemperature(value));
    this.service
      .getCharacteristic(C.HeatingThresholdTemperature)
      .onGet(() => this.readTemperature('heating_setpoint'))
      .onSet((value) => this.setThreshold(value, 'heating'));
    this.service
      .getCharacteristic(C.CoolingThresholdTemperature)
      .onGet(() => this.readTemperature('cooling_setpoint'))
      .onSet((value) => this.setThreshold(value, 'cooling'));
    this.service
      .getCharacteristic(C.TemperatureDisplayUnits)
      .onGet(() => this.unitValue())
      .onSet((value) => this.setDisplayUnit(value));
  }

  private readTemperature(attribute: string): number {
    const fahrenheit = numericValue(
      readAuthoritativeAttribute(
        this.options.reducer.getDevice(this.options.deviceId),
        attribute,
      ),
    );
    if (fahrenheit === undefined)
      throw new Error('Thermostat temperature unavailable');
    return this.fromSmartRentFahrenheit(fahrenheit);
  }

  private readTargetTemperature(): number {
    const state = this.options.reducer.getDevice(this.options.deviceId);
    const mode = normalizeThermostatMode(
      readAuthoritativeAttribute(state, 'mode'),
    );
    if (!mode) throw new Error('Thermostat mode unavailable');
    return this.readTemperature(selectSetpointAttribute(mode));
  }

  private readHumidity(): number {
    const value = numericValue(
      readAuthoritativeAttribute(
        this.options.reducer.getDevice(this.options.deviceId),
        'current_humidity',
      ),
    );
    if (value === undefined || value < 0 || value > 100)
      throw new Error('Thermostat humidity unavailable');
    return value;
  }

  private readTargetMode(): number {
    const mode = normalizeThermostatMode(
      readAuthoritativeAttribute(
        this.options.reducer.getDevice(this.options.deviceId),
        'mode',
      ),
    );
    if (!mode) throw new Error('Thermostat mode unavailable');
    return this.modeValue(mode);
  }

  private readOperatingState(): number {
    const state = readAuthoritativeAttribute(
      this.options.reducer.getDevice(this.options.deviceId),
      'operating_state',
    );
    if (typeof state !== 'string')
      throw new Error('Thermostat operating state unavailable');
    const normalized = state.toLowerCase();
    const current = this.options.api.Characteristic.CurrentHeatingCoolingState;
    if (normalized === 'heating') return current.HEAT;
    if (normalized === 'cooling') return current.COOL;
    if (['idle', 'off', 'fan_only'].includes(normalized)) return current.OFF;
    throw new Error('Thermostat operating state unavailable');
  }

  private async setMode(value: CharacteristicValue): Promise<void> {
    const target = this.options.api.Characteristic.TargetHeatingCoolingState;
    const mode =
      value === target.OFF
        ? 'off'
        : value === target.HEAT
          ? 'heat'
          : value === target.COOL
            ? 'cool'
            : value === target.AUTO
              ? 'auto'
              : undefined;
    if (!mode) throw new Error('Invalid thermostat mode');
    await this.controller.requestMode(mode);
  }

  private async setTargetTemperature(
    value: CharacteristicValue,
  ): Promise<void> {
    if (typeof value !== 'number') throw new Error('Invalid thermostat target');
    await this.controller.requestTargetTemperature(value);
  }

  private async setThreshold(
    value: CharacteristicValue,
    kind: 'heating' | 'cooling',
  ): Promise<void> {
    if (typeof value !== 'number')
      throw new Error('Invalid thermostat threshold');
    if (kind === 'heating')
      await this.controller.requestHeatingThreshold(value);
    else await this.controller.requestCoolingThreshold(value);
  }

  private setDisplayUnit(value: CharacteristicValue): void {
    const C = this.options.api.Characteristic.TemperatureDisplayUnits;
    if (value === C.CELSIUS) this.unit = 'celsius';
    else if (value === C.FAHRENHEIT) this.unit = 'fahrenheit';
    else throw new Error('Invalid temperature display unit');
    this.options.accessory.context.temperatureUnit = this.unit;
    this.lastGeneration = -1;
    this.refreshFromState();
  }

  private updateNumber(
    attribute: string,
    characteristic: WithUUID<new () => Characteristic>,
    field:
      'currentTemperature' | 'humidity' | 'heatingSetpoint' | 'coolingSetpoint',
    convertFromFahrenheit = false,
  ): void {
    const state = this.options.reducer.getDevice(this.options.deviceId);
    const value = numericValue(readAuthoritativeAttribute(state, attribute));
    if (value === undefined) return;
    const displayed = convertFromFahrenheit
      ? this.fromSmartRentFahrenheit(value)
      : value;
    this.service.updateCharacteristic(characteristic, displayed);
    this.logReported(state, attribute, field, displayed);
  }

  private updateMode(state: DeviceState): void {
    const mode = normalizeThermostatMode(
      readAuthoritativeAttribute(state, 'mode'),
    );
    if (!mode) return;
    const value = this.modeValue(mode);
    this.service.updateCharacteristic(
      this.options.api.Characteristic.TargetHeatingCoolingState,
      value,
    );
    this.logReported(state, 'mode', 'mode', mode);
  }

  private updateOperatingState(state: DeviceState): void {
    try {
      const value = this.readOperatingState();
      this.service.updateCharacteristic(
        this.options.api.Characteristic.CurrentHeatingCoolingState,
        value,
      );
      this.logReported(state, 'operating_state', 'operatingState', value);
    } catch {
      // Keep the last displayed value; HAP reads will report an unavailable state.
    }
  }

  private updateTargetTemperature(state: DeviceState): void {
    try {
      const value = this.readTargetTemperature();
      this.service.updateCharacteristic(
        this.options.api.Characteristic.TargetTemperature,
        value,
      );
      this.logReported(state, 'targetTemperature', 'targetTemperature', value);
    } catch {
      // No fallback target is fabricated when mode or setpoint is unavailable.
    }
  }

  private logReported(
    state: DeviceState,
    attribute: string,
    field:
      | 'mode'
      | 'operatingState'
      | 'currentTemperature'
      | 'targetTemperature'
      | 'heatingSetpoint'
      | 'coolingSetpoint'
      | 'humidity',
    value: string | number,
  ): void {
    const observation = state.attributes[attribute];
    this.options.diagnostics.thermostat({
      event: 'SMARTRENT_REPORTED',
      alias: this.options.alias,
      generation: state.generation,
      connectionEpoch: state.connectionEpoch,
      field,
      ...(observation?.source ? { source: observation.source } : {}),
      value,
    });
    this.options.diagnostics.thermostat({
      event: 'HAP_CURRENT_UPDATED',
      alias: this.options.alias,
      generation: state.generation,
      connectionEpoch: state.connectionEpoch,
      field,
      value,
    });
  }

  private fromSmartRentFahrenheit(value: number): number {
    return this.unit === 'celsius'
      ? Math.round((((value - 32) * 5) / 9) * 10) / 10
      : value;
  }

  private modeValue(mode: ThermostatMode): number {
    const target = this.options.api.Characteristic.TargetHeatingCoolingState;
    if (mode === 'cool') return target.COOL;
    if (mode === 'heat' || mode === 'aux_heat') return target.HEAT;
    if (mode === 'auto') return target.AUTO;
    return target.OFF;
  }

  private unitValue(): number {
    const units = this.options.api.Characteristic.TemperatureDisplayUnits;
    return this.unit === 'celsius' ? units.CELSIUS : units.FAHRENHEIT;
  }

  private configureTemperatureProperties(): void {
    const celsius = this.unit === 'celsius';
    const props = {
      minValue: celsius ? 10 : 50,
      maxValue: celsius ? 38 : 90,
      minStep: celsius ? 0.1 : 1,
    };
    const C = this.options.api.Characteristic;
    const values: Array<
      [WithUUID<new () => Characteristic>, number | undefined]
    > = [
      [
        C.TargetTemperature,
        this.safeTemperature(() => this.readTargetTemperature()),
      ],
      [
        C.HeatingThresholdTemperature,
        this.safeTemperature(() => this.readTemperature('heating_setpoint')),
      ],
      [
        C.CoolingThresholdTemperature,
        this.safeTemperature(() => this.readTemperature('cooling_setpoint')),
      ],
    ];
    for (const [characteristic, value] of values) {
      if (
        value !== undefined &&
        value >= props.minValue &&
        value <= props.maxValue
      ) {
        this.service.getCharacteristic(characteristic).setProps(props);
      }
    }
  }

  private safeTemperature(read: () => number): number | undefined {
    try {
      return read();
    } catch {
      return undefined;
    }
  }
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function validUnit(value: unknown): value is ThermostatUnit {
  return value === 'celsius' || value === 'fahrenheit';
}
