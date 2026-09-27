import { describe, expect, it } from 'vitest';
import {
  createEnvironmentCredentialsProvider,
  loadAccountValidationConfig,
  ValidationConfigurationError,
} from '../../src/validation/config.js';

const completeEnvironment: NodeJS.ProcessEnv = {
  SMARTRENT_VALIDATION_MODE: 'READ_ONLY',
  SMARTRENT_EMAIL: 'private-email-sentinel',
  SMARTRENT_PASSWORD: 'private-password-sentinel',
  SMARTRENT_LOCK_DEVICE_ID: '101',
  SMARTRENT_THERMOSTAT_DEVICE_ID: '102',
  SMARTRENT_WASHER_LEAK_DEVICE_ID: '103',
  SMARTRENT_KITCHEN_LEAK_DEVICE_ID: '104',
};

describe('read-only account validation configuration', () => {
  it('requires explicit READ_ONLY mode', () => {
    expect(() =>
      loadAccountValidationConfig({
        ...completeEnvironment,
        SMARTRENT_VALIDATION_MODE: 'READ_WRITE',
      }),
    ).toThrow('SMARTRENT_VALIDATION_MODE=READ_ONLY');
  });

  it('reports missing variable names but never echoes configured values', () => {
    const partial = {
      SMARTRENT_VALIDATION_MODE: 'READ_ONLY',
      SMARTRENT_EMAIL: 'private-email-sentinel',
    };

    try {
      loadAccountValidationConfig(partial);
      throw new Error('Expected configuration validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationConfigurationError);
      expect((error as Error).message).toContain('SMARTRENT_PASSWORD');
      expect((error as Error).message).toContain('SMARTRENT_LOCK_DEVICE_ID');
      expect((error as Error).message).not.toContain('private-email-sentinel');
    }
  });

  it('keeps credentials lazy and returns them only to the caller in memory', async () => {
    const provider = createEnvironmentCredentialsProvider(completeEnvironment);
    await expect(provider()).resolves.toEqual({
      email: 'private-email-sentinel',
      password: 'private-password-sentinel',
    });
  });

  it('rejects duplicate device IDs and invalid observation windows', () => {
    expect(() =>
      loadAccountValidationConfig({
        ...completeEnvironment,
        SMARTRENT_KITCHEN_LEAK_DEVICE_ID: '103',
      }),
    ).toThrow('distinct SmartRent device ID');
    expect(() =>
      loadAccountValidationConfig({
        ...completeEnvironment,
        SMARTRENT_OBSERVE_SECONDS: '0',
      }),
    ).toThrow('SMARTRENT_OBSERVE_SECONDS');
  });
});
