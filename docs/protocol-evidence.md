# SmartRent protocol evidence

Evidence was collected from the prior research worktree at `ef502b2d1d1ca7e71bf8d7ffd9e23a6a49c9f42` and public community integrations. It was not validated against a live account during this project phase. `VERIFIED` means present in reviewed code/tests, not an official SmartRent guarantee.

## VERIFIED in reviewed code

- API origin: `https://control.smartrent.com`; REST prefix `/api/v3`.
- Session: POST `/authentication/sessions`; when configured for TOTP, POST `/authentication/sessions/tfa` with the short-lived TFA API token and a generated code.
- WebSocket token: POST `/api/v1/authentication/websocket-token`; WSS `/socket/websocket` with `token` and Phoenix `vsn=2.0.0` query parameters.
- Device discovery: GET `/api/v3/units`, then GET `/api/v3/hubs/{hubId}/devices`.
- Device state: GET `/api/v3/hubs/{hubId}/devices/{deviceId}`.
- Attribute write: PATCH that device path with `{attributes:[{name,state}]}`. The old implementation sends lock `locked` and thermostat mode/setpoint/fan attributes.
- Phoenix subscription topic: `devices:{deviceId}`, joined with `phx_join`. Device events include attribute name, `last_read_state`, and `last_read_state_changed_at`.
- Existing model fields include numeric `id`, `online`, `attributes`, timestamps, and battery fields. Observed thermostat attributes include mode, operating state, current temperature/humidity, heat/cool setpoints, and fan mode. Leak is represented by a `leak` attribute.
- The reviewed thermostat implementation names these fields `mode`, `operating_state`, `current_temp`, `current_humidity`, `heating_setpoint`, `cooling_setpoint`, and `fan_mode`. It converts SmartRent temperatures from Fahrenheit for HomeKit, writes setpoints as string Fahrenheit values, and selects `cooling_setpoint` only when reported mode is `cool`; other modes select `heating_setpoint`.
- Reviewed HTTP timeout is 10 seconds; WebSocket open timeout is 30 seconds; old client sends Phoenix heartbeat every 30 seconds and reconnects after close/error with capped exponential backoff.

## INFERRED

- The auth responses are JWT-like bearer tokens because the reviewed client decodes `exp` and a user subject. The code does not show a vendor-published token contract.
- WebSocket attribute events are intended as live reported device state. A PATCH response is not proof of physical completion.
- A configured TOTP seed allows noninteractive second factor in the plugin; the exact SmartRent MFA policy may vary by account.
- The reviewed plugin describes 50–90°F as the SmartRent setpoint range. The new implementation rejects values outside it rather than clamping. This range and the old mapping of `auto`/`off` to heating setpoint are inherited evidence, not a vendor guarantee for this installation.
- The two experimental lock fixes are useful behavior evidence: unavailable state maps to HAP `UNKNOWN`; an acknowledged channel rejoin triggers one bounded state read with generation fencing.

## UNKNOWN

- Official support status, API stability, published rate limits, and exact error schemas.
- Token lifetime/revocation behavior, TOTP clock tolerance, account lockout thresholds, and whether every account uses MFA.
- Stability/uniqueness of numeric device IDs across unit or account changes; meaning of `remote_id` and event `id`.
- Whether SmartRent timestamps are monotonic, authoritative, or sufficiently precise to order conflicting events.
- Whether heartbeat acknowledgements are guaranteed; whether a silent half-open socket is observable without a client watchdog.
- Exact payloads for this installation's jammed, battery, leak, HVAC, and offline states.
- Thermostat ranges, auto-mode target semantics, and whether every PATCH is a partial attribute update at the service boundary.

## Authentication request comparison

### VERIFIED FROM v2.0.0 source

- `@jackietreeh0rn/homebridge-smartrent` v2.0.0 creates an Axios auth client with base URL `https://control.smartrent.com` and POSTs `/authentication/sessions` with form fields `email` and `password`.
- The old client sets `Content-Type: application/x-www-form-urlencoded; charset=utf-8`. Its auth headers also include `Accept: */*`, a Safari 18.3 user-agent string, `Accept-Language: en-US;q=1.0`, `Accept-Encoding: gzip;q=1.0, compress;q=0.5`, and `Connection: keep-alive`.
- The old client does not add `X-AppVersion` to the auth request. That header exists on its separate `/api/v3` API client. No explicit cookie jar or auth-cookie handling was found in the reviewed path; successful session tokens are kept in its local session file.
- A successful initial response containing `data.tfa_api_token` triggers a TOTP generated in memory, followed by POST `/authentication/sessions/tfa` with form fields `tfa_api_token` and `token`, using the same auth headers/content type. An initial response with `data.access_token` skips TFA.
- The old WebSocket-token request is POST `/api/v1/authentication/websocket-token` with the bearer access token and the auth-client headers; it has no application form fields.

### VERIFIED FROM next-client source

- The next client uses the same auth base URL, endpoints, POST methods, form content type, and field names. It sends TOTP only after receiving the expected `data.tfa_api_token` challenge; the initial request contains only `email` and `password`.
- Before the request-shape correction, the next client omitted the old auth client's `User-Agent`, `Accept`, `Accept-Language`, `Accept-Encoding`, and `Connection` headers. The current implementation mirrors those old auth headers on login, TFA, and WebSocket-token requests. It still does not add `X-AppVersion` to auth calls.
- The next client uses `URLSearchParams` for the form bodies, retains tokens in process memory, and does not use cookies or persist an auth session.

### INFERRED

- The omitted legacy auth headers are a concrete request-metadata difference and a plausible contributor to the observed HTTP 422 because the old implementation is known to work with this account. The source does not prove that SmartRent requires any particular one of those headers.

### UNKNOWN

- The two earlier sanitized failures occurred before the validator printed authentication success, so source/control flow narrows the failed operation to `AUTH_LOGIN` or `AUTH_TFA`; the old output cannot distinguish which one returned 422.
- The safe response body and validation field names from those requests were not captured. No request should be repeated until the diagnostic change passes CI.
- Whether SmartRent requires the legacy client headers or emits a specific 422 validation error remains unknown until a single post-CI read-only attempt.

## Safe HTTP failure diagnostics

The validator attaches a fixed operation name, method, templated path, schema field names, status, recognized response field names, allowlisted validation field names, and a static safe error category to HTTP failures. It never stores raw request/response text in the error. Dynamic unit/hub/device path segments are replaced with placeholders. Error messages and codes are exposed only when they exactly match a small allowlist; other values and unknown response structures remain suppressed.

## Existing-source references

- [Authentication](/home/ludwin/src/homebridge-smartrent-research/src/lib/auth.ts)
- [Endpoints and WebSocket client](/home/ludwin/src/homebridge-smartrent-research/src/lib/request.ts)
- [REST API wrapper](/home/ludwin/src/homebridge-smartrent-research/src/lib/api.ts)
- [Phoenix client](/home/ludwin/src/homebridge-smartrent-research/src/lib/client.ts)
- [Device schema](/home/ludwin/src/homebridge-smartrent-research/src/devices/base.ts)
