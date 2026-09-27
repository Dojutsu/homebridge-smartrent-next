import type {
  CharacteristicValue,
  HAP,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';
import type { SmartRentTransport } from '../transport/types.js';
import type {
  RedactedDiagnosticLogger,
  LockStateLabel,
} from '../diagnostics/redacted-logger.js';
import {
  readAuthoritativeAttribute,
  type DeviceState,
  type StateReducer,
} from '../state/model.js';

export interface LockCommandResult {
  commandId: string;
  accepted: boolean;
}

export class LockController {
  private commandSequence = 0;

  constructor(
    private readonly alias: string,
    private readonly deviceId: string,
    private readonly reducer: StateReducer,
    private readonly transport: SmartRentTransport,
    private readonly diagnostics: RedactedDiagnosticLogger,
    private readonly now: () => number = Date.now,
  ) {}

  async requestTarget(locked: boolean): Promise<LockCommandResult> {
    const commandId = `lock-command-${++this.commandSequence}`;
    const before = this.reducer.getDevice(this.deviceId);
    const requestedAt = this.now();
    const requested = this.reducer.recordRequested(
      this.deviceId,
      'locked',
      locked,
      commandId,
      requestedAt,
    );
    const beforeLabel = labelFromState(before);
    this.diagnostics.lock({
      event: 'APPLE_REQUESTED',
      alias: this.alias,
      generation: requested.generation,
      connectionEpoch: requested.connectionEpoch,
      target: locked ? 'SECURED' : 'UNSECURED',
      ...(beforeLabel ? { reported: beforeLabel } : {}),
      transition: 'target-requested',
    });

    try {
      // A physical lock command is sent once. Late confirmation never causes a retry.
      await this.transport.setDeviceAttributes(this.deviceId, [
        { name: 'locked', state: locked },
      ]);
      const accepted = this.reducer.markCommandAccepted(
        this.deviceId,
        'locked',
        commandId,
      );
      this.diagnostics.lock({
        event: 'SMARTRENT_ACCEPTED',
        alias: this.alias,
        generation: accepted.generation,
        connectionEpoch: accepted.connectionEpoch,
        target: locked ? 'SECURED' : 'UNSECURED',
        transition: 'request-accepted-not-confirmed',
      });
      return { commandId, accepted: true };
    } catch (error) {
      const unresolved = this.reducer.markCommandUnresolved(
        this.deviceId,
        'locked',
        commandId,
      );
      this.diagnostics.lock({
        event: 'UNKNOWN',
        alias: this.alias,
        generation: unresolved.generation,
        connectionEpoch: unresolved.connectionEpoch,
        target: locked ? 'SECURED' : 'UNSECURED',
        transition: 'command-outcome-unresolved',
      });
      throw error;
    }
  }
}

export function currentLockLabel(state: DeviceState): LockStateLabel {
  if (state.online === 'offline' || state.fault === 'unresolved-command')
    return 'UNKNOWN';
  if (readAuthoritativeAttribute(state, 'jammed') === true) return 'JAMMED';
  const value = readAuthoritativeAttribute(state, 'locked');
  if (value === true || value === 'true') return 'SECURED';
  if (value === false || value === 'false') return 'UNSECURED';
  return 'UNKNOWN';
}

function labelFromState(state: DeviceState): LockStateLabel | undefined {
  const label = currentLockLabel(state);
  return label === 'UNKNOWN' ? undefined : label;
}

export interface LockAccessoryOptions {
  alias: string;
  deviceId: string;
  reducer: StateReducer;
  transport: SmartRentTransport;
  diagnostics: RedactedDiagnosticLogger;
  api: Pick<HAP, 'Service' | 'Characteristic'>;
  accessory: PlatformAccessory;
  logger: Pick<Logging, 'warn'>;
  now?: () => number;
}

/** Native HomeKit LockMechanism with synchronous, cache-only getters. */
export class LockMechanismAccessory {
  private readonly service: Service;
  private readonly controller: LockController;
  private lastReportedGeneration = -1;

  constructor(private readonly options: LockAccessoryOptions) {
    const { api, accessory, alias, deviceId } = options;
    this.service =
      accessory.getServiceById(api.Service.LockMechanism.UUID, deviceId) ??
      accessory.addService(api.Service.LockMechanism, alias, deviceId);
    this.controller = new LockController(
      alias,
      deviceId,
      options.reducer,
      options.transport,
      options.diagnostics,
      options.now,
    );
    const currentCharacteristic = api.Characteristic.LockCurrentState;
    const targetCharacteristic = api.Characteristic.LockTargetState;
    this.service
      .getCharacteristic(currentCharacteristic)
      .onGet(() => this.currentValue());
    this.service
      .getCharacteristic(targetCharacteristic)
      .onGet(() => this.targetValue())
      .onSet((value) => this.setTarget(value));
    this.refreshFromState();
  }

  refreshFromState(): void {
    const state = this.options.reducer.getDevice(this.options.deviceId);
    if (state.generation === this.lastReportedGeneration) return;
    this.lastReportedGeneration = state.generation;
    const label = currentLockLabel(state);
    const enumValue = this.enumForLabel(label);
    this.service.updateCharacteristic(
      this.options.api.Characteristic.LockCurrentState,
      enumValue,
    );
    const observation = state.attributes.locked;
    if (observation?.freshness === 'fresh') {
      this.options.diagnostics.lock({
        event: 'SMARTRENT_REPORTED',
        alias: this.options.alias,
        generation: state.generation,
        connectionEpoch: state.connectionEpoch,
        source: observation.source,
        ...(observation.receivedAt === undefined
          ? {}
          : {
              ageMs: (this.options.now ?? Date.now)() - observation.receivedAt,
            }),
        reported: label,
        transition: 'authoritative-report',
      });
    } else if (state.online === 'offline') {
      this.options.diagnostics.lock({
        event: 'OFFLINE',
        alias: this.options.alias,
        generation: state.generation,
        connectionEpoch: state.connectionEpoch,
        current: 'UNKNOWN',
        transition: 'authoritative-connection-lost',
      });
    } else if (label === 'UNKNOWN') {
      this.options.diagnostics.lock({
        event: 'UNKNOWN',
        alias: this.options.alias,
        generation: state.generation,
        connectionEpoch: state.connectionEpoch,
        current: 'UNKNOWN',
        transition: state.fault ?? 'state-unavailable',
      });
    } else if (label === 'JAMMED') {
      this.options.diagnostics.lock({
        event: 'JAMMED',
        alias: this.options.alias,
        generation: state.generation,
        connectionEpoch: state.connectionEpoch,
        current: 'JAMMED',
        transition: 'explicit-jam-report',
      });
    }
    this.service.updateCharacteristic(
      this.options.api.Characteristic.StatusFault,
      label === 'UNKNOWN' || state.online === 'offline' || state.fault
        ? this.options.api.Characteristic.StatusFault.GENERAL_FAULT
        : this.options.api.Characteristic.StatusFault.NO_FAULT,
    );
    this.options.diagnostics.lock({
      event: 'HAP_CURRENT_UPDATED',
      alias: this.options.alias,
      generation: state.generation,
      connectionEpoch: state.connectionEpoch,
      current: label,
      transition: 'reported-state-mapped-to-hap',
    });
  }

  private currentValue(): number {
    return this.enumForLabel(
      currentLockLabel(this.options.reducer.getDevice(this.options.deviceId)),
    );
  }

  private targetValue(): number {
    const state = this.options.reducer.getDevice(this.options.deviceId);
    const requested = state.requested.locked?.value;
    if (requested === true)
      return this.options.api.Characteristic.LockTargetState.SECURED;
    if (requested === false)
      return this.options.api.Characteristic.LockTargetState.UNSECURED;
    const current = currentLockLabel(state);
    if (current === 'UNSECURED')
      return this.options.api.Characteristic.LockTargetState.UNSECURED;
    return this.options.api.Characteristic.LockTargetState.SECURED;
  }

  private async setTarget(value: CharacteristicValue): Promise<void> {
    const target = this.options.api.Characteristic.LockTargetState;
    if (value !== target.SECURED && value !== target.UNSECURED) {
      this.options.logger.warn(
        '[SmartRentNext] Ignored invalid HomeKit lock target',
      );
      throw new Error('Invalid HomeKit lock target');
    }
    try {
      await this.controller.requestTarget(value === target.SECURED);
    } catch (error) {
      this.refreshFromState();
      throw error;
    }
  }

  private enumForLabel(label: LockStateLabel): number {
    const current = this.options.api.Characteristic.LockCurrentState;
    switch (label) {
      case 'SECURED':
        return current.SECURED;
      case 'UNSECURED':
        return current.UNSECURED;
      case 'JAMMED':
        return current.JAMMED;
      case 'UNKNOWN':
        return current.UNKNOWN;
    }
  }
}
