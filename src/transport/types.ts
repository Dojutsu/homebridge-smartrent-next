export type AttributeValue = string | number | boolean | null;

export interface DeviceAttribute {
  name: string;
  state: AttributeValue;
}

export interface SmartRentDevice {
  id: string;
  hubId: string;
  name: string;
  type: string;
  online: boolean | null;
  attributes: Record<string, unknown>;
  updatedAt?: string;
  batteryLevel?: number | null;
  batteryPowered?: boolean | null;
}

export interface DeviceEvent {
  deviceId: string;
  eventId?: string;
  attribute: string;
  value: unknown;
  smartrentTimestamp?: string;
}

export interface ConnectionChange {
  connected: boolean;
  epoch: number;
  reason?: 'opened' | 'closed' | 'error' | 'replaced' | 'heartbeat-timeout';
}

export interface SmartRentCredentials {
  email: string;
  password: string;
  totpSecret?: string;
}

export type CredentialsProvider = () => Promise<SmartRentCredentials>;
export type TotpGenerator = (secret: string) => Promise<string>;

export interface RestFence {
  connectionEpoch: number;
  generationAtStart: number;
}

export interface SmartRentTransport {
  authenticate(): Promise<void>;
  completeTotp(tfaApiToken: string, code: string): Promise<void>;
  refreshOrReauthenticate(): Promise<void>;
  discoverDevices(): Promise<SmartRentDevice[]>;
  getDeviceState(deviceId: string): Promise<SmartRentDevice>;
  setDeviceAttributes(
    deviceId: string,
    attributes: DeviceAttribute[],
  ): Promise<{ accepted: true }>;
  connect(): Promise<number>;
  joinChannel(deviceId: string): Promise<void>;
  heartbeat(): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<number>;
  onDeviceEvent(listener: (event: DeviceEvent, epoch: number) => void): () => void;
  onConnectionChange(listener: (change: ConnectionChange) => void): () => void;
}

