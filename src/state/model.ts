export type StateSource = 'none' | 'rest' | 'websocket' | 'cached';
export type Freshness = 'fresh' | 'stale' | 'unknown';
export type OnlineState = 'online' | 'offline' | 'unknown';
export type FaultCode =
  | 'offline'
  | 'unavailable'
  | 'malformed'
  | 'unresolved-command'
  | 'conflicting-timestamp'
  | 'stale-data';

export interface AttributeObservation {
  /** Undefined means there is no authoritative value. */
  value: unknown;
  source: StateSource;
  receivedAt: number | undefined;
  smartrentTimestamp: string | undefined;
  connectionEpoch: number;
  generation: number;
  freshness: Freshness;
}

export interface RequestedAttribute {
  value: unknown;
  commandId: string;
  generation: number;
  requestedAt: number;
  status: 'requested' | 'accepted' | 'unresolved';
}

export interface DeviceState {
  deviceId: string;
  attributes: Readonly<Record<string, AttributeObservation>>;
  requested: Readonly<Record<string, RequestedAttribute>>;
  online: OnlineState;
  fault: FaultCode | undefined;
  connectionEpoch: number;
  generation: number;
}

export interface RestFence {
  connectionEpoch: number;
  generationAtStart: number;
}

export interface RestSnapshot {
  online: boolean | null;
  attributes: Readonly<Record<string, unknown>>;
  smartrentTimestamp?: string;
}

export interface StateChange {
  kind: 'accepted' | 'duplicate' | 'stale' | 'conflict' | 'ignored';
  state: DeviceState;
}

export class StateReducer {
  private readonly states = new Map<string, DeviceState>();
  private readonly seenEventIds = new Map<string, Set<string>>();
  private epoch = 0;

  get connectionEpoch(): number {
    return this.epoch;
  }

  registerDevice(deviceId: string): DeviceState {
    const prior = this.states.get(deviceId);
    if (prior) return prior;
    const state: DeviceState = {
      deviceId,
      attributes: {},
      requested: {},
      online: 'unknown',
      fault: undefined,
      connectionEpoch: this.epoch,
      generation: 0,
    };
    this.states.set(deviceId, state);
    return state;
  }

  getDevice(deviceId: string): DeviceState {
    return this.registerDevice(deviceId);
  }

  startConnectionEpoch(epoch: number): boolean {
    if (!Number.isSafeInteger(epoch) || epoch <= this.epoch) return false;
    this.epoch = epoch;
    for (const [id, prior] of this.states) {
      this.states.set(id, {
        ...prior,
        attributes: this.markAttributesUnknown(prior, epoch),
        online: 'unknown',
        fault: 'unavailable',
        connectionEpoch: epoch,
        generation: prior.generation + 1,
      });
    }
    return true;
  }

  setConnection(connected: boolean, epoch: number): boolean {
    if (epoch !== this.epoch) return false;
    for (const [id, prior] of this.states) {
      const generation = prior.generation + 1;
      this.states.set(id, {
        ...prior,
        attributes: this.markAttributesUnknown(prior, epoch),
        online: connected ? 'unknown' : 'offline',
        fault: connected ? 'unavailable' : 'offline',
        connectionEpoch: epoch,
        generation,
      });
    }
    return true;
  }

  captureRestFence(deviceId: string): RestFence {
    const state = this.getDevice(deviceId);
    return { connectionEpoch: this.epoch, generationAtStart: state.generation };
  }

  applyRestSnapshot(
    deviceId: string,
    fence: RestFence,
    snapshot: RestSnapshot,
    receivedAt: number,
  ): StateChange {
    const prior = this.getDevice(deviceId);
    if (
      fence.connectionEpoch !== this.epoch ||
      fence.connectionEpoch !== prior.connectionEpoch
    ) {
      return { kind: 'ignored', state: prior };
    }
    if (fence.generationAtStart !== prior.generation)
      return { kind: 'stale', state: prior };

    if (snapshot.online === false) {
      const next = this.makeUnknown(prior, 'offline', 'offline', receivedAt);
      this.states.set(deviceId, next);
      return { kind: 'accepted', state: next };
    }

    const generation = prior.generation + 1;
    const attributes: Record<string, AttributeObservation> = {};
    const incomingNames = new Set(Object.keys(snapshot.attributes));
    for (const name of Object.keys(prior.attributes)) {
      if (!incomingNames.has(name)) {
        attributes[name] = {
          value: undefined,
          source: 'none',
          receivedAt,
          smartrentTimestamp: undefined,
          connectionEpoch: this.epoch,
          generation,
          freshness: 'unknown',
        };
      }
    }
    for (const [name, value] of Object.entries(snapshot.attributes)) {
      const previous = prior.attributes[name];
      const priorTime = previous?.smartrentTimestamp
        ? Date.parse(previous.smartrentTimestamp)
        : Number.NaN;
      const incomingTime = snapshot.smartrentTimestamp
        ? Date.parse(snapshot.smartrentTimestamp)
        : Number.NaN;
      if (
        Number.isFinite(priorTime) &&
        Number.isFinite(incomingTime) &&
        incomingTime < priorTime
      ) {
        attributes[name] = previous!;
        continue;
      }
      if (
        Number.isFinite(priorTime) &&
        incomingTime === priorTime &&
        !Object.is(previous?.value, value)
      ) {
        attributes[name] = {
          value: undefined,
          source: 'none',
          receivedAt,
          smartrentTimestamp: snapshot.smartrentTimestamp,
          connectionEpoch: this.epoch,
          generation,
          freshness: 'unknown',
        };
        continue;
      }
      attributes[name] = {
        value,
        source: 'rest',
        receivedAt,
        smartrentTimestamp: snapshot.smartrentTimestamp,
        connectionEpoch: this.epoch,
        generation,
        freshness: value === null || value === undefined ? 'unknown' : 'fresh',
      };
    }
    const state: DeviceState = {
      ...prior,
      attributes,
      online: snapshot.online === true ? 'online' : 'unknown',
      fault: snapshot.online === true ? undefined : 'unavailable',
      connectionEpoch: this.epoch,
      generation,
    };
    this.states.set(deviceId, state);
    return { kind: 'accepted', state };
  }

