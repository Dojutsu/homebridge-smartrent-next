# Test strategy

All tests inject a `SmartRentTransport` or talk only to a loopback fake server. Unit tests use fake clocks and deterministic event sequences. Tests fail if they attempt external network access. No fixture contains actual SmartRent credentials, device identifiers, pairing data, or captured raw payloads.

## Required matrix

- **Lock:** secured/unsecured/unknown/offline/jammed; accepted command with no state change; conflicting and delayed report; reconnect; stale REST; duplicate and out-of-order event; rapid commands; unresolved timeout; no retries.
- **Battery:** valid/missing/malformed/stale/API failure; 20% threshold; service absent before first valid report; later recovery; never default to 100%.
- **Thermostat:** heat/cool/off/auto; current vs target mode; target changes; rapid changes; stale mode; delayed confirmation; cloud timeout; reconnect; separate current temperature, humidity, setpoints, and operating state.
- **Leak:** dry/leak; offline/unknown/malformed; reconnect baseline; duplicate event; unknown never becomes dry; unavailable HomeKit reads return a communication fault.
- **Connection:** login, TOTP challenge, auth expiry, WebSocket disconnect, missed heartbeat response, reconnect, channel join acknowledgement, resubscription, REST errors, malformed frames.
- **Platform/identity:** restored cached accessories, stable UUIDs, unchanged service/subtype layout, isolated child-bridge lifecycle, cloned fake Homebridge storage.
- **Siri/Apple Watch:** acceptance procedure is specified in `siri-apple-watch-acceptance.md`; it requires Apple devices and is not simulated as a unit test.

CI runs format, lint, type-check, unit tests, loopback integration tests, and build on Node 20, 22, and 24. No CI job has account credentials.
