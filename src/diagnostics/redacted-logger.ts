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
  | 'JAMMED';

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
