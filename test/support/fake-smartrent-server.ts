import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

interface FakeAttribute {
  id: number;
  name: string;
  state: unknown;
  last_read_state_changed_at: string;
}

interface FakeDevice {
  id: string;
  name: string;
  type: string;
  online: boolean;
  room: { hub_id: string };
  attributes: FakeAttribute[];
  battery_level: number;
  updated_at: string;
}

export interface FakeServerOptions {
  requireTotp?: boolean;
}

export class FakeSmartRentServer {
  private readonly httpServer = createServer((request, response) => {
    void this.handleHttp(request, response);
  });
  private readonly webSocketServer = new WebSocketServer({ noServer: true });
  private readonly sockets = new Set<WebSocket>();
  private readonly devices = new Map<string, FakeDevice>();
  private readonly validTokens = new Set<string>();
  private tokenSequence = 0;
  private eventSequence = 0;
  private webSocketToken = 'synthetic-websocket-token';
  private heartbeatReplyStatus = 'ok';
  private nextDeviceReadDelayMs = 0;
  private readonly options: FakeServerOptions;
  private address = '';
  sessionCount = 0;
  totpCount = 0;
  discoveryCount = 0;
  patchAttemptCount = 0;
  patchRequests: Array<{
    deviceId: string;
    attributes: Array<{ name: string; state: unknown }>;
  }> = [];
  deviceReadRequests = new Map<string, number>();
  joinCount = 0;
  heartbeatCount = 0;
  webSocketConnectionCount = 0;

