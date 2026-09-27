import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ConnectionSupervisor } from '../../src/connection/supervisor.js';
import {
  StateReducer,
  readAuthoritativeAttribute,
} from '../../src/state/model.js';
import { SmartRentProtocolTransport } from '../../src/transport/smartrent-transport.js';
import type {
  SmartRentProtocolOptions,
  SmartRentTransportMode,
} from '../../src/transport/smartrent-transport.js';
import { runAccountValidation } from '../../src/validation/account-validator.js';
import { FakeSmartRentServer } from '../support/fake-smartrent-server.js';

const syntheticCredentials = {
  email: 'synthetic@example.invalid',
  password: 'synthetic-fixture-only',
};

const servers: FakeSmartRentServer[] = [];
const transports: SmartRentProtocolTransport[] = [];
const supervisors: ConnectionSupervisor[] = [];

async function createTransport(
  options: {
    requireTotp?: boolean;
    totpSecret?: string;
    mode?: SmartRentTransportMode;
  } = {},
): Promise<{
  server: FakeSmartRentServer;
  transport: SmartRentProtocolTransport;
  warnings: string[];
}> {
  const server = new FakeSmartRentServer({ requireTotp: options.requireTotp });
  await server.listen();
  servers.push(server);
  const warnings: string[] = [];
  const protocolOptions: SmartRentProtocolOptions = {
    credentials: async () => ({
      ...syntheticCredentials,
      ...(options.totpSecret ? { totpSecret: options.totpSecret } : {}),
    }),
    mode: options.mode ?? 'READ_ONLY',
    authBaseUrl: server.origin,
    apiBaseUrl: `${server.origin}/api/v3`,
    socketUrl: server.socketUrl,
    socketFactory: (url) => {
      const hostname = new URL(url).hostname;
      if (hostname !== '127.0.0.1')
        throw new Error('Non-loopback socket blocked in tests');
      return new WebSocket(url);
    },
    totpGenerator: async () => '000000',
    timeoutMs: 1_000,
    warn: (message) => warnings.push(message),
  };
  const transport = new SmartRentProtocolTransport(protocolOptions);
  transports.push(transport);
  return { server, transport, warnings };
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop();
  for (const transport of transports.splice(0)) await transport.disconnect();
  for (const server of servers.splice(0)) await server.close();
});

