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

export class SmartRentReadOnlyError extends Error {
  constructor() {
    super(
      'SmartRent transport is READ_ONLY; state-changing requests are disabled',
    );
    this.name = 'SmartRentReadOnlyError';
  }
}

export function statusError(
  status: number,
  method: string,
): SmartRentTransportError {
  return new SmartRentTransportError(
    `SmartRent ${method} failed with HTTP ${status}`,
    status,
    method === 'GET' && status >= 500,
  );
}
