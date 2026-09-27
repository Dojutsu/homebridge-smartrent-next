import type { HAP, PlatformAccessory, Service } from 'homebridge';
import type { StateSource } from '../state/model.js';

export type BatteryFreshness = 'fresh' | 'stale' | 'unknown';

export interface BatterySnapshot {
  percentage: number | undefined;
  observedAt: number | undefined;
  source: StateSource | undefined;
  freshness: BatteryFreshness;
  generation: number;
}

export class BatteryModel {
  private snapshot: BatterySnapshot = {
    percentage: undefined,
    observedAt: undefined,
    source: undefined,
    freshness: 'unknown',
    generation: 0,
  };

  constructor(readonly lowBatteryThreshold = 20) {
    if (
      !Number.isInteger(lowBatteryThreshold) ||
      lowBatteryThreshold < 0 ||
      lowBatteryThreshold > 100
    ) {
      throw new RangeError(
        'Battery threshold must be an integer from 0 to 100',
      );
    }
  }

  observe(
    value: unknown,
    source: Exclude<StateSource, 'none'>,
    observedAt: number,
  ): BatterySnapshot {
    const percentage = parsePercentage(value);
    this.snapshot =
      percentage === undefined
        ? {
            ...this.snapshot,
            freshness:
              this.snapshot.percentage === undefined ? 'unknown' : 'stale',
            generation: this.snapshot.generation + 1,
          }
        : {
            percentage,
            observedAt,
            source,
            freshness: 'fresh',
            generation: this.snapshot.generation + 1,
          };
    return this.get();
  }

  markUnavailable(): BatterySnapshot {
    this.snapshot = {
      ...this.snapshot,
      freshness: this.snapshot.percentage === undefined ? 'unknown' : 'stale',
      generation: this.snapshot.generation + 1,
    };
    return this.get();
  }

  get(): BatterySnapshot {
    return { ...this.snapshot };
  }

  isLow(): boolean | undefined {
    if (this.snapshot.percentage === undefined) return undefined;
    return this.snapshot.percentage <= this.lowBatteryThreshold;
  }
}

function parsePercentage(value: unknown): number | undefined {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
  )
    return value;
  if (typeof value === 'string' && /^(100|[1-9]?\d)$/.test(value))
    return Number(value);
  return undefined;
}

export interface BatteryServiceOptions {
  accessory: PlatformAccessory;
  api: Pick<HAP, 'Service' | 'Characteristic'>;
  model: BatteryModel;
  serviceSubtype?: string;
}

/** Adds the HomeKit battery service only after a valid percentage is known. */
export class BatteryServiceAdapter {
  private service: Service | undefined;

  constructor(private readonly options: BatteryServiceOptions) {
    this.serviceSubtype = options.serviceSubtype ?? 'battery';
  }

  private readonly serviceSubtype: string;

  refresh(): void {
    const snapshot = this.options.model.get();
    if (snapshot.percentage === undefined) return;
    if (!this.service) {
      const { accessory, api } = this.options;
      this.service =
        accessory.getServiceById(api.Service.Battery, this.serviceSubtype) ??
        accessory.addService(
          api.Service.Battery,
          'Battery',
          this.serviceSubtype,
        );
      this.service
        .getCharacteristic(api.Characteristic.BatteryLevel)
        .onGet(() => this.readPercentage());
      this.service
        .getCharacteristic(api.Characteristic.StatusLowBattery)
        .onGet(() => this.readLowBattery());
    }
    if (snapshot.freshness !== 'fresh') return;
    this.service.updateCharacteristic(
      this.options.api.Characteristic.BatteryLevel,
      snapshot.percentage,
    );
    this.service.updateCharacteristic(
      this.options.api.Characteristic.StatusLowBattery,
      this.options.model.isLow()
        ? this.options.api.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.options.api.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
  }

  private readPercentage(): number {
    const snapshot = this.options.model.get();
    if (snapshot.percentage === undefined || snapshot.freshness !== 'fresh')
      throw new Error('Battery state unavailable');
    return snapshot.percentage;
  }

  private readLowBattery(): number {
    const low = this.options.model.isLow();
    if (low === undefined || this.options.model.get().freshness !== 'fresh')
      throw new Error('Battery state unavailable');
    return low
      ? this.options.api.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.options.api.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }
}
