import type { HAP, Logging, PlatformAccessory, Service } from 'homebridge';
import type { RedactedDiagnosticLogger } from '../diagnostics/redacted-logger.js';
import {
  readAuthoritativeAttribute,
  type StateReducer,
} from '../state/model.js';

export type LeakReport = 'leak' | 'dry' | 'unknown';

export function normalizeLeakReport(value: unknown): LeakReport {
  if (value === true || value === 'true') return 'leak';
  if (value === false || value === 'false') return 'dry';
  return 'unknown';
}

export interface LeakSensorAccessoryOptions {
  alias: string;
  deviceId: string;
  attributeName?: string;
  reducer: StateReducer;
  diagnostics: RedactedDiagnosticLogger;
  api: Pick<HAP, 'Service' | 'Characteristic'>;
  accessory: PlatformAccessory;
  logger: Pick<Logging, 'warn'>;
  now?: () => number;
}

/** HomeKit reads fail with a communication fault while leak state is unknown. */
export class LeakSensorAccessory {
  private readonly service: Service;
  private readonly attributeName: string;
  private lastGeneration = -1;

  constructor(private readonly options: LeakSensorAccessoryOptions) {
    this.attributeName = options.attributeName ?? 'leak';
    const { api, accessory, alias, deviceId } = options;
    this.service =
      accessory.getServiceById(api.Service.LeakSensor, deviceId) ??
      accessory.addService(api.Service.LeakSensor, alias, deviceId);
    this.service
      .getCharacteristic(api.Characteristic.LeakDetected)
      .onGet(() => this.readValue());
    this.refreshFromState();
  }

  refreshFromState(): void {
    const state = this.options.reducer.getDevice(this.options.deviceId);
    if (state.generation === this.lastGeneration) return;
    this.lastGeneration = state.generation;
    const value = normalizeLeakReport(
      readAuthoritativeAttribute(state, this.attributeName),
    );
    if (value === 'unknown') {
      this.service.updateCharacteristic(
        this.options.api.Characteristic.StatusFault,
        this.options.api.Characteristic.StatusFault.GENERAL_FAULT,
      );
      this.options.diagnostics.sensor({
        event: 'SENSOR_UNKNOWN',
        alias: this.options.alias,
        generation: state.generation,
        connectionEpoch: state.connectionEpoch,
        reported: 'UNKNOWN',
      });
      return;
    }

    this.service.updateCharacteristic(
      this.options.api.Characteristic.LeakDetected,
      value === 'leak'
        ? this.options.api.Characteristic.LeakDetected.LEAK_DETECTED
        : this.options.api.Characteristic.LeakDetected.LEAK_NOT_DETECTED,
    );
    this.service.updateCharacteristic(
      this.options.api.Characteristic.StatusFault,
      this.options.api.Characteristic.StatusFault.NO_FAULT,
    );
    const observation = state.attributes[this.attributeName];
    this.options.diagnostics.sensor({
      event: 'SENSOR_REPORTED',
      alias: this.options.alias,
      generation: state.generation,
      connectionEpoch: state.connectionEpoch,
      ...(observation?.source ? { source: observation.source } : {}),
      ...(observation?.receivedAt === undefined
        ? {}
        : { ageMs: (this.options.now ?? Date.now)() - observation.receivedAt }),
      reported: value === 'leak' ? 'LEAK' : 'DRY',
    });
  }

  private readValue(): number {
    const state = this.options.reducer.getDevice(this.options.deviceId);
    const value = normalizeLeakReport(
      readAuthoritativeAttribute(state, this.attributeName),
    );
    if (value === 'unknown') {
      this.options.logger.warn('[SmartRentNext] Leak sensor read unavailable');
      throw new Error('Leak sensor state unavailable');
    }
    return value === 'leak'
      ? this.options.api.Characteristic.LeakDetected.LEAK_DETECTED
      : this.options.api.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
  }
}