  applyEvent(
    deviceId: string,
    attribute: string,
    value: unknown,
    epoch: number,
    receivedAt: number,
    eventId?: string,
    smartrentTimestamp?: string,
  ): StateChange {
    const prior = this.getDevice(deviceId);
    if (epoch !== this.epoch || epoch !== prior.connectionEpoch)
      return { kind: 'ignored', state: prior };
    if (eventId && this.hasSeen(deviceId, eventId))
      return { kind: 'duplicate', state: prior };
    if (eventId) this.remember(deviceId, eventId);

    const oldObservation = prior.attributes[attribute];
    const oldTimestamp = oldObservation?.smartrentTimestamp
      ? Date.parse(oldObservation.smartrentTimestamp)
      : Number.NaN;
    const newTimestamp = smartrentTimestamp
      ? Date.parse(smartrentTimestamp)
      : Number.NaN;
    if (Number.isFinite(oldTimestamp) && Number.isFinite(newTimestamp)) {
      if (newTimestamp < oldTimestamp) return { kind: 'stale', state: prior };
      if (
        newTimestamp === oldTimestamp &&
        !Object.is(oldObservation?.value, value)
      ) {
        const next = this.markUnknownState(
          prior,
          attribute,
          'conflicting-timestamp',
        );
        this.states.set(deviceId, next);
        return { kind: 'conflict', state: next };
      }
      if (
        newTimestamp === oldTimestamp &&
        Object.is(oldObservation?.value, value)
      ) {
        return { kind: 'duplicate', state: prior };
      }
    }

    const generation = prior.generation + 1;
    const observation: AttributeObservation = {
      value,
      source: 'websocket',
      receivedAt,
      smartrentTimestamp: smartrentTimestamp ?? undefined,
      connectionEpoch: epoch,
      generation,
      freshness: value === null || value === undefined ? 'unknown' : 'fresh',
    };
    const requested = { ...prior.requested };
    const pending = requested[attribute];
    if (pending) delete requested[attribute];
    const state: DeviceState = {
      ...prior,
      attributes: { ...prior.attributes, [attribute]: observation },
      requested,
      online: value === null || value === undefined ? prior.online : 'online',
      fault: value === null || value === undefined ? 'malformed' : undefined,
      connectionEpoch: epoch,
      generation,
    };
    this.states.set(deviceId, state);
    return { kind: 'accepted', state };
  }

  recordRequested(
    deviceId: string,
    attribute: string,
    value: unknown,
    commandId: string,
    requestedAt: number,
  ): DeviceState {
    const prior = this.getDevice(deviceId);
    const generation = prior.generation + 1;
    const state: DeviceState = {
      ...prior,
      requested: {
        ...prior.requested,
        [attribute]: {
          value,
          commandId,
          generation,
          requestedAt,
          status: 'requested',
        },
      },
      generation,
    };
    this.states.set(deviceId, state);
    return state;
  }

  markCommandAccepted(
    deviceId: string,
    attribute: string,
    commandId: string,
  ): DeviceState {
    const prior = this.getDevice(deviceId);
    const pending = prior.requested[attribute];
    if (!pending || pending.commandId !== commandId) return prior;
    const state: DeviceState = {
      ...prior,
      requested: {
        ...prior.requested,
        [attribute]: { ...pending, status: 'accepted' },
      },
    };
    this.states.set(deviceId, state);
    return state;
  }

