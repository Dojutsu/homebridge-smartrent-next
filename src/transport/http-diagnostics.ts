export type SmartRentHttpOperation =
  | 'AUTH_LOGIN'
  | 'AUTH_TFA'
  | 'UNIT_DISCOVERY'
  | 'DEVICE_DISCOVERY'
  | 'DEVICE_STATE'
  | 'DEVICE_ATTRIBUTE_WRITE'
  | 'WEBSOCKET_TOKEN';

export type SmartRentHttpMethod = 'GET' | 'POST' | 'PATCH';

export interface HttpFailureContext {
  operation: SmartRentHttpOperation;
  method: SmartRentHttpMethod;
  requestFields: readonly string[];
  retryableRead?: boolean;
}

export interface SafeHttpDiagnostic {
  operation: SmartRentHttpOperation;
  method: SmartRentHttpMethod;
  path: string;
  requestFields: readonly string[];
  status: number;
  responseFields: readonly string[];
  validationFields: readonly string[];
  errorCategory: string;
  sanitizedError: string;
  retryableRead: boolean;
}

const PATH_BY_OPERATION: Record<SmartRentHttpOperation, string> = {
  AUTH_LOGIN: '/authentication/sessions',
  AUTH_TFA: '/authentication/sessions/tfa',
  UNIT_DISCOVERY: '/api/v3/units',
  DEVICE_DISCOVERY: '/api/v3/hubs/:hubId/devices',
  DEVICE_STATE: '/api/v3/hubs/:hubId/devices/:deviceId',
  DEVICE_ATTRIBUTE_WRITE: '/api/v3/hubs/:hubId/devices/:deviceId',
  WEBSOCKET_TOKEN: '/api/v1/authentication/websocket-token',
};

const RESPONSE_FIELD_NAMES = new Set([
  'code',
  'detail',
  'error',
  'error_code',
  'error_type',
  'errors',
  'message',
  'status',
  'title',
  'type',
]);

const VALIDATION_FIELD_NAMES = new Set([
  'email',
  'password',
  'tfa_api_token',
  'token',
]);

const FIELD_LOCATOR_NAMES = new Set([
  'attribute',
  'field',
  'param',
  'parameter',
  'property',
]);

const SAFE_ERROR_CODES = new Map([
  ['AUTHENTICATION_FAILED', 'AUTHENTICATION_FAILED'],
  ['BAD_REQUEST', 'BAD_REQUEST'],
  ['INVALID_CREDENTIALS', 'INVALID_CREDENTIALS'],
  ['INVALID_EMAIL_OR_PASSWORD', 'INVALID_CREDENTIALS'],
  ['INVALID_TFA_CODE', 'INVALID_TOTP'],
  ['INVALID_TOTP', 'INVALID_TOTP'],
  ['INVALID_TOTP_CODE', 'INVALID_TOTP'],
  ['INVALID_TOKEN', 'INVALID_TOKEN'],
  ['REQUEST_REJECTED', 'REQUEST_REJECTED'],
  ['UNAUTHORIZED', 'UNAUTHORIZED'],
  ['UNPROCESSABLE_ENTITY', 'UNPROCESSABLE_ENTITY'],
  ['VALIDATION_ERROR', 'VALIDATION_ERROR'],
  ['VALIDATION_FAILED', 'VALIDATION_ERROR'],
]);

const SAFE_MESSAGES = new Map([
  ['authentication failed', 'AUTHENTICATION_FAILED'],
  ['bad request', 'BAD_REQUEST'],
  ['forbidden', 'FORBIDDEN'],
  ['invalid credentials', 'INVALID_CREDENTIALS'],
  ['invalid email or password', 'INVALID_CREDENTIALS'],
  ['invalid request', 'INVALID_REQUEST'],
  ['invalid tfa code', 'INVALID_TOTP'],
  ['invalid totp code', 'INVALID_TOTP'],
  ['not found', 'NOT_FOUND'],
  ['request rejected', 'REQUEST_REJECTED'],
  ['unauthorized', 'UNAUTHORIZED'],
  ['unprocessable entity', 'UNPROCESSABLE_ENTITY'],
  ['validation failed', 'VALIDATION_ERROR'],
]);

