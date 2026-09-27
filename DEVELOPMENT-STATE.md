# Development state

## Current phase

Transport abstraction, authoritative state reducer, native HomeKit LockMechanism adapter, redacted lock diagnostics, and bounded connection supervisor are implemented and unit-tested. Leak, battery, thermostat, dynamic platform, and fake-server layers remain in development. No SmartRent credentials have been used. No production Homebridge host has been contacted. No real accessory or lock has been controlled. No HomeKit bridge has been advertised on the household LAN.

## Scope

Homebridge dynamic platform, intended for an independent child bridge, supporting only the Front Door lock, thermostat, Washer leak sensor, and Kitchen sink/dishwasher leak sensor. Apple Home, Siri, and Apple Watch are the household interface.

## Ground truth

- Repository history is the source of truth for implemented behavior.
- Protocol facts from the earlier research implementation are documented as `VERIFIED` (code evidence), `INFERRED`, or `UNKNOWN`; they are not an official SmartRent API contract.
- Unit and integration tests use synthetic devices and mocks/local servers only.
- `feat: add SmartRent transport abstraction`, `feat: add authoritative state reducer`, and `feat: add HomeKit lock support` are committed; the reconnect supervisor is ready for its focused commit.
- Current unit result: 28 tests pass on the local Node 20.19.2 runtime. CI has not run because the new GitHub repository is not yet available.

## Open gates

- Validate SmartRent payloads and authentication behavior only in a later, separately approved read-only account-validation phase.
- Validate Apple Home's presentation of HAP `UNKNOWN`, offline faults, and leak/battery read failures on test accessories before a production migration.
- Rehearse HomeKit identity continuity using cloned Homebridge storage before considering any migration.
- Test Apple Watch Siri locally, remotely through the home hub, after restart/reconnect, and during a multi-day soak before any release recommendation.
