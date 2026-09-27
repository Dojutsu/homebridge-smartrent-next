import {
  SmartRentReadOnlyError,
  SmartRentTransportError,
} from '../transport/errors.js';
import { ValidationConfigurationError } from './config.js';
import { DeviceMappingError } from './device-mapping.js';
import { runAccountValidation } from './account-validator.js';

try {
  await runAccountValidation();
  process.stdout.write('Read-only SmartRent account validation completed.\n');
} catch (error) {
  process.stderr.write(`Read-only validation stopped: ${safeFailure(error)}\n`);
  process.exitCode = 1;
}

function safeFailure(error: unknown): string {
  if (
    error instanceof ValidationConfigurationError ||
    error instanceof DeviceMappingError
  ) {
    return error.message;
  }
  if (error instanceof SmartRentReadOnlyError) {
    return 'READ_ONLY transport rejected a state-changing operation';
  }
  if (error instanceof SmartRentTransportError) {
    return error.status === undefined
      ? 'SmartRent request failed or timed out; response details suppressed'
      : `SmartRent request failed with HTTP ${error.status}; response details suppressed`;
  }
  return 'unexpected validation error; details suppressed';
}