const STATUS_CATEGORIES = new Map([
  [400, 'HTTP_BAD_REQUEST'],
  [401, 'HTTP_UNAUTHORIZED'],
  [403, 'HTTP_FORBIDDEN'],
  [404, 'HTTP_NOT_FOUND'],
  [409, 'HTTP_CONFLICT'],
  [422, 'HTTP_UNPROCESSABLE_ENTITY'],
  [429, 'HTTP_RATE_LIMITED'],
]);

export function sanitizeHttpFailure(
  responseBody: unknown,
  status: number,
  context: HttpFailureContext,
): SafeHttpDiagnostic {
  const responseFields = isRecord(responseBody)
    ? Object.keys(responseBody)
        .map((field) => field.toLowerCase())
        .filter((field) => RESPONSE_FIELD_NAMES.has(field))
        .sort()
    : [];
  const validationFields = new Set<string>();
  collectValidationFields(responseBody, validationFields);
  const safeCode = findSafeCode(responseBody);
  const safeMessage = findSafeMessage(responseBody);

  return {
    operation: context.operation,
    method: context.method,
    path: PATH_BY_OPERATION[context.operation],
    requestFields: context.requestFields,
    status,
    responseFields,
    validationFields: [...validationFields].sort(),
    errorCategory:
      safeCode ?? safeMessage ?? STATUS_CATEGORIES.get(status) ?? 'HTTP_ERROR',
    sanitizedError: safeMessage ?? safeCode ?? 'suppressed',
    retryableRead: context.retryableRead ?? false,
  };
}

export function formatSafeHttpDiagnostic(
  diagnostic: SafeHttpDiagnostic,
): string {
  return [
    `operation: ${diagnostic.operation}`,
    `method: ${diagnostic.method}`,
    `path: ${diagnostic.path}`,
    `request fields: [${diagnostic.requestFields.join(', ')}]`,
    `status: ${diagnostic.status}`,
    `response fields: [${diagnostic.responseFields.join(', ')}]`,
    `validation fields: [${diagnostic.validationFields.join(', ')}]`,
    `response error category: ${diagnostic.errorCategory}`,
    `sanitized error: ${diagnostic.sanitizedError}`,
  ].join('\n');
}

export function parseResponseForDiagnostics(text: string): unknown {
  if (text.length > 16_384) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function collectValidationFields(
  value: unknown,
  fields: Set<string>,
  depth = 0,
): void {
  if (depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value) collectValidationFields(item, fields, depth + 1);
    return;
  }
  if (!isRecord(value)) return;

  for (const [rawKey, child] of Object.entries(value)) {
    const key = rawKey.toLowerCase();
    if (VALIDATION_FIELD_NAMES.has(key)) fields.add(key);
    if (
      FIELD_LOCATOR_NAMES.has(key) &&
      typeof child === 'string' &&
      VALIDATION_FIELD_NAMES.has(child.toLowerCase())
    ) {
      fields.add(child.toLowerCase());
    }
    collectValidationFields(child, fields, depth + 1);
  }
}

function findSafeCode(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSafeCode(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  for (const [rawKey, child] of Object.entries(value)) {
    const key = rawKey.toLowerCase();
    if (
      ['code', 'error_code', 'error_type', 'type'].includes(key) &&
      typeof child === 'string'
    ) {
      const safe = SAFE_ERROR_CODES.get(child.trim().toUpperCase());
      if (safe) return safe;
    }
  }
  for (const child of Object.values(value)) {
    const found = findSafeCode(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function findSafeMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSafeMessage(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  for (const [rawKey, child] of Object.entries(value)) {
    const key = rawKey.toLowerCase();
    if (
      ['detail', 'error', 'message', 'title'].includes(key) &&
      typeof child === 'string'
    ) {
      const safe = SAFE_MESSAGES.get(child.trim().toLowerCase());
      if (safe) return safe;
    }
  }
  for (const child of Object.values(value)) {
    const found = findSafeMessage(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
