# Development state

## Current phase

Transport abstraction, authoritative state reducer, native HomeKit LockMechanism adapter, redacted diagnostics, bounded connection supervisor, leak sensor, battery and thermostat services, Homebridge dynamic-platform registration, and a loopback fake server are implemented. The local fake-server suite covers login/TOTP, device discovery and reads, accepted-but-unreported writes, token expiry, Phoenix joins/heartbeats/events, malformed frames, disconnect/rejoin, stale REST snapshots, and duplicate/out-of-order events. No SmartRent credentials have been used. No production Homebridge host has been contacted. No real accessory or lock has been controlled. No HomeKit bridge has been advertised on the household LAN.

## Scope

Homebridge dynamic platform, intended for an independent child bridge, supporting only the Front Door lock, thermostat, Washer leak sensor, and Kitchen sink/dishwasher leak sensor. Apple Home, Siri, and Apple Watch are the household interface.

## Ground truth

- Repository history is the source of truth for implemented behavior.
- Protocol facts from the earlier research implementation are documented as `VERIFIED` (code evidence), `INFERRED`, or `UNKNOWN`; they are not an official SmartRent API contract.
- Unit and integration tests use synthetic devices and mocks/local servers only.
- The transport, reducer, lock, reconnect, leak, battery, thermostat, HAP adapter fixes, and Homebridge platform each have focused commits. The fake-server integration suite is the final implementation commit in this phase.
- Final local check: formatting, ESLint, type-check, build, 65 unit tests, and 8 loopback integration tests pass on Node 20.19.2. GitHub CI has not run: this checkout has no remote, and `Dojutsu/homebridge-smartrent-next` does not exist yet.

## Open gates

- Validate SmartRent payloads and authentication behavior only in a later, separately approved read-only account-validation phase.
- Validate Apple Home's presentation of HAP `UNKNOWN`, offline faults, and leak/battery read failures on test accessories before a production migration.
- Rehearse HomeKit identity continuity using cloned Homebridge storage before considering any migration.
- Test Apple Watch Siri locally, remotely through the home hub, after restart/reconnect, and during a multi-day soak before any release recommendation.
- Add a reviewed credential provider before any real-account access. The shipped entry point deliberately does not read environment credentials or authenticate.
- Create the requested GitHub repository, push the focused commits, and verify the Node 20/22/24 CI matrix before considering the repository foundation complete.
