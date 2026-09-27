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
- Reviewed HTTP timeout is 10 seconds; WebSocket open timeout is 30 seconds; old client sends Phoenix heartbeat every 30 seconds and reconnects after close/error with capped exponential backoff.

## INFERRED

- The auth responses are JWT-like bearer tokens because the reviewed client decodes `exp` and a user subject. The code does not show a vendor-published token contract.
- WebSocket attribute events are intended as live reported device state. A PATCH response is not proof of physical completion.
- A configured TOTP seed allows noninteractive second factor in the plugin; the exact SmartRent MFA policy may vary by account.
- The two experimental lock fixes are useful behavior evidence: unavailable state maps to HAP `UNKNOWN`; an acknowledged channel rejoin triggers one bounded state read with generation fencing.

## UNKNOWN

- Official support status, API stability, published rate limits, and exact error schemas.
- Token lifetime/revocation behavior, TOTP clock tolerance, account lockout thresholds, and whether every account uses MFA.
- Stability/uniqueness of numeric device IDs across unit or account changes; meaning of `remote_id` and event `id`.
- Whether SmartRent timestamps are monotonic, authoritative, or sufficiently precise to order conflicting events.
- Whether heartbeat acknowledgements are guaranteed; whether a silent half-open socket is observable without a client watchdog.
- Exact payloads for this installation's jammed, battery, leak, HVAC, and offline states.
- Thermostat ranges, auto-mode target semantics, and whether every PATCH is a partial attribute update at the service boundary.

## Existing-source references

- [Authentication](</home/ludwin/src/homebridge-smartrent-research/src/lib/auth.ts>)
- [Endpoints and WebSocket client](</home/ludwin/src/homebridge-smartrent-research/src/lib/request.ts>)
- [REST API wrapper](</home/ludwin/src/homebridge-smartrent-research/src/lib/api.ts>)
- [Phoenix client](</home/ludwin/src/homebridge-smartrent-research/src/lib/client.ts>)
- [Device schema](</home/ludwin/src/homebridge-smartrent-research/src/devices/base.ts>)

