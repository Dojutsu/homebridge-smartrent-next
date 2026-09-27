import { createGuardrails, generate } from 'otplib';
import { PhoenixSocket, type SocketFactory } from './phoenix-socket.js';
import { SmartRentTransportError, statusError } from './errors.js';
import type {
  ConnectionChange,
  CredentialsProvider,
  DeviceAttribute,
  DeviceEvent,
  SmartRentDevice,
  SmartRentTransport,
  TotpGenerator,
} from './types.js';

type Fetcher = typeof fetch;
type JsonObject = Record<string, unknown>;

export interface SmartRentProtocolOptions {
  credentials: CredentialsProvider;
  authBaseUrl?: string;
  apiBaseUrl?: string;
  socketUrl?: string;
  fetcher?: Fetcher;
  socketFactory?: SocketFactory;
  totpGenerator?: TotpGenerator;
  timeoutMs?: number;
  warn?: (message: string) => void;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : undefined;
}

function normalizeDevice(
  value: unknown,
  hubIdFallback?: string,
): SmartRentDevice {
  if (!isObject(value))
    throw new SmartRentTransportError('Malformed device response');
  const id = asString(value.id);
  const room = isObject(value.room) ? value.room : undefined;
  const hubId = asString(room?.hub_id) ?? hubIdFallback;
  if (
    !id ||
    !hubId ||
    typeof value.name !== 'string' ||
    typeof value.type !== 'string'
  ) {
    throw new SmartRentTransportError(
      'Device response is missing required fields',
    );
  }
  const attributes: Record<string, unknown> = {};
  if (Array.isArray(value.attributes)) {
    for (const item of value.attributes) {
      if (isObject(item) && typeof item.name === 'string' && 'state' in item) {
        attributes[item.name] = item.state;
      }
    }
  }
  const batteryLevel = value.battery_level;
  return {
    id,
    hubId,
    name: value.name,
    type: value.type,
    online: typeof value.online === 'boolean' ? value.online : null,
    attributes,
    ...(typeof value.updated_at === 'string'
      ? { updatedAt: value.updated_at }
      : {}),
    ...(typeof batteryLevel === 'number' || batteryLevel === null
      ? { batteryLevel }
      : {}),
    ...(typeof value.battery_powered === 'boolean' ||
    value.battery_powered === null
      ? { batteryPowered: value.battery_powered }
      : {}),
  };
}

async function defaultTotp(secret: string): Promise<string> {
  return generate({
    secret,
    guardrails: createGuardrails({ MIN_SECRET_BYTES: 10 }),
  });
}

export class SmartRentProtocolTransport implements SmartRentTransport {
  private readonly fetcher: Fetcher;
  private readonly authBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly socketUrl: string;
  private readonly timeoutMs: number;
  private readonly warn: (message: string) => void;
  private readonly totpGenerator: TotpGenerator;
  private accessToken: string | undefined;
  private tokenExpiresAt: number | undefined;
  private tfaApiToken: string | undefined;
  private authInFlight: Promise<void> | undefined;
  private readonly hubs = new Map<string, string>();
  private readonly deviceListeners = new Set<
    (event: DeviceEvent, epoch: number) => void
  >();
  private readonly connectionListeners = new Set<
    (change: ConnectionChange) => void
  >();
  private readonly socket: PhoenixSocket;

  constructor(private readonly options: SmartRentProtocolOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.authBaseUrl = (
      options.authBaseUrl ?? 'https://control.smartrent.com'
    ).replace(/\/$/, '');
    this.apiBaseUrl = (
      options.apiBaseUrl ?? 'https://control.smartrent.com/api/v3'
    ).replace(/\/$/, '');
    this.socketUrl =
      options.socketUrl ?? 'wss://control.smartrent.com/socket/websocket';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.warn = options.warn ?? (() => undefined);
    this.totpGenerator = options.totpGenerator ?? defaultTotp;
    this.socket = new PhoenixSocket({
      socketUrl: this.socketUrl,
      ...(options.socketFactory
        ? { socketFactory: options.socketFactory }
        : {}),
      onDeviceEvent: (event, epoch) =>
        this.deviceListeners.forEach((listener) => listener(event, epoch)),
      onConnectionChange: (change) =>
        this.connectionListeners.forEach((listener) => listener(change)),
      warn: this.warn,
    });
  }

