import { afterAll, beforeAll } from 'vitest';

const nativeFetch = globalThis.fetch;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : String(input);
    const parsed = new URL(requestUrl);
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      throw new Error('External network access is disabled in tests');
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = nativeFetch;
});
