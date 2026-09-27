import {
  APIEvent,
  type API,
  type DynamicPlatformPlugin,
  type Logging,
  type PlatformAccessory,
  type PlatformConfig,
} from 'homebridge';
import { ConnectionSupervisor } from '../connection/supervisor.js';
import { BatteryModel, BatteryServiceAdapter } from '../devices/battery.js';
import { LeakSensorAccessory } from '../devices/leak-sensor.js';
import { LockMechanismAccessory } from '../devices/lock.js';
import {
  ThermostatAccessory,
  type ThermostatUnit,
} from '../devices/thermostat.js';
import { RedactedDiagnosticLogger } from '../diagnostics/redacted-logger.js';
import { StateReducer } from '../state/model.js';
import type {
  SmartRentDevice,
  SmartRentTransport,
} from '../transport/types.js';

export const PLUGIN_NAME = '@dojutsu/homebridge-smartrent-next';
export const PLATFORM_NAME = 'SmartRentNext';

export type SmartRentRole =
  'lock' | 'thermostat' | 'washerLeak' | 'kitchenLeak';

export interface SmartRentPlatformConfig extends PlatformConfig {
  platform: typeof PLATFORM_NAME;
  unitName?: string;
  temperatureUnit?: ThermostatUnit;
  devices?: Partial<Record<SmartRentRole, string>>;
}

export interface SmartRentAccessoryContext {
  schemaVersion: 1;
  deviceId: string;
  role: SmartRentRole;
  alias: string;
}

export type SmartRentTransportFactory = () => SmartRentTransport;

const ROLE_CONFIG: ReadonlyArray<{ role: SmartRentRole; alias: string }> = [
  { role: 'lock', alias: 'Front Door' },
  { role: 'thermostat', alias: 'Thermostat' },
  { role: 'washerLeak', alias: 'Washer Leak Sensor' },
  { role: 'kitchenLeak', alias: 'Kitchen Sink Leak Sensor' },
];

interface AccessoryAdapter {
  refreshFromState(): void;
}

export class SmartRentPlatform implements DynamicPlatformPlugin {
  private readonly reducer = new StateReducer();
  private readonly diagnostics: RedactedDiagnosticLogger;
  private readonly transport: SmartRentTransport | undefined;
  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly adapters = new Map<string, AccessoryAdapter>();
  private readonly batteries = new Map<
    string,
    { model: BatteryModel; adapter: BatteryServiceAdapter }
  >();
  private supervisor: ConnectionSupervisor | undefined;
  private discoveryTimer: NodeJS.Timeout | undefined;
  private discoveryAttempts = 0;
  private bootstrapping = false;
  private stopped = false;

