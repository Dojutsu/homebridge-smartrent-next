import { describe, expect, it } from 'vitest';
import {
  readAuthoritativeAttribute,
  StateReducer,
} from '../../src/state/model.js';

const lockId = 'synthetic-lock-1';

function baseline(
  reducer = new StateReducer(),
  value: unknown = true,
): StateReducer {
  reducer.registerDevice(lockId);
  const fence = reducer.captureRestFence(lockId);
  reducer.applyRestSnapshot(
    lockId,
    fence,
    {
      online: true,
      attributes: { locked: value },
      smartrentTimestamp: '2026-01-01T00:00:00.000Z',
    },
    100,
  );
  return reducer;
}

describe('StateReducer', () => {
  it('accepts explicit report values and keeps source and generation metadata', () => {
    const reducer = baseline();
    const state = reducer.getDevice(lockId);
    expect(readAuthoritativeAttribute(state, 'locked')).toBe(true);
    expect(state.attributes.locked).toMatchObject({
      source: 'rest',
      receivedAt: 100,
      freshness: 'fresh',
    });
  });

  it('does not let a REST response started before a WebSocket event overwrite it', () => {
    const reducer = baseline();
    const fence = reducer.captureRestFence(lockId);
    reducer.applyEvent(
      lockId,
      'locked',
      false,
      0,
      200,
      'evt-2',
      '2026-01-01T00:00:02.000Z',
    );
    const result = reducer.applyRestSnapshot(
      lockId,
      fence,
      {
        online: true,
        attributes: { locked: true },
        smartrentTimestamp: '2026-01-01T00:00:01.000Z',
      },
      300,
    );
    expect(result.kind).toBe('stale');
    expect(readAuthoritativeAttribute(result.state, 'locked')).toBe(false);
  });

  it('rejects a REST snapshot whose SmartRent timestamp predates the report', () => {
    const reducer = baseline();
    reducer.applyEvent(
      lockId,
      'locked',
      false,
      0,
      200,
      'evt-2',
      '2026-01-01T00:00:02.000Z',
    );
    const fence = reducer.captureRestFence(lockId);
    const result = reducer.applyRestSnapshot(
      lockId,
      fence,
      {
        online: true,
        attributes: { locked: true },
        smartrentTimestamp: '2026-01-01T00:00:01.000Z',
      },
      300,
    );
    expect(result.kind).toBe('accepted');
    expect(readAuthoritativeAttribute(result.state, 'locked')).toBe(false);
  });

  it('ignores reports from older connection epochs', () => {
    const reducer = baseline();
    expect(reducer.startConnectionEpoch(4)).toBe(true);
    reducer.setConnection(true, 4);
    const result = reducer.applyEvent(
      lockId,
      'locked',
      false,
      3,
      200,
      'old-epoch',
    );
    expect(result.kind).toBe('ignored');
    expect(readAuthoritativeAttribute(result.state, 'locked')).toBeUndefined();
  });

  it('deduplicates events by event ID', () => {
    const reducer = baseline();
    reducer.applyEvent(
      lockId,
      'locked',
      false,
      0,
      200,
      'same-event',
      '2026-01-01T00:00:02.000Z',
    );
    const result = reducer.applyEvent(
      lockId,
      'locked',
      true,
      0,
      300,
      'same-event',
      '2026-01-01T00:00:03.000Z',
    );
    expect(result.kind).toBe('duplicate');
    expect(readAuthoritativeAttribute(result.state, 'locked')).toBe(false);
  });

  it('ignores timestamped out-of-order events', () => {
    const reducer = baseline();
    reducer.applyEvent(
      lockId,
      'locked',
      false,
      0,
      200,
      'new',
      '2026-01-01T00:00:03.000Z',
    );
    const result = reducer.applyEvent(
      lockId,
      'locked',
      true,
      0,
      300,
      'old',
      '2026-01-01T00:00:02.000Z',
    );
    expect(result.kind).toBe('stale');
    expect(readAuthoritativeAttribute(result.state, 'locked')).toBe(false);
  });

  it('marks equal-timestamp conflicting reports unknown', () => {
    const reducer = baseline();
    const result = reducer.applyEvent(
      lockId,
      'locked',
      false,
      0,
      200,
      'conflict',
      '2026-01-01T00:00:00.000Z',
    );
    expect(result.kind).toBe('conflict');
    expect(result.state.fault).toBe('conflicting-timestamp');
    expect(readAuthoritativeAttribute(result.state, 'locked')).toBeUndefined();
  });

  it('records target and accepted status without changing reported state', () => {
    const reducer = baseline();
    reducer.recordRequested(lockId, 'locked', false, 'cmd-1', 200);
    reducer.markCommandAccepted(lockId, 'locked', 'cmd-1');
    const state = reducer.getDevice(lockId);
    expect(state.requested.locked).toMatchObject({
      value: false,
      status: 'accepted',
    });
    expect(readAuthoritativeAttribute(state, 'locked')).toBe(true);
  });

  it('does not let a delayed contradictory report clear a newer requested target', () => {
    const reducer = baseline();
    reducer.recordRequested(lockId, 'locked', false, 'cmd-1', 200);
    reducer.markCommandAccepted(lockId, 'locked', 'cmd-1');
    reducer.recordRequested(lockId, 'locked', true, 'cmd-2', 300);
    const oldReport = reducer.applyEvent(
      lockId,
      'locked',
      false,
      0,
      400,
      'old-command-report',
    );
    expect(oldReport.state.requested.locked).toMatchObject({
      value: true,
      commandId: 'cmd-2',
    });
    const currentReport = reducer.applyEvent(
      lockId,
      'locked',
      true,
      0,
      500,
      'new-command-report',
    );
    expect(currentReport.state.requested.locked).toBeUndefined();
  });

  it('marks an unconfirmed command unresolved and current state unknown', () => {
    const reducer = baseline();
    reducer.recordRequested(lockId, 'locked', false, 'cmd-1', 200);
    const state = reducer.markCommandUnresolved(lockId, 'locked', 'cmd-1');
    expect(state.requested.locked?.status).toBe('unresolved');
    expect(readAuthoritativeAttribute(state, 'locked')).toBeUndefined();
  });

  it('does not fabricate a value from malformed or missing state', () => {
    const reducer = baseline();
    const result = reducer.applyEvent(lockId, 'locked', null, 0, 200, 'bad');
    expect(result.state.attributes.locked?.freshness).toBe('unknown');
    expect(readAuthoritativeAttribute(result.state, 'locked')).toBeUndefined();
  });

  it('marks observations unknown when connectivity is lost', () => {
    const reducer = baseline();
    reducer.setConnection(false, 0);
    const state = reducer.getDevice(lockId);
    expect(state.online).toBe('offline');
    expect(state.fault).toBe('offline');
    expect(readAuthoritativeAttribute(state, 'locked')).toBeUndefined();
  });

  it('rejects overlapping reconnect generations', () => {
    const reducer = baseline();
    reducer.startConnectionEpoch(5);
    reducer.setConnection(true, 5);
    reducer.startConnectionEpoch(6);
    const old = reducer.applyEvent(
      lockId,
      'locked',
      true,
      5,
      200,
      'epoch-five',
    );
    expect(old.kind).toBe('ignored');
    expect(reducer.getDevice(lockId).connectionEpoch).toBe(6);
  });
});
