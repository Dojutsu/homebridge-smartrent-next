import { describe, expect, it } from 'vitest';
import { SmartRentTransportError } from '../../src/transport/errors.js';
import {
  formatSafeHttpDiagnostic,
  sanitizeHttpFailure,
} from '../../src/transport/http-diagnostics.js';
import { SmartRentProtocolTransport } from '../../src/transport/smartrent-transport.js';

const LEGACY_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15';

describe('safe HTTP diagnostics', () => {
  it('matches the known working login and TFA request schemas and headers', async () => {
    const requests: Array<{
      path: string;
      method: string;
      headers: Headers;
      body?: URLSearchParams;
    }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const body = init?.body;
      requests.push({
        path: url.pathname,
        method: init?.method ?? '',
        headers,
        ...(body instanceof URLSearchParams ? { body } : {}),
      });

      if (url.pathname === '/authentication/sessions') {
        return Response.json({
          data: { tfa_api_token: 'synthetic-tfa-challenge' },
        });
      }
      if (url.pathname === '/authentication/sessions/tfa') {
        return Response.json({ data: { access_token: 'synthetic-access' } });
      }
      if (url.pathname === '/api/v1/authentication/websocket-token') {
        return Response.json({ token: 'synthetic-websocket-token' });
      }
      throw new Error('Unexpected test request path');
    };
    const transport = new SmartRentProtocolTransport({
      credentials: async () => ({
        email: 'synthetic@example.invalid',
        password: 'synthetic-password-sentinel',
        totpSecret: 'synthetic-totp-secret',
      }),
      mode: 'DISCOVERY_ONLY',
      fetcher,
      totpGenerator: async () => '731204',
      socketFactory: () => {
        throw new Error('Test stops before creating a WebSocket');
      },
    });

    await transport.authenticate();
    await expect(transport.connect()).rejects.toThrow(
      'Test stops before creating a WebSocket',
    );

    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ['POST', '/authentication/sessions'],
      ['POST', '/authentication/sessions/tfa'],
      ['POST', '/api/v1/authentication/websocket-token'],
    ]);
    expect([...requests[0]!.body!.keys()].sort()).toEqual([
      'email',
      'password',
    ]);
    expect([...requests[1]!.body!.keys()].sort()).toEqual([
      'tfa_api_token',
      'token',
    ]);
    expect(requests[0]!.body!.has('token')).toBe(false);
    expect(requests[0]!.body!.has('tfa_api_token')).toBe(false);
    for (const request of requests) {
      expect(request.headers.get('user-agent')).toBe(LEGACY_USER_AGENT);
      expect(request.headers.get('accept')).toBe('*/*');
      expect(request.headers.get('accept-language')).toBe('en-US;q=1.0');
      expect(request.headers.get('accept-encoding')).toBe(
        'gzip;q=1.0, compress;q=0.5',
      );
      expect(request.headers.get('connection')).toBe('keep-alive');
      expect(request.headers.has('x-appversion')).toBe(false);
    }
    for (const request of requests.slice(0, 2)) {
      expect(request.headers.get('content-type')).toBe(
        'application/x-www-form-urlencoded; charset=utf-8',
      );
    }
    expect(requests[2]!.body).toBeUndefined();
  });

  it('identifies an AUTH_LOGIN 422 and excludes echoed credentials and tokens', async () => {
    const secretValues = [
      'synthetic@example.invalid',
      'synthetic-password-sentinel',
      'synthetic-totp-secret',
      'access-token-secret-sentinel',
      'websocket-token-secret-sentinel',
      'pairing-secret-sentinel',
    ];
    const fetcher: typeof fetch = async () =>
      Response.json(
        {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          errors: {
            email: [secretValues[0]],
            password: [secretValues[1]],
            token: [secretValues[2]],
            private_key: [secretValues[5]],
          },
          access_token: secretValues[3],
          session: secretValues[4],
          private_field: 'private-structure-sentinel',
        },
        { status: 422 },
      );
    const transport = createTransport(fetcher);

    const error = await transport.authenticate().catch((caught: unknown) => {
      expect(caught).toBeInstanceOf(SmartRentTransportError);
      return caught as SmartRentTransportError;
    });
    const diagnostic = error.diagnostic;
    expect(diagnostic).toMatchObject({
      operation: 'AUTH_LOGIN',
      method: 'POST',
      path: '/authentication/sessions',
      requestFields: ['email', 'password'],
      status: 422,
      responseFields: ['code', 'errors', 'message'],
      validationFields: ['email', 'password', 'token'],
      errorCategory: 'VALIDATION_ERROR',
      sanitizedError: 'VALIDATION_ERROR',
    });
    const report = formatSafeHttpDiagnostic(diagnostic!);
    for (const secret of [...secretValues, 'private-structure-sentinel']) {
      expect(report).not.toContain(secret);
    }
    expect(report).not.toContain('private_key');
    expect(report).not.toContain('access_token');
    expect(report).toContain('request fields: [email, password]');
  });

  it('identifies a TFA 422 separately from the initial login', async () => {
    let requestCount = 0;
    const fetcher: typeof fetch = async () => {
      requestCount += 1;
      return requestCount === 1
        ? Response.json({
            data: { tfa_api_token: 'synthetic-tfa-challenge' },
          })
        : Response.json(
            { error_code: 'INVALID_TOTP_CODE', message: 'Invalid TOTP code' },
            { status: 422 },
          );
    };
    const transport = createTransport(fetcher);

    const error = await transport.authenticate().catch((caught: unknown) => {
      expect(caught).toBeInstanceOf(SmartRentTransportError);
      return caught as SmartRentTransportError;
    });

    expect(error.diagnostic).toMatchObject({
      operation: 'AUTH_TFA',
      method: 'POST',
      path: '/authentication/sessions/tfa',
      requestFields: ['tfa_api_token', 'token'],
      status: 422,
      errorCategory: 'INVALID_TOTP',
      sanitizedError: 'INVALID_TOTP',
    });
    const report = formatSafeHttpDiagnostic(error.diagnostic!);
    for (const secret of [
      'synthetic@example.invalid',
      'synthetic-password-sentinel',
      'synthetic-totp-secret',
      'synthetic-tfa-challenge',
      '731204',
    ]) {
      expect(report).not.toContain(secret);
    }
  });

  it('suppresses unknown response structures and templates dynamic IDs out of paths', () => {
    const diagnostic = sanitizeHttpFailure(
      {
        privateResponseKey: 'private-response-sentinel',
        detail: 'private-detail-sentinel',
      },
      422,
      {
        operation: 'DEVICE_STATE',
        method: 'GET',
        requestFields: [],
        retryableRead: true,
      },
    );
    const report = formatSafeHttpDiagnostic(diagnostic);

    expect(diagnostic).toMatchObject({
      path: '/api/v3/hubs/:hubId/devices/:deviceId',
      responseFields: ['detail'],
      errorCategory: 'HTTP_UNPROCESSABLE_ENTITY',
      sanitizedError: 'suppressed',
      retryableRead: true,
    });
    expect(report).not.toContain('privateResponseKey');
    expect(report).not.toContain('private-response-sentinel');
    expect(report).not.toContain('private-detail-sentinel');
    expect(report).not.toContain('hubId-value');
    expect(report).not.toContain('deviceId-value');
  });
});

function createTransport(fetcher: typeof fetch): SmartRentProtocolTransport {
  return new SmartRentProtocolTransport({
    credentials: async () => ({
      email: 'synthetic@example.invalid',
      password: 'synthetic-password-sentinel',
      totpSecret: 'synthetic-totp-secret',
    }),
    mode: 'DISCOVERY_ONLY',
    fetcher,
    totpGenerator: async () => '731204',
  });
}
