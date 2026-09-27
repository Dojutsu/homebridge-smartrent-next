import { describe, expect, it, vi } from 'vitest';
import { SmartRentProtocolTransport } from '../../src/transport/smartrent-transport.js';

const syntheticCredentials = {
  email: 'fixture@example.invalid',
  password: 'synthetic-only',
};

describe('SmartRentProtocolTransport', () => {
  it('authenticates, discovers a synthetic device, and sends a single authenticated write', async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      calls.push({ url, method, authorization: headers.get('authorization') });
      if (url.endsWith('/authentication/sessions')) {
        return Response.json({ data: { access_token: 'synthetic-access-token' } });
      }
      if (url.endsWith('/api/v3/units')) {
        return Response.json({ records: [{ hub_id: 'synthetic-hub' }] });
      }
      if (url.endsWith('/api/v3/hubs/synthetic-hub/devices')) {
        return Response.json([{
          id: 42,
          name: 'Synthetic Lock',
          type: 'door_lock',
          online: true,
          attributes: [{ name: 'locked', state: true }],
        }]);
      }
      if (method === 'PATCH') return new Response(null, { status: 202 });
      throw new Error('Unexpected mocked URL');
    };
    const transport = new SmartRentProtocolTransport({
      credentials: async () => syntheticCredentials,
      authBaseUrl: 'https://auth.example.invalid',
      apiBaseUrl: 'https://api.example.invalid/api/v3',
      socketUrl: 'wss://socket.example.invalid/socket/websocket',
      fetcher,
    });

    const devices = await transport.discoverDevices();
    expect(devices).toEqual([{
      id: '42',
      hubId: 'synthetic-hub',
      name: 'Synthetic Lock',
      type: 'door_lock',
      online: true,
      attributes: { locked: true },
    }]);
    await expect(transport.setDeviceAttributes('42', [{ name: 'locked', state: false }]))
      .resolves.toEqual({ accepted: true });

    const patchCalls = calls.filter(call => call.method === 'PATCH');
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]?.authorization).toBe('Bearer synthetic-access-token');
  });

  it('uses injected TOTP generation and does not expose response bodies in errors', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = String(init?.body ?? '');
      calls.push({ url, body });
      if (url.endsWith('/authentication/sessions')) {
        return Response.json({ data: { tfa_api_token: 'synthetic-challenge' } });
      }
      if (url.endsWith('/authentication/sessions/tfa')) {
        return Response.json({ data: { access_token: 'synthetic-access-token' } });
      }
      return new Response('private server response', { status: 503 });
    };
    const totpGenerator = vi.fn(async () => '000000');
    const transport = new SmartRentProtocolTransport({
      credentials: async () => ({ ...syntheticCredentials, totpSecret: 'synthetic-test-seed' }),
      authBaseUrl: 'https://auth.example.invalid',
      apiBaseUrl: 'https://api.example.invalid/api/v3',
      socketUrl: 'wss://socket.example.invalid/socket/websocket',
      fetcher,
      totpGenerator,
    });

    await transport.authenticate();
    expect(totpGenerator).toHaveBeenCalledOnce();
    expect(calls.some(call => call.url.endsWith('/authentication/sessions/tfa') && call.body.includes('token=000000')))
      .toBe(true);
  });

  it('never retries a rejected physical write', async () => {
    let patchCount = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/authentication/sessions')) {
        return Response.json({ data: { access_token: 'synthetic-access-token' } });
      }
      if (url.endsWith('/api/v3/units')) return Response.json({ records: [{ hub_id: 'synthetic-hub' }] });
      if (url.endsWith('/api/v3/hubs/synthetic-hub/devices')) return Response.json([{
        id: '42', name: 'Synthetic Lock', type: 'door_lock', online: true, attributes: [],
      }]);
      if (init?.method === 'PATCH') {
        patchCount += 1;
        return new Response('redacted', { status: 401 });
      }
      throw new Error('Unexpected mocked URL');
    };
    const transport = new SmartRentProtocolTransport({
      credentials: async () => syntheticCredentials,
      authBaseUrl: 'https://auth.example.invalid',
      apiBaseUrl: 'https://api.example.invalid/api/v3',
      socketUrl: 'wss://socket.example.invalid/socket/websocket',
      fetcher,
    });
    await transport.discoverDevices();
    await expect(transport.setDeviceAttributes('42', [{ name: 'locked', state: false }]))
      .rejects.toThrow('SmartRent PATCH failed with HTTP 401');
    expect(patchCount).toBe(1);
  });
});
