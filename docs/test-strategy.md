# Test strategy

All tests inject a `SmartRentTransport` or talk only to a loopback fake server. Unit tests use fake clocks and deterministic event sequences. Tests fail if they attempt external network access. No fixture contains actual SmartRent credentials, device identifiers, pairing data, or captured raw payloads.

## Required matrix

- **Lock:** secured/unsecured/unknown/offline/jammed; accepted command with no state change; conflicting and delayed report; reconnect; stale REST; duplicate and out-of-order event; rapid commands; unresolved timeout; no retries.
- **Battery:** valid/missing/malformed/stale/API failure; 20% threshold; service absent before first valid report; later recovery; never default to 100%.
- **Thermostat:** heat/cool/off/auto; current vs target mode; target changes; rapid changes; stale mode; delayed confirmation; cloud timeout; reconnect; separate current temperature, humidity, setpoints, and operating state; fresh-mode writes avoid a GET while unknown mode allows exactly one fenced GET.
- **Leak:** dry/leak; offline/unknown/malformed; reconnect baseline; duplicate event; unknown never becomes dry; unavailable HomeKit reads return a communication fault.
- **Connection:** login, TOTP challenge, auth expiry, WebSocket disconnect, missed heartbeat response, reconnect, channel join acknowledgement, resubscription, REST errors, malformed frames.
- **Platform/identity:** restored cached accessories, stable UUIDs, persistent role/device mapping, native service subtypes, no-transport safe default, isolated child-bridge lifecycle, cloned fake Homebridge storage.
- **Siri/Apple Watch:** acceptance procedure is specified in `siri-apple-watch-acceptance.md`; it requires Apple devices and is not simulated as a unit test.

## Implemented synthetic coverage

The unit suite covers lock state mapping and one-write semantics, reducer ordering and command generations, bounded reconnects, cached platform registration, battery freshness, leak fault behavior, and thermostat read/write selection. The loopback fake server exercises synthetic login/TOTP, device discovery and state, PATCH acceptance without a reported-state mutation, expired-token reads and writes, Phoenix join and heartbeat acknowledgements, event parsing, malformed frames, disconnect/rejoin, delayed stale REST responses, and duplicate/out-of-order events. A global test guard rejects HTTP fetches to non-loopback hosts; integration WebSocket construction is separately restricted to `127.0.0.1`.

No CI run exists until the fresh GitHub repository is created and pushed. The configured workflow runs format, lint, type-check, unit tests, loopback integration tests, and build on Node 20, 22, and 24. No CI job has account credentials.
