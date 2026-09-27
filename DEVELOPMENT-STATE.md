# Development state

## Current phase

Transport abstraction, authoritative state reducer, native HomeKit LockMechanism adapter, redacted diagnostics, bounded connection supervisor, leak sensor, battery and thermostat services, Homebridge dynamic-platform registration, and a loopback fake server are implemented. The standalone account validator now has `DISCOVERY_ONLY` and `READ_ONLY` modes, with all writes centrally disabled unless a transport is explicitly constructed as `READ_WRITE`. Discovery-only requires no device IDs and stops after sanitized enumeration. Local fake-server coverage includes login/TOTP, discovery-only stop-before-state-read behavior, write rejection, discovery and reads, accepted-but-unreported writes, token expiry, Phoenix acknowledgements/events, malformed frames, controlled client reconnect, stale REST snapshots, duplicate/out-of-order events, and validator-output redaction. No real SmartRent credentials have been used in this phase. No production Homebridge host has been contacted. No real accessory or lock has been controlled. No HomeKit bridge has been advertised on the household LAN.

## Scope

Homebridge dynamic platform, intended for an independent child bridge, supporting only the Front Door lock, thermostat, Washer leak sensor, and Kitchen sink/dishwasher leak sensor. Apple Home, Siri, and Apple Watch are the household interface.

## Ground truth

- Repository history is the source of truth for implemented behavior.
- Protocol facts from the earlier research implementation are documented as `VERIFIED` (code evidence), `INFERRED`, or `UNKNOWN`; they are not an official SmartRent API contract.
- Unit and integration tests use synthetic devices and mocks/local servers only.
- The transport, reducer, lock, reconnect, leak, battery, thermostat, HAP adapter fixes, and Homebridge platform each have focused commits. The fake-server integration suite is the final implementation commit in this phase.
- TypeScript builds from `src` into the package root `dist` layout. The npm metadata entry points now match `dist/index.js` and `dist/index.d.ts`; a smoke test validates the real packed tarball and imports the scoped Homebridge registration entry without instantiating a bridge.
- Repository: `Dojutsu/homebridge-smartrent-next`, with the original project foundation at `4174b86e81e6cfb0b114989f24a51a660bb603c1`. The initial Node 20/22/24 CI run passed formatting, ESLint, type-check, 65 unit tests, 8 fake-server integration tests, and build.
- Packaging correction `5651716c96df954039f4ea117f219e02f76c201e` passed GitHub Actions on Node 20/22/24, including formatting, ESLint, type-check, tests, build, and package/load smoke ([run 36343841214](https://github.com/Dojutsu/homebridge-smartrent-next/actions/runs/36343841214)).
- Discovery-only implementation passes local formatting, ESLint, type-check, 78 unit tests, 11 loopback integration tests, build, package/load smoke, and `git diff --check`. It has not been run against SmartRent. GitHub Actions on Node 20/22/24 must pass for its exact commit before any real-account authentication.
- `npm run validate:account` was run as a preflight only and stopped before authentication because the runtime environment did not contain `SMARTRENT_VALIDATION_MODE` or account/device mapping variables. No authentication or SmartRent request has been attempted.

## Open gates

- Validate SmartRent payloads and authentication behavior only in a later, separately approved read-only account-validation phase.
- Validate Apple Home's presentation of HAP `UNKNOWN`, offline faults, and leak/battery read failures on test accessories before a production migration.
- Rehearse HomeKit identity continuity using cloned Homebridge storage before considering any migration.
- Test Apple Watch Siri locally, remotely through the home hub, after restart/reconnect, and during a multi-day soak before any release recommendation.
- Push the focused discovery-only commit and manually dispatch CI for `codex/read-only-account-validation`; the workflow's push filter targets `main`.
- Do not authenticate until that exact commit passes all Node 20/22/24 jobs and a later live-validation step is explicitly requested. Discovery mode needs credentials only; role IDs are required only for a later `READ_ONLY` run after candidate confirmation.
