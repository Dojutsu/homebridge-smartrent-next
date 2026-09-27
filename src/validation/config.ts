import type { CredentialsProvider } from '../transport/types.js';

export const DEVICE_ID_ENV = {
  'front-door': 'SMARTRENT_LOCK_DEVICE_ID',
  thermostat: 'SMARTRENT_THERMOSTAT_DEVICE_ID',
  'washer-leak': 'SMARTRENT_WASHER_LEAK_DEVICE_ID',
  'kitchen-leak': 'SMARTRENT_KITCHEN_LEAK_DEVICE_ID',
} as const;

export type ValidationAlias = keyof typeof DEVICE_ID_ENV;

export interface DiscoveryOnlyValidationConfig {
  mode: 'DISCOVERY_ONLY';
}

export interface ReadOnlyAccountValidationConfig {
  mode: 'READ_ONLY';
  deviceIds: Record<ValidationAlias, string>;
  observeSeconds: number;
}

export type AccountValidationConfig =
  DiscoveryOnlyValidationConfig | ReadOnlyAccountValidationConfig;

export class ValidationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationConfigurationError';
  }
}

/** Reads secrets only when called. Values are never formatted into errors or logs. */
export function createEnvironmentCredentialsProvider(
  environment: NodeJS.ProcessEnv = process.env,
): CredentialsProvider {
  return async () => {
    const email = environment.SMARTRENT_EMAIL;
    const password = environment.SMARTRENT_PASSWORD;
    const missing = [
      ...(!email ? ['SMARTRENT_EMAIL'] : []),
      ...(!password ? ['SMARTRENT_PASSWORD'] : []),
    ];
    if (missing.length > 0) {
      throw new ValidationConfigurationError(
        `Missing runtime credential variables: ${missing.join(', ')}`,
      );
    }
    const totpSecret = environment.SMARTRENT_TOTP_SECRET;
    return {
      email: email!,
      password: password!,
      ...(totpSecret ? { totpSecret } : {}),
    };
  };
}

export function loadAccountValidationConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AccountValidationConfig {
  const missing: string[] = [];
  const mode = environment.SMARTRENT_VALIDATION_MODE;
  if (mode !== 'DISCOVERY_ONLY' && mode !== 'READ_ONLY') {
    missing.push(
      'SMARTRENT_VALIDATION_MODE must be DISCOVERY_ONLY or READ_ONLY',
    );
  }
  if (!environment.SMARTRENT_EMAIL) missing.push('SMARTRENT_EMAIL');
  if (!environment.SMARTRENT_PASSWORD) missing.push('SMARTRENT_PASSWORD');
  const deviceIds = {} as Record<ValidationAlias, string>;
  if (mode === 'READ_ONLY') {
    for (const [alias, variable] of Object.entries(DEVICE_ID_ENV) as Array<
      [ValidationAlias, (typeof DEVICE_ID_ENV)[ValidationAlias]]
    >) {
      const id = environment[variable];
      if (!id) missing.push(variable);
      else deviceIds[alias] = id;
    }
  }
  if (missing.length > 0) {
    throw new ValidationConfigurationError(
      `Missing or invalid runtime variables: ${missing.join(', ')}. Values are never echoed.`,
    );
  }

  if (mode === 'DISCOVERY_ONLY') return { mode };

  const ids = Object.values(deviceIds);
  if (new Set(ids).size !== ids.length) {
    throw new ValidationConfigurationError(
      'Each configured device role must use a distinct SmartRent device ID',
    );
  }

  const observeRaw = environment.SMARTRENT_OBSERVE_SECONDS;
  const observeSeconds = observeRaw === undefined ? 15 : Number(observeRaw);
  if (
    !Number.isInteger(observeSeconds) ||
    observeSeconds < 1 ||
    observeSeconds > 120
  ) {
    throw new ValidationConfigurationError(
      'SMARTRENT_OBSERVE_SECONDS must be an integer from 1 to 120',
    );
  }

  return { mode: 'READ_ONLY', deviceIds, observeSeconds };
}
