export class SmartRentTransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryableRead = false,
  ) {
    super(message);
    this.name = 'SmartRentTransportError';
  }
}

export function statusError(status: number, method: string): SmartRentTransportError {
  return new SmartRentTransportError(
    `SmartRent ${method} failed with HTTP ${status}`,
    status,
    method === 'GET' && status >= 500,
  );
}