  constructor(options: FakeServerOptions = {}) {
    this.options = options;
    this.devices.set('synthetic-lock', {
      id: 'synthetic-lock',
      name: 'Synthetic Front Door',
      type: 'entry_control',
      online: true,
      room: { hub_id: 'synthetic-hub' },
      attributes: [this.attribute('locked', true)],
      battery_level: 81,
      updated_at: '2026-09-01T00:00:01.000Z',
    });
    this.devices.set('synthetic-thermostat', {
      id: 'synthetic-thermostat',
      name: 'Synthetic Thermostat',
      type: 'thermostat',
      online: true,
      room: { hub_id: 'synthetic-hub' },
      attributes: [
        this.attribute('mode', 'heat'),
        this.attribute('operating_state', 'idle'),
        this.attribute('current_temp', '68'),
        this.attribute('current_humidity', '47'),
        this.attribute('heating_setpoint', '70'),
        this.attribute('cooling_setpoint', '76'),
      ],
      battery_level: 0,
      updated_at: '2026-09-01T00:00:01.000Z',
    });
    this.devices.set('synthetic-washer-leak', {
      id: 'synthetic-washer-leak',
      name: 'Synthetic Washer Leak Sensor',
      type: 'sensor_notification',
      online: true,
      room: { hub_id: 'synthetic-hub' },
      attributes: [this.attribute('leak', false)],
      battery_level: 72,
      updated_at: '2026-09-01T00:00:01.000Z',
    });
    this.devices.set('synthetic-kitchen-leak', {
      id: 'synthetic-kitchen-leak',
      name: 'Synthetic Kitchen Sink Leak Sensor',
      type: 'sensor_notification',
      online: true,
      room: { hub_id: 'synthetic-hub' },
      attributes: [this.attribute('leak', false)],
      battery_level: 64,
      updated_at: '2026-09-01T00:00:01.000Z',
    });

    this.httpServer.on('upgrade', (request, socket, head) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname !== '/socket/websocket') {
        socket.destroy();
        return;
      }
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit('connection', webSocket, request);
      });
    });
    this.webSocketServer.on('connection', (socket, request) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.searchParams.get('token') !== this.webSocketToken) {
        socket.close(1008, 'invalid synthetic token');
        return;
      }
      this.sockets.add(socket);
      this.webSocketConnectionCount += 1;
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('message', (data) =>
        this.handlePhoenixFrame(socket, data.toString()),
      );
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(0, '127.0.0.1', () => {
        this.httpServer.off('error', reject);
        const serverAddress = this.httpServer.address() as AddressInfo;
        this.address = `http://127.0.0.1:${serverAddress.port}`;
        resolve();
      });
    });
  }

  get origin(): string {
    if (!this.address)
      throw new Error('Fake SmartRent server is not listening');
    return this.address;
  }

  get socketUrl(): string {
    return this.origin.replace(/^http:/, 'ws:') + '/socket/websocket';
  }

  expireAccessTokens(): void {
    this.validTokens.clear();
  }

  setHeartbeatReplyStatus(status: string): void {
    this.heartbeatReplyStatus = status;
  }

  delayNextDeviceRead(milliseconds: number): void {
    this.nextDeviceReadDelayMs = Math.max(0, milliseconds);
  }

  disconnectClients(): void {
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1012, 'synthetic server restart');
      }
    }
  }

  getDevice(deviceId: string): Readonly<FakeDevice> | undefined {
    const device = this.devices.get(deviceId);
    return device ? structuredClone(device) : undefined;
  }

  emitAttribute(deviceId: string, name: string, state: unknown): void {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error('Unknown synthetic device');
    const attribute = this.attribute(name, state);
    const existing = device.attributes.findIndex(
      (candidate) => candidate.name === name,
    );
    if (existing < 0) device.attributes.push(attribute);
    else device.attributes[existing] = attribute;
    device.updated_at = attribute.last_read_state_changed_at;
    const payload = {
      attribute_state: {
        id: attribute.id,
        name,
        last_read_state: state,
        last_read_state_changed_at: attribute.last_read_state_changed_at,
      },
    };
    this.broadcast([
      null,
      null,
      `devices:${deviceId}`,
      'attribute_state_updated',
      payload,
    ]);
  }

  sendAttributeEvent(
    deviceId: string,
    name: string,
    state: unknown,
    eventId: number | string,
    timestamp: string,
  ): void {
    this.broadcast([
      null,
      null,
      `devices:${deviceId}`,
      'attribute_state_updated',
      {
        attribute_state: {
          id: eventId,
          name,
          last_read_state: state,
          last_read_state_changed_at: timestamp,
        },
      },
    ]);
  }

  sendMalformedFrame(value: string): void {
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(value);
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    await new Promise<void>((resolve) =>
      this.webSocketServer.close(() => resolve()),
    );
    if (this.httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', this.origin);
    const path = requestUrl.pathname;
    if (request.method === 'POST' && path === '/authentication/sessions') {
      this.sessionCount += 1;
      if (this.options.requireTotp) {
        this.sendJson(response, 200, {
          data: { tfa_api_token: 'synthetic-tfa-challenge' },
        });
        return;
      }
      this.sendJson(response, 200, {
        data: { access_token: this.issueAccessToken() },
      });
      return;
    }
    if (request.method === 'POST' && path === '/authentication/sessions/tfa') {
      this.totpCount += 1;
      const form = new URLSearchParams(await this.readBody(request));
      if (
        form.get('tfa_api_token') !== 'synthetic-tfa-challenge' ||
        form.get('token') !== '000000'
      ) {
        this.sendJson(response, 401, { error: 'synthetic TOTP rejected' });
        return;
      }
      this.sendJson(response, 200, {
        data: { access_token: this.issueAccessToken() },
      });
      return;
    }
    if (path.startsWith('/api/') && !this.isAuthorized(request)) {
      if (request.method === 'PATCH' && /\/devices\/[^/]+$/.test(path)) {
        this.patchAttemptCount += 1;
      }
      this.sendJson(response, 401, { error: 'synthetic unauthorized' });
      return;
    }
    if (
      request.method === 'POST' &&
      path === '/api/v1/authentication/websocket-token'
    ) {
      this.sendJson(response, 200, { token: this.webSocketToken });
      return;
    }
    if (request.method === 'GET' && path === '/api/v3/units') {
      this.discoveryCount += 1;
      this.sendJson(response, 200, { records: [{ hub_id: 'synthetic-hub' }] });
      return;
    }
    if (
      request.method === 'GET' &&
      path === '/api/v3/hubs/synthetic-hub/devices'
    ) {
      this.sendJson(response, 200, [...this.devices.values()]);
      return;
    }
    const deviceMatch = path.match(
      /^\/api\/v3\/hubs\/synthetic-hub\/devices\/([^/]+)$/,
    );
    if (deviceMatch && request.method === 'GET') {
      const deviceId = decodeURIComponent(deviceMatch[1] ?? '');
      this.deviceReadRequests.set(
        deviceId,
        (this.deviceReadRequests.get(deviceId) ?? 0) + 1,
      );
      const device = this.devices.get(deviceId);
      if (!device) {
        this.sendJson(response, 404, { error: 'synthetic device missing' });
        return;
      }
      const snapshot = structuredClone(device);
      const delay = this.nextDeviceReadDelayMs;
      this.nextDeviceReadDelayMs = 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      this.sendJson(response, 200, { data: snapshot });
      return;
    }
    if (deviceMatch && request.method === 'PATCH') {
      const deviceId = decodeURIComponent(deviceMatch[1] ?? '');
      const body = JSON.parse(await this.readBody(request)) as {
        attributes?: Array<{ name: string; state: unknown }>;
      };
      this.patchRequests.push({ deviceId, attributes: body.attributes ?? [] });
      // Acceptance deliberately does not mutate reported state.
      response.writeHead(202);
      response.end();
      return;
    }
    this.sendJson(response, 404, { error: 'synthetic route missing' });
  }

  private handlePhoenixFrame(socket: WebSocket, raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || frame.length < 5) return;
    const [joinRef, ref, topic, eventName] = frame;
    if (
      typeof ref !== 'string' ||
      typeof topic !== 'string' ||
      typeof eventName !== 'string'
    )
      return;
    if (eventName === 'phx_join') this.joinCount += 1;
    if (eventName === 'heartbeat') this.heartbeatCount += 1;
    const status = eventName === 'heartbeat' ? this.heartbeatReplyStatus : 'ok';
    socket.send(
      JSON.stringify([
        joinRef,
        ref,
        topic,
        'phx_reply',
        { status, response: {} },
      ]),
    );
  }

  private broadcast(frame: unknown[]): void {
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(frame));
    }
  }

  private issueAccessToken(): string {
    const token = `synthetic-access-${++this.tokenSequence}`;
    this.validTokens.add(token);
    return token;
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    if (
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ')
    )
      return false;
    return this.validTokens.has(authorization.slice('Bearer '.length));
  }

  private attribute(name: string, state: unknown): FakeAttribute {
    this.eventSequence += 1;
    return {
      id: this.eventSequence,
      name,
      state,
      last_read_state_changed_at: new Date(
        Date.UTC(2026, 8, 1, 0, 0, this.eventSequence),
      ).toISOString(),
    };
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    value: unknown,
  ): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  }
}
