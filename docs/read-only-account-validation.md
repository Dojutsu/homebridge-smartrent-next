# SmartRent account validation

The standalone validator never imports the Homebridge entry point or advertises HomeKit. It has two modes. Start with `DISCOVERY_ONLY`; that mode authenticates, enumerates units/hubs/devices, prints a sanitized candidate inventory, disconnects, and exits. It performs no per-device state reads and opens no WebSocket. `READ_ONLY` is a later protocol-validation mode that requires the four explicitly confirmed device IDs and performs bounded state/event reads. Neither mode can issue device writes.

## Discovery-only mode

Required runtime variables:

- `SMARTRENT_VALIDATION_MODE=DISCOVERY_ONLY`
- `SMARTRENT_EMAIL`
- `SMARTRENT_PASSWORD`
- `SMARTRENT_TOTP_SECRET` — optional; provide only if the account requests TOTP.

No device ID or observation-window variables are read in this mode. Credentials are fetched lazily from the runtime environment and are not included in logs or errors. TOTP codes and tokens remain in memory.

Build before entering any credentials, then run the standalone command after securely injecting those variables. Keeping the build separate prevents the credential environment from being inherited by the compiler:

```sh
npm run build
npm run validate:account
```

The request sequence is authentication (and TOTP only if challenged), GET `/api/v3/units`, then GET each discovered hub's device list. The validator never requests individual device state, obtains a WebSocket token, opens a socket, joins a Phoenix channel, or sends a device command. It disconnects its transport and stops after the inventory.

Inventory rows use temporary `Candidate N` positions, not SmartRent IDs. Generic device labels may be shown only when every word matches a conservative device-label allowlist; other names are withheld. Only recognized device types, manufacturer labels from a small allowlist, and known attribute names are printed. Model values, unknown device types, unrecognized attributes, unit/hub/device identifiers, locations, account data, attribute values, and raw payloads are suppressed. A `LEAK SENSOR CANDIDATE` requires both the expected sensor category and a recognized `leak` attribute. Candidate positions do not assign household roles.

`DISCOVERY_ONLY` is a transport mode, not just a validator convention. The transport permits state-changing methods only in explicit `READ_WRITE` mode. Both `DISCOVERY_ONLY` and `READ_ONLY` reject every guarded write before authentication or network access; the authenticated-write boundary repeats the guard.

## Mapping after candidate confirmation

Do not map a role based only on a candidate's position or display name. After the owner confirms which candidates are the Front Door, thermostat, washer leak sensor, and kitchen leak sensor, a future validator revision can read a local-only mapping file outside the repository, for example `~/.config/homebridge-smartrent-next/validation-map.json`, owned by the validation user with mode `0600`. It would contain only alias-to-device-ID mappings, not credentials. The validator should validate unique IDs and expected device types, then keep IDs in memory and never print them. This local mapping mechanism is a design proposal only; it is not implemented by discovery mode.

## Existing read-only protocol mode

For a later, separately approved phase, `SMARTRENT_VALIDATION_MODE=READ_ONLY` additionally requires:

- `SMARTRENT_LOCK_DEVICE_ID`
- `SMARTRENT_THERMOSTAT_DEVICE_ID`
- `SMARTRENT_WASHER_LEAK_DEVICE_ID`
- `SMARTRENT_KITCHEN_LEAK_DEVICE_ID`
- `SMARTRENT_OBSERVE_SECONDS` — optional integer from 1 to 120; defaults to 15.

That mode checks the IDs against repeated discovery, performs bounded REST/WebSocket reads and a controlled client-only reconnect, and redacts output. No natural device event is manufactured. If none arrives, event-envelope shape and REST-versus-WebSocket agreement remain unknown. It does not observe the SmartRent app or validate HomeKit/Siri behavior.

## Runtime secret handling

Use a secure runtime environment provider or interactive shell prompts. Do not put values in command arguments, repository files, terminal transcripts, CI, or chat. Disable shell tracing while entering credentials, unset variables after the command, and never retain a TOTP code. No production credential/configuration store is part of this implementation.