  constructor(
    private readonly log: Logging,
    private readonly config: SmartRentPlatformConfig,
    private readonly api: API,
    transportFactory?: SmartRentTransportFactory,
  ) {
    this.diagnostics = new RedactedDiagnosticLogger(log);
    this.transport = transportFactory?.();
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => void this.bootstrap());
    this.api.on(APIEvent.SHUTDOWN, () => void this.stop());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
    const metadata = parseAccessoryContext(accessory.context.smartRentNext);
    if (!metadata) return;
    this.reducer.registerDevice(metadata.deviceId);
    if (this.transport) this.attachAccessory(metadata, accessory);
  }

  private async bootstrap(): Promise<void> {
    if (this.stopped || this.bootstrapping) return;
    if (!this.transport) {
      this.log.info(
        '[SmartRentNext] SmartRent runtime is disabled until an authorized transport provider is configured',
      );
      return;
    }
    const configured = this.configuredDevices();
    if (configured.length === 0) {
      this.log.info(
        '[SmartRentNext] No device IDs configured; no SmartRent connection was started',
      );
      return;
    }

    this.bootstrapping = true;
    try {
      const devices = await this.transport.discoverDevices();
      if (this.stopped) return;
      this.discoveryAttempts = 0;
      const byId = new Map(devices.map((device) => [device.id, device]));
      const newAccessories: PlatformAccessory[] = [];
      const activeDeviceIds: string[] = [];

      for (const configuredDevice of configured) {
        const device = byId.get(configuredDevice.deviceId);
        const uuid = this.api.hap.uuid.generate(
          configuredDevice.deviceId.toString(),
        );
        const cached = this.cachedAccessories.get(uuid);
        if (!device) {
          if (cached) this.ensureCachedAdapter(configuredDevice, cached);
          this.log.warn(
            `[SmartRentNext] Configured ${configuredDevice.alias} was not found during discovery`,
          );
          continue;
        }

        const accessory =
          cached ??
          new this.api.platformAccessory(configuredDevice.alias, uuid);
        const metadata: SmartRentAccessoryContext = {
          schemaVersion: 1,
          deviceId: configuredDevice.deviceId,
          role: configuredDevice.role,
          alias: cached
            ? readCachedAlias(cached, configuredDevice.alias)
            : configuredDevice.alias,
        };
        this.storeAccessoryMetadata(accessory, metadata, !cached);
        this.reducer.registerDevice(device.id);
        const fence = this.reducer.captureRestFence(device.id);
        const result = this.reducer.applyRestSnapshot(
          device.id,
          fence,
          {
            online: device.online,
            attributes: snapshotAttributes(device),
            ...(device.updatedAt
              ? { smartrentTimestamp: device.updatedAt }
              : {}),
          },
          Date.now(),
        );
        this.attachAccessory(metadata, accessory);
        if (result.kind === 'accepted') this.handleStateChange(result.state);
        if (!cached) newAccessories.push(accessory);
        activeDeviceIds.push(device.id);
      }

      if (newAccessories.length > 0) {
        this.api.registerPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          newAccessories,
        );
      }
      if (activeDeviceIds.length > 0) {
        this.supervisor = new ConnectionSupervisor({
          transport: this.transport,
          reducer: this.reducer,
          deviceIds: activeDeviceIds,
          onStateChange: (state) => this.handleStateChange(state),
          onDiagnostic: (event) =>
            this.log.debug(`[SmartRentNext] connection ${event}`),
        });
        await this.supervisor.start();
      }
    } catch {
      if (!this.stopped) {
        this.log.warn(
          '[SmartRentNext] SmartRent discovery failed; a bounded retry was scheduled',
        );
        this.scheduleDiscoveryRetry();
      }
    } finally {
      this.bootstrapping = false;
    }
  }

  private configuredDevices(): Array<{
    role: SmartRentRole;
    deviceId: string;
    alias: string;
  }> {
    const configured: Array<{
      role: SmartRentRole;
      deviceId: string;
      alias: string;
    }> = [];
    const seen = new Set<string>();
    for (const { role, alias } of ROLE_CONFIG) {
      const deviceId = this.config.devices?.[role];
      if (typeof deviceId !== 'string' || deviceId.trim() === '') continue;
      const normalizedId = deviceId.trim();
      if (seen.has(normalizedId)) {
        this.log.warn(
          `[SmartRentNext] Duplicate device configuration for ${alias} was ignored`,
        );
        continue;
      }
      seen.add(normalizedId);
      configured.push({ role, deviceId: normalizedId, alias });
    }
    return configured;
  }

  private ensureCachedAdapter(
    configured: { role: SmartRentRole; deviceId: string; alias: string },
    accessory: PlatformAccessory,
  ): void {
    const metadata = parseAccessoryContext(accessory.context.smartRentNext) ?? {
      schemaVersion: 1 as const,
      deviceId: configured.deviceId,
      role: configured.role,
      alias: readCachedAlias(accessory, configured.alias),
    };
    this.storeAccessoryMetadata(accessory, metadata, false);
    this.attachAccessory(metadata, accessory);
  }

  private storeAccessoryMetadata(
    accessory: PlatformAccessory,
    metadata: SmartRentAccessoryContext,
    isNew: boolean,
  ): void {
    accessory.context.smartRentNext = metadata;
    if (isNew) accessory.updateDisplayName(metadata.alias);
    const info =
      accessory.getService(this.api.hap.Service.AccessoryInformation) ??
      accessory.addService(this.api.hap.Service.AccessoryInformation);
    info.setCharacteristic(
      this.api.hap.Characteristic.Manufacturer,
      'SmartRent',
    );
    info.setCharacteristic(
      this.api.hap.Characteristic.Model,
      roleModel(metadata.role),
    );
    info.setCharacteristic(
      this.api.hap.Characteristic.SerialNumber,
      metadata.deviceId,
    );
  }

  private attachAccessory(
    metadata: SmartRentAccessoryContext,
    accessory: PlatformAccessory,
  ): void {
    if (!this.transport || this.adapters.has(metadata.deviceId)) return;
    const alias = readCachedAlias(accessory, metadata.alias);
    this.reducer.registerDevice(metadata.deviceId);
    switch (metadata.role) {
      case 'lock':
        this.adapters.set(
          metadata.deviceId,
          new LockMechanismAccessory({
            alias,
            deviceId: metadata.deviceId,
            reducer: this.reducer,
            transport: this.transport,
            diagnostics: this.diagnostics,
            api: this.api.hap,
            accessory,
            logger: this.log,
          }),
        );
        break;
      case 'thermostat':
        this.adapters.set(
          metadata.deviceId,
          new ThermostatAccessory({
            alias,
            deviceId: metadata.deviceId,
            reducer: this.reducer,
            transport: this.transport,
            diagnostics: this.diagnostics,
            api: this.api.hap,
            accessory,
            logger: this.log,
            ...(this.config.temperatureUnit
              ? { temperatureUnit: this.config.temperatureUnit }
              : {}),
          }),
        );
        break;
      case 'washerLeak':
      case 'kitchenLeak':
        this.adapters.set(
          metadata.deviceId,
          new LeakSensorAccessory({
            alias,
            deviceId: metadata.deviceId,
            reducer: this.reducer,
            diagnostics: this.diagnostics,
            api: this.api.hap,
            accessory,
            logger: this.log,
          }),
        );
        break;
    }
    const batteryModel = new BatteryModel();
    this.batteries.set(metadata.deviceId, {
      model: batteryModel,
      adapter: new BatteryServiceAdapter({
        accessory,
        api: this.api.hap,
        model: batteryModel,
      }),
    });
  }

  private handleStateChange(
    state: ReturnType<StateReducer['getDevice']>,
  ): void {
    this.adapters.get(state.deviceId)?.refreshFromState();
    const battery = this.batteries.get(state.deviceId);
    if (!battery) return;
    const observation = state.attributes.battery_level;
    if (
      observation?.freshness === 'fresh' &&
      (observation.source === 'rest' || observation.source === 'websocket') &&
      observation.receivedAt !== undefined
    ) {
      battery.model.observe(
        observation.value,
        observation.source,
        observation.receivedAt,
      );
    } else {
      battery.model.markUnavailable();
    }
    battery.adapter.refresh();
  }

  private scheduleDiscoveryRetry(): void {
    if (this.discoveryTimer || this.stopped) return;
    const base = Math.min(
      60_000,
      5_000 * 2 ** Math.min(this.discoveryAttempts, 10),
    );
    const delay = Math.floor(base * (0.75 + Math.random() * 0.5));
    this.discoveryAttempts += 1;
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = undefined;
      void this.bootstrap();
    }, delay);
  }

  private async stop(): Promise<void> {
    this.stopped = true;
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = undefined;
    await this.supervisor?.stop();
  }
}

