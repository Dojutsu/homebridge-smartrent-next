import type { Logging } from 'homebridge';
import type { StateSource } from '../state/model.js';

export type LockStateLabel = 'SECURED' | 'UNSECURED' | 'UNKNOWN' | 'JAMMED';
export type DiagnosticEventName =
  | 'APPLE_REQUESTED'
  | 'SMARTRENT_ACCEPTED'
  | 'SMARTRENT_REPORTED'
  | 'HAP_CURRENT_UPDATED'
  | 'UNKNOWN'
  | 'OFFLINE'
  | 'JAMMED'
  | 'SENSOR_REPORTED'
  | 'SENSOR_UNKNOWN';

export interface LockDiagnostic {
  event: DiagnosticEventName;
  alias: string;
  generation: number;
  connectionEpoch: number;
  source?: StateSource;
  ageMs?: number;
  target?: LockStateLabel;
  reported?: LockStateLabel;
  current?: LockStateLabel;
  transition?: string;
}

export interface SensorDiagnostic {
  event: 'SENSOR_REPORTED' | 'SENSOR_UNKNOWN';
  alias: string;
  generation: number;
  connectionEpoch: number;
  source?: StateSource;
  ageMs?: number;
  reported: 'LEAK' | 'DRY' | 'UNKNOWN';
}

export interface ThermostatDiagnostic {
  event:
    | 'APPLE_REQUESTED'
    | 'SMARTRENT_ACCEPTED'
    | 'SMARTRENT_REPORTED'
    | 'HAP_CURRENT_UPDATED'
    | 'UNKNOWN';
  alias: string;
  generation: number;
  connectionEpoch: number;
  field:
    | 'mode'
    | 'operatingState'
    | 'currentTemperature'
    | 'targetTemperature'
    | 'heatingSetpoint'
    | 'coolingSetpoint'
    | 'humidity';
  source?: StateSource;
  ageMs?: number;
  value?: string | number;
}

export class RedactedDiagnosticLogger {
  constructor(private readonly logger: Pick<Logging, 'info' | 'warn'>) {}

  lock(record: LockDiagnostic): void {
    const safe: Record<string, string | number> = {
      event: record.event,
      alias: safeAlias(record.alias),
      generation: safeCounter(record.generation),
      connectionEpoch: safeCounter(record.connectionEpoch),
    };
    if (record.source) safe.source = record.source;
    if (record.ageMs !== undefined && Number.isFinite(record.ageMs))
      safe.ageMs = Math.max(0, Math.floor(record.ageMs));
    if (record.target) safe.target = record.target;
    if (record.reported) safe.reported = record.reported;
    if (record.current) safe.current = record.current;
    if (record.transition) safe.transition = safeTransition(record.transition);
    const line = JSON.stringify(safe);
    if (
      record.event === 'UNKNOWN' ||
      record.event === 'OFFLINE' ||
      record.event === 'JAMMED'
    ) {
      this.logger.warn('[SmartRentNext] %s', line);
    } else {
      this.logger.info('[SmartRentNext] %s', line);
    }
  }

  sensor(record: SensorDiagnostic): void {
    const safe: Record<string, string | number> = {
      event: record.event,
      alias: safeAlias(record.alias),
      generation: safeCounter(record.generation),
      connectionEpoch: safeCounter(record.connectionEpoch),
      reported: record.reported,
    };
    if (record.source) safe.source = record.source;
    if (record.ageMs !== undefined && Number.isFinite(record.ageMs))
      safe.ageMs = Math.max(0, Math.floor(record.ageMs));
    const line = JSON.stringify(safe);
    if (record.event === 'SENSOR_UNKNOWN')
      this.logger.warn('[SmartRentNext] %s', line);
    else this.logger.info('[SmartRentNext] %s', line);
  }

  thermostat(record: ThermostatDiagnostic): void {
    const safe: Record<string, string | number> = {
      event: record.event,
      alias: safeAlias(record.alias),
      generation: safeCounter(record.generation),
      connectionEpoch: safeCounter(record.connectionEpoch),
      field: record.field,
    };
    if (record.source) safe.source = record.source;
    if (record.ageMs !== undefined && Number.isFinite(record.ageMs))
      safe.ageMs = Math.max(0, Math.floor(record.ageMs));
    if (typeof record.value === 'number' && Number.isFinite(record.value))
      safe.value = record.value;
    if (
      typeof record.value === 'string' &&
      /^[a-z0-9_.-]{1,32}$/i.test(record.value)
    )
      safe.value = record.value;
    const line = JSON.stringify(safe);
    if (record.event === 'UNKNOWN')
      this.logger.warn('[SmartRentNext] %s', line);
    else this.logger.info('[SmartRentNext] %s', line);
  }
}

function safeCounter(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeAlias(value: string): string {
  const trimmed = value.trim().slice(0, 48);
  return /^[\p{L}\p{N} _.\-]+$/u.test(trimmed) ? trimmed : 'SmartRent device';
}

function safeTransition(value: string): string {
  const trimmed = value.trim().slice(0, 48);
  return /^[A-Z_ -]+$/.test(trimmed) ? trimmed : 'state-change';
}
