# Development state

## Current phase

Transport abstraction, authoritative state reducer, native HomeKit LockMechanism adapter, redacted diagnostics, bounded connection supervisor, leak sensor, battery and thermostat services, Homebridge dynamic-platform registration, and a loopback fake server are implemented. A separate account-validation command now uses a runtime-only credential provider and enforces READ_ONLY at the transport boundary. Local fake-server coverage includes login/TOTP, discovery and reads, accepted-but-unreported writes, token expiry, Phoenix acknowledgements/events, malformed frames, controlled client reconnect, stale REST snapshots, duplicate/out-of-order events, and validator-output redaction. No real SmartRent credentials have been used in this phase. No production Homebridge host has been contacted. No real accessory or lock has been controlled. No HomeKit bridge has been advertised on the household LAN.

## Scope

Homebridge dynamic platform, intended for an independent child bridge, supporting only the Front Door lock, thermostat, Washer leak sensor, and Kitchen sink/dishwasher leak sensor. Apple Home, Siri, and Apple Watch are the household interface.

## Ground truth

- Repository history is the source of truth for implemented behavior.
- Protocol facts from the earlier research implementation are documented as `VERIFIED` (code evidence), `INFERRED`, or `UNKNOWN`; they are not an official SmartRent API contract.
- Unit and integration tests use synthetic devices and mocks/local servers only.
- The transport, reducer, lock, reconnect, leak, battery, thermostat, HAP adapter fixes, and Homebridge platform each have focused commits. The fake-server integration suite is the final implementation commit in this phase.
- Repository: `Dojutsu/homebridge-smartrent-next`, with the original project foundation at `4174b86e81e6cfb0b114989f24a51a660bb603c1`. The initial Node 20/22/24 CI run passed formatting, ESLint, type-check, 65 unit tests, 8 fake-server integration tests, and build.
- This validation-tool change passes local formatting, ESLint, type-check, 74 unit tests, 9 fake-server integration tests, and build on Node 20.19.2. GitHub Actions has not run for this change.
- `npm run validate:account` was run as a preflight only and stopped before authentication because the runtime environment did not contain `SMARTRENT_VALIDATION_MODE` or account/device mapping variables. No authentication or SmartRent request has been attempted.

## Open gates

- Validate SmartRent payloads and authentication behavior only in a later, separately approved read-only account-validation phase.
- Validate Apple Home's presentation of HAP `UNKNOWN`, offline faults, and leak/battery read failures on test accessories before a production migration.
- Rehearse HomeKit identity continuity using cloned Homebridge storage before considering any migration.
- Test Apple Watch Siri locally, remotely through the home hub, after restart/reconnect, and during a multi-day soak before any release recommendation.
- Verify the read-only validator change in GitHub Actions before any live request.
- Securely provide the required runtime variables and explicit device IDs to the validator process before live protocol validation. Never send their values in chat or store them in the repository.
- Validate Apple Home's presentation of HAP `UNKNOWN`, offline faults, and leak/battery read failures on test accessories before a production migration.
- Rehearse HomeKit identity continuity using cloned Homebridge storage before considering any migration.
- Test Apple Watch Siri locally, remotely through the home hub, after restart/reconnect, and during a multi-day soak before any release recommendation.