function snapshotAttributes(device: SmartRentDevice): Record<string, unknown> {
  return {
    ...device.attributes,
    ...(device.batteryLevel === undefined
      ? {}
      : { battery_level: device.batteryLevel }),
  };
}

function parseAccessoryContext(
  value: unknown,
): SmartRentAccessoryContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const role = ROLE_CONFIG.find(
    (candidate) => candidate.role === record.role,
  )?.role;
  if (
    record.schemaVersion !== 1 ||
    typeof record.deviceId !== 'string' ||
    typeof record.alias !== 'string' ||
    !role
  )
    return undefined;
  return {
    schemaVersion: 1,
    deviceId: record.deviceId,
    alias: record.alias,
    role,
  };
}

function readCachedAlias(
  accessory: PlatformAccessory,
  fallback: string,
): string {
  const metadata = parseAccessoryContext(accessory.context.smartRentNext);
  return metadata?.alias ?? accessory.displayName ?? fallback;
}

function roleModel(role: SmartRentRole): string {
  switch (role) {
    case 'lock':
      return 'SmartRent Door Lock';
    case 'thermostat':
      return 'SmartRent Thermostat';
    case 'washerLeak':
      return 'SmartRent Leak Sensor';
    case 'kitchenLeak':
      return 'SmartRent Leak Sensor';
  }
}