  async authenticate(): Promise<void> {
    if (this.authInFlight) return this.authInFlight;
    this.authInFlight = this.performAuthentication().finally(() => {
      this.authInFlight = undefined;
    });
    return this.authInFlight;
  }

  async completeTotp(tfaApiToken: string, code: string): Promise<void> {
    const form = new URLSearchParams({
      tfa_api_token: tfaApiToken,
      token: code,
    });
    const data = await this.requestJson(
      `${this.authBaseUrl}/authentication/sessions/tfa`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: form,
      },
      'POST',
    );
    const token =
      isObject(data) && isObject(data.data)
        ? data.data.access_token
        : undefined;
    if (typeof token !== 'string')
      throw new SmartRentTransportError(
        'TOTP authentication response did not contain an access token',
      );
    this.storeAccessToken(token);
    this.tfaApiToken = undefined;
  }

  async refreshOrReauthenticate(): Promise<void> {
    this.accessToken = undefined;
    this.tokenExpiresAt = undefined;
    await this.authenticate();
  }

  async discoverDevices(): Promise<SmartRentDevice[]> {
    const unitsResponse = await this.getJson('/units');
    const unitRecords =
      isObject(unitsResponse) && Array.isArray(unitsResponse.records)
        ? unitsResponse.records
        : isObject(unitsResponse) &&
            isObject(unitsResponse.data) &&
            Array.isArray(unitsResponse.data.records)
          ? unitsResponse.data.records
          : undefined;
    if (!unitRecords)
      throw new SmartRentTransportError('Malformed unit discovery response');
    const devices: SmartRentDevice[] = [];
    for (const unit of unitRecords) {
      if (!isObject(unit)) continue;
      const hubId = asString(unit.hub_id);
      if (!hubId) continue;
      const list = await this.getJson(
        `/hubs/${encodeURIComponent(hubId)}/devices`,
      );
      const deviceRecords = Array.isArray(list)
        ? list
        : isObject(list) && Array.isArray(list.data)
          ? list.data
          : undefined;
      if (!deviceRecords)
        throw new SmartRentTransportError(
          'Malformed device discovery response',
        );
      for (const record of deviceRecords) {
        const device = normalizeDevice(record, hubId);
        this.hubs.set(device.id, device.hubId);
        devices.push(device);
      }
    }
    return devices;
  }

  async getDeviceState(deviceId: string): Promise<SmartRentDevice> {
    const hubId = this.hubs.get(deviceId);
    if (!hubId)
      throw new SmartRentTransportError('Unknown SmartRent device ID');
    const result = await this.getJson(
      `/hubs/${encodeURIComponent(hubId)}/devices/${encodeURIComponent(deviceId)}`,
    );
    return normalizeDevice(
      isObject(result) && 'data' in result ? result.data : result,
      hubId,
    );
  }

  async setDeviceAttributes(
    deviceId: string,
    attributes: DeviceAttribute[],
  ): Promise<{ accepted: true }> {
    const hubId = this.hubs.get(deviceId);
    if (!hubId)
      throw new SmartRentTransportError('Unknown SmartRent device ID');
    const body = {
      attributes: attributes.map((attribute) => ({
        name: attribute.name,
        state:
          typeof attribute.state === 'boolean' ||
          typeof attribute.state === 'number'
            ? String(attribute.state)
            : attribute.state,
      })),
    };
    // Physical commands are sent once. Unlike idempotent reads, a write is never retried.
    await this.authenticatedWrite(
      `${this.apiBaseUrl}/hubs/${encodeURIComponent(hubId)}/devices/${encodeURIComponent(deviceId)}`,
      body,
    );
    return { accepted: true };
  }

  async connect(): Promise<number> {
    await this.ensureAuthenticated();
    const tokenUrl = `${this.authBaseUrl}/api/v1/authentication/websocket-token`;
    let response: Response;
    try {
      response = await this.authRequest(tokenUrl, 'POST');
    } catch (error) {
      if (!(error instanceof SmartRentTransportError) || error.status !== 401)
        throw error;
      await this.refreshOrReauthenticate();
      response = await this.authRequest(tokenUrl, 'POST');
    }
    const data: unknown = await response.json();
    const token =
      isObject(data) && typeof data.token === 'string' ? data.token : undefined;
    if (!token)
      throw new SmartRentTransportError(
        'WebSocket token response was malformed',
      );
    return this.socket.connect(token);
  }

  async joinChannel(deviceId: string): Promise<void> {
    await this.socket.joinChannel(deviceId);
  }

  async heartbeat(): Promise<void> {
    await this.socket.heartbeat();
  }

  async disconnect(): Promise<void> {
    await this.socket.disconnect('closed');
  }

  async reconnect(): Promise<number> {
    await this.disconnect();
    return this.connect();
  }

  onDeviceEvent(
    listener: (event: DeviceEvent, epoch: number) => void,
  ): () => void {
    this.deviceListeners.add(listener);
    return () => this.deviceListeners.delete(listener);
  }

  onConnectionChange(listener: (change: ConnectionChange) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  private async performAuthentication(): Promise<void> {
    const credentials = await this.options.credentials();
    const form = new URLSearchParams({
      email: credentials.email,
      password: credentials.password,
    });
    const data = await this.requestJson(
      `${this.authBaseUrl}/authentication/sessions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: form,
      },
      'POST',
    );
    const sessionData =
      isObject(data) && isObject(data.data) ? data.data : undefined;
    if (typeof sessionData?.access_token === 'string') {
      this.storeAccessToken(sessionData.access_token);
      return;
    }
    if (typeof sessionData?.tfa_api_token !== 'string')
      throw new SmartRentTransportError(
        'Authentication response was malformed',
      );
    if (!credentials.totpSecret)
      throw new SmartRentTransportError(
        'SmartRent requires TOTP but no TOTP provider is configured',
      );
    this.tfaApiToken = sessionData.tfa_api_token;
    const code = await this.totpGenerator(credentials.totpSecret);
    await this.completeTotp(sessionData.tfa_api_token, code);
  }

  private storeAccessToken(token: string): void {
    this.accessToken = token;
    this.tokenExpiresAt = this.jwtExpiry(token);
  }

  private jwtExpiry(token: string): number | undefined {
    try {
      const payload = token.split('.')[1];
      if (!payload) return undefined;
      const parsed: unknown = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      );
      return isObject(parsed) && typeof parsed.exp === 'number'
        ? parsed.exp * 1000 - 60_000
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async ensureAuthenticated(): Promise<void> {
    if (
      !this.accessToken ||
      (this.tokenExpiresAt !== undefined && Date.now() >= this.tokenExpiresAt)
    ) {
      await this.authenticate();
    }
    if (!this.accessToken)
      throw new SmartRentTransportError('SmartRent authentication failed');
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.authRequest(`${this.apiBaseUrl}${path}`, 'GET');
    return response.json() as Promise<unknown>;
  }

  private async authRequest(
    url: string,
    method: 'GET' | 'POST',
  ): Promise<Response> {
    await this.ensureAuthenticated();
    const send = () =>
      this.fetcher(url, {
        method,
        headers: { authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    let response: Response;
    try {
      response = await send();
    } catch {
      throw new SmartRentTransportError(
        `SmartRent ${method} request failed or timed out`,
      );
    }
    if (response.status === 401 && method === 'GET') {
      await this.refreshOrReauthenticate();
      try {
        response = await send();
      } catch {
        throw new SmartRentTransportError(
          'SmartRent GET request failed or timed out',
        );
      }
    }
    if (!response.ok) throw statusError(response.status, method);
    return response;
  }

  private async authenticatedWrite(url: string, body: unknown): Promise<void> {
    await this.ensureAuthenticated();
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SmartRentTransportError(
        'SmartRent PATCH request failed or timed out',
      );
    }
    if (!response.ok) throw statusError(response.status, 'PATCH');
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    method: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SmartRentTransportError(
        `SmartRent ${method} request failed or timed out`,
      );
    }
    if (!response.ok) throw statusError(response.status, method);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new SmartRentTransportError(
        `SmartRent ${method} response was not valid JSON`,
      );
    }
  }
}