  markCommandUnresolved(
    deviceId: string,
    attribute: string,
    commandId: string,
  ): DeviceState {
    const prior = this.getDevice(deviceId);
    const pending = prior.requested[attribute];
    if (!pending || pending.commandId !== commandId) return prior;
    const generation = prior.generation + 1;
    const unknown: AttributeObservation = {
      value: undefined,
      source: 'none',
      receivedAt: undefined,
      smartrentTimestamp: undefined,
      connectionEpoch: this.epoch,
      generation,
      freshness: 'unknown',
    };
    const state: DeviceState = {
      ...prior,
      attributes: { ...prior.attributes, [attribute]: unknown },
      requested: {
        ...prior.requested,
        [attribute]: { ...pending, status: 'unresolved' },
      },
      fault: 'unresolved-command',
      generation,
    };
    this.states.set(deviceId, state);
    return state;
  }

  markAttributeUnknown(
    deviceId: string,
    attribute: string,
    fault: FaultCode,
  ): DeviceState {
    return this.markUnknownState(this.getDevice(deviceId), attribute, fault);
  }

  private markUnknownState(
    prior: DeviceState,
    attribute: string,
    fault: FaultCode,
  ): DeviceState {
    const generation = prior.generation + 1;
    const observation: AttributeObservation = {
      value: undefined,
      source: 'none',
      receivedAt: undefined,
      smartrentTimestamp: undefined,
      connectionEpoch: this.epoch,
      generation,
      freshness: 'unknown',
    };
    const state: DeviceState = {
      ...prior,
      attributes: { ...prior.attributes, [attribute]: observation },
      fault,
      generation,
    };
    this.states.set(prior.deviceId, state);
    return state;
  }

  markStale(deviceId: string, attribute: string): DeviceState {
    const prior = this.getDevice(deviceId);
    const existing = prior.attributes[attribute];
    if (!existing || existing.freshness !== 'fresh') return prior;
    const state: DeviceState = {
      ...prior,
      attributes: {
        ...prior.attributes,
        [attribute]: { ...existing, freshness: 'stale' },
      },
      fault: 'stale-data',
    };
    this.states.set(deviceId, state);
    return state;
  }

  markDeviceUnknown(deviceId: string, fault: FaultCode): DeviceState {
    const prior = this.getDevice(deviceId);
    const generation = prior.generation + 1;
    const attributes = Object.fromEntries(
      Object.entries(prior.attributes).map(([name]) => [
        name,
        {
          value: undefined,
          source: 'none' as const,
          receivedAt: undefined,
          smartrentTimestamp: undefined,
          connectionEpoch: this.epoch,
          generation,
          freshness: 'unknown' as const,
        },
      ]),
    );
    const state: DeviceState = {
      ...prior,
      attributes,
      online: 'unknown',
      fault,
      connectionEpoch: this.epoch,
      generation,
    };
    this.states.set(deviceId, state);
    return state;
  }

  private makeUnknown(
    prior: DeviceState,
    online: OnlineState,
    fault: FaultCode,
    receivedAt: number,
  ): DeviceState {
    const generation = prior.generation + 1;
    const attributes = Object.fromEntries(
      Object.entries(prior.attributes).map(([name]) => [
        name,
        {
          value: undefined,
          source: 'none' as const,
          receivedAt,
          smartrentTimestamp: undefined,
          connectionEpoch: this.epoch,
          generation,
          freshness: 'unknown' as const,
        },
      ]),
    );
    return {
      ...prior,
      attributes,
      online,
      fault,
      connectionEpoch: this.epoch,
      generation,
    };
  }

  private markAttributesUnknown(
    prior: DeviceState,
    epoch: number,
  ): Readonly<Record<string, AttributeObservation>> {
    const generation = prior.generation + 1;
    return Object.fromEntries(
      Object.entries(prior.attributes).map(([name]) => [
        name,
        {
          value: undefined,
          source: 'none' as const,
          receivedAt: undefined,
          smartrentTimestamp: undefined,
          connectionEpoch: epoch,
          generation,
          freshness: 'unknown' as const,
        },
      ]),
    );
  }

  private hasSeen(deviceId: string, eventId: string): boolean {
    return this.seenEventIds.get(deviceId)?.has(eventId) ?? false;
  }

  private remember(deviceId: string, eventId: string): void {
    let seen = this.seenEventIds.get(deviceId);
    if (!seen) {
      seen = new Set();
      this.seenEventIds.set(deviceId, seen);
    }
    seen.add(eventId);
    if (seen.size > 512) seen.delete(seen.values().next().value as string);
  }
}

export function readAuthoritativeAttribute(
  state: DeviceState,
  attribute: string,
): unknown {
  const observation = state.attributes[attribute];
  if (state.online === 'offline' || state.fault === 'unresolved-command')
    return undefined;
  if (
    !observation ||
    observation.freshness !== 'fresh' ||
    observation.connectionEpoch !== state.connectionEpoch
  ) {
    return undefined;
  }
  return observation.value;
}