describe('SmartRent fake-server integration', () => {
  it('authenticates, discovers, reads, and treats PATCH acceptance as distinct from reported state', async () => {
    const { server, transport } = await createTransport({ mode: 'READ_WRITE' });
    const devices = await transport.discoverDevices();
    expect(devices.map(({ id }) => id)).toContain('synthetic-lock');

    const initial = await transport.getDeviceState('synthetic-lock');
    expect(initial.attributes.locked).toBe(true);

    await expect(
      transport.setDeviceAttributes('synthetic-lock', [
        { name: 'locked', state: false },
      ]),
    ).resolves.toEqual({ accepted: true });

    expect(server.patchRequests).toHaveLength(1);
    expect(server.patchRequests[0]?.attributes).toEqual([
      { name: 'locked', state: 'false' },
    ]);
    expect(server.getDevice('synthetic-lock')?.attributes[0]?.state).toBe(true);
  });

  it('runs the standalone account validator with TOTP and READ_ONLY transport, redacting synthetic identity and credentials', async () => {
    const server = new FakeSmartRentServer({ requireTotp: true });
    await server.listen();
    servers.push(server);
    const output: string[] = [];
    const environment: NodeJS.ProcessEnv = {
      SMARTRENT_VALIDATION_MODE: 'READ_ONLY',
      SMARTRENT_EMAIL: 'synthetic@example.invalid',
      SMARTRENT_PASSWORD: 'synthetic-fixture-only',
      SMARTRENT_TOTP_SECRET: 'synthetic-totp-seed',
      SMARTRENT_LOCK_DEVICE_ID: 'synthetic-lock',
      SMARTRENT_THERMOSTAT_DEVICE_ID: 'synthetic-thermostat',
      SMARTRENT_WASHER_LEAK_DEVICE_ID: 'synthetic-washer-leak',
      SMARTRENT_KITCHEN_LEAK_DEVICE_ID: 'synthetic-kitchen-leak',
      SMARTRENT_OBSERVE_SECONDS: '1',
    };

    const validation = runAccountValidation({
      environment,
      output: (line) => output.push(line),
      transportFactory: (settings) => {
        const transport = new SmartRentProtocolTransport({
          ...settings,
          authBaseUrl: server.origin,
          apiBaseUrl: `${server.origin}/api/v3`,
          socketUrl: server.socketUrl,
          socketFactory: (url) => {
            if (new URL(url).hostname !== '127.0.0.1') {
              throw new Error('Non-loopback socket blocked in test');
            }
            return new WebSocket(url);
          },
          totpGenerator: async () => '000000',
          timeoutMs: 1_000,
          warn: () => undefined,
        });
        transports.push(transport);
        return transport;
      },
    });
    await vi.waitFor(() => expect(server.joinCount).toBe(4));
    server.emitAttribute('synthetic-lock', 'locked', true);
    await validation;

    const report = output.join('\n');
    for (const sensitive of [
      'synthetic@example.invalid',
      'synthetic-fixture-only',
      'synthetic-totp-seed',
      'synthetic-lock',
      'synthetic-thermostat',
      'synthetic-washer-leak',
      'synthetic-kitchen-leak',
      'Synthetic Front Door',
      'Synthetic Thermostat',
      'synthetic-access-',
      'synthetic-websocket-token',
    ]) {
      expect(report).not.toContain(sensitive);
    }
    expect(report).toContain('READ_ONLY mode');
    expect(report).toContain('TOTP required and completed in memory');
    expect(report).toContain('Phoenix heartbeat: 3/3 acknowledgements');
    expect(report).toContain(
      'Phoenix acknowledgement evidence: join=8; heartbeat=6; correlated successful responses=14/14',
    );
    expect(report).toContain(
      'nested-attribute_state/attribute_state_updated=1',
    );
    expect(report).toContain(
      'websocket=SECURED REST=SECURED comparison=matches REST baseline',
    );
    expect(report).toContain('Controlled client close: observed');
    expect(report).toContain(
      'Phoenix channels: all 4 devices joined and acknowledged',
    );
    expect(report).toContain('front-door');
    expect(report).toContain('thermostat');
    expect(report).toContain('washer-leak');
    expect(report).toContain('kitchen-leak');
    expect(server.sessionCount).toBe(1);
    expect(server.totpCount).toBe(1);
    expect(server.webSocketConnectionCount).toBe(2);
    expect(server.joinCount).toBe(8);
    expect(server.heartbeatCount).toBe(6);
    expect(server.patchAttemptCount).toBe(0);
    expect(server.patchRequests).toHaveLength(0);
  });

  it('completes the synthetic TOTP challenge without using real credentials', async () => {
    const { server, transport } = await createTransport({
      requireTotp: true,
      totpSecret: 'synthetic-totp-seed',
    });
    await transport.authenticate();
    expect(server.sessionCount).toBe(1);
    expect(server.totpCount).toBe(1);
    await expect(transport.discoverDevices()).resolves.toHaveLength(4);
  });

  it('joins Phoenix channels, acknowledges heartbeat, emits events, and ignores malformed frames', async () => {
    const { server, transport, warnings } = await createTransport();
    const events: Array<{
      deviceId: string;
      attribute: string;
      value: unknown;
      epoch: number;
    }> = [];
    const unsubscribe = transport.onDeviceEvent((event, epoch) => {
      events.push({ ...event, epoch });
    });
    await transport.discoverDevices();
    const epoch = await transport.connect();
    await transport.joinChannel('synthetic-lock');
    await transport.heartbeat();
    server.emitAttribute('synthetic-lock', 'locked', false);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      deviceId: 'synthetic-lock',
      attribute: 'locked',
      value: false,
      epoch,
    });

    server.sendMalformedFrame('{not-json');
    await vi.waitFor(() =>
      expect(warnings).toContain('Ignored malformed Phoenix message'),
    );
    server.setHeartbeatReplyStatus('error');
    await expect(transport.heartbeat()).rejects.toThrow(
      'Phoenix acknowledgement was not ok',
    );
    unsubscribe();
  });

  it('reauthenticates and retries an idempotent state read once after expiry', async () => {
    const { server, transport } = await createTransport();
    await transport.discoverDevices();
    const sessionsBeforeExpiry = server.sessionCount;
    server.expireAccessTokens();

    const state = await transport.getDeviceState('synthetic-lock');
    expect(state.attributes.locked).toBe(true);
    expect(server.sessionCount).toBe(sessionsBeforeExpiry + 1);
    expect(server.deviceReadRequests.get('synthetic-lock')).toBe(1);
  });

  it('never retries a physical PATCH when the server rejects its expired token', async () => {
    const { server, transport } = await createTransport({ mode: 'READ_WRITE' });
    await transport.discoverDevices();
    const sessionsBeforeExpiry = server.sessionCount;
    server.expireAccessTokens();

    await expect(
      transport.setDeviceAttributes('synthetic-lock', [
        { name: 'locked', state: false },
      ]),
    ).rejects.toThrow('SmartRent PATCH failed with HTTP 401');
    expect(server.patchAttemptCount).toBe(1);
    expect(server.patchRequests).toHaveLength(0);
    expect(server.sessionCount).toBe(sessionsBeforeExpiry);
  });

  it('reconciles once after channel acknowledgement and applies subsequent socket reports', async () => {
    const { server, transport } = await createTransport();
    const devices = await transport.discoverDevices();
    const lock = devices.find(({ id }) => id === 'synthetic-lock');
    if (!lock) throw new Error('Synthetic fixture lock missing');
    const reducer = new StateReducer();
    const supervisor = new ConnectionSupervisor({
      transport,
      reducer,
      deviceIds: [lock.id],
      heartbeatIntervalMs: 30_000,
    });
    supervisors.push(supervisor);
    await supervisor.start();

    expect(server.deviceReadRequests.get(lock.id)).toBe(1);
    expect(
      readAuthoritativeAttribute(reducer.getDevice(lock.id), 'locked'),
    ).toBe(true);
    server.emitAttribute(lock.id, 'locked', false);
    await vi.waitFor(() =>
      expect(
        readAuthoritativeAttribute(reducer.getDevice(lock.id), 'locked'),
      ).toBe(false),
    );
    expect(server.deviceReadRequests.get(lock.id)).toBe(1);
  });

  it('rejoins after disconnect and performs one read and one channel join for the new epoch', async () => {
    const { server, transport } = await createTransport();
    const devices = await transport.discoverDevices();
    const lock = devices.find(({ id }) => id === 'synthetic-lock');
    if (!lock) throw new Error('Synthetic fixture lock missing');
    const supervisor = new ConnectionSupervisor({
      transport,
      reducer: new StateReducer(),
      deviceIds: [lock.id],
      heartbeatIntervalMs: 30_000,
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
      random: () => 0.5,
    });
    supervisors.push(supervisor);
    await supervisor.start();
    expect(server.deviceReadRequests.get(lock.id)).toBe(1);
    server.disconnectClients();

    await vi.waitFor(() => {
      expect(server.webSocketConnectionCount).toBe(2);
      expect(server.joinCount).toBe(2);
      expect(server.deviceReadRequests.get(lock.id)).toBe(2);
    });
  });

  it('lets a newer WebSocket event win over a delayed stale REST snapshot and ignores older/duplicate reports', async () => {
    const { server, transport } = await createTransport();
    const devices = await transport.discoverDevices();
    const lock = devices.find(({ id }) => id === 'synthetic-lock');
    if (!lock) throw new Error('Synthetic fixture lock missing');
    const reducer = new StateReducer();
    const supervisor = new ConnectionSupervisor({
      transport,
      reducer,
      deviceIds: [lock.id],
      heartbeatIntervalMs: 30_000,
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
      random: () => 0.5,
    });
    supervisors.push(supervisor);
    await supervisor.start();
    expect(server.deviceReadRequests.get(lock.id)).toBe(1);

    server.delayNextDeviceRead(100);
    server.disconnectClients();
    await vi.waitFor(() =>
      expect(server.deviceReadRequests.get(lock.id)).toBe(2),
    );
    server.emitAttribute(lock.id, 'locked', false);
    await vi.waitFor(() =>
      expect(
        readAuthoritativeAttribute(reducer.getDevice(lock.id), 'locked'),
      ).toBe(false),
    );
    const generationAfterNewEvent = reducer.getDevice(lock.id).generation;

    server.sendAttributeEvent(
      lock.id,
      'locked',
      true,
      'older-event-id',
      '2026-08-31T23:59:59.000Z',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      readAuthoritativeAttribute(reducer.getDevice(lock.id), 'locked'),
    ).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(server.deviceReadRequests.get(lock.id)).toBe(2);
    expect(
      readAuthoritativeAttribute(reducer.getDevice(lock.id), 'locked'),
    ).toBe(false);

    server.sendAttributeEvent(
      lock.id,
      'locked',
      true,
      'duplicate-event-id',
      '2026-09-02T00:00:00.000Z',
    );
    await vi.waitFor(() =>
      expect(
        readAuthoritativeAttribute(reducer.getDevice(lock.id), 'locked'),
      ).toBe(true),
    );
    const generationAfterFirstCopy = reducer.getDevice(lock.id).generation;
    server.sendAttributeEvent(
      lock.id,
      'locked',
      false,
      'duplicate-event-id',
      '2026-09-03T00:00:00.000Z',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reducer.getDevice(lock.id).generation).toBe(
      generationAfterFirstCopy,
    );
    expect(generationAfterNewEvent).toBeLessThan(generationAfterFirstCopy);
    expect(
      readAuthoritativeAttribute(reducer.getDevice(lock.id), 'locked'),
    ).toBe(true);
  });
});
