# Read-only SmartRent account validation

This command validates the protocol against one SmartRent account without loading Homebridge or advertising HomeKit. It does not send device writes. `SmartRentProtocolTransport` defaults to `READ_ONLY`; the account validator explicitly selects that mode, and every state-changing transport method rejects before authentication or network access. The write guard also runs at the authenticated-write boundary.

## Runtime inputs

Provide these variables to the validator process through an approved runtime secret/environment provider. Do not put values in shell command arguments, repository files, terminal transcripts, CI, or chat.

- `SMARTRENT_VALIDATION_MODE` — must be `READ_ONLY`.
- `SMARTRENT_EMAIL`
- `SMARTRENT_PASSWORD`
- `SMARTRENT_TOTP_SECRET` — optional unless the account requests TOTP.
- `SMARTRENT_LOCK_DEVICE_ID`
- `SMARTRENT_THERMOSTAT_DEVICE_ID`
- `SMARTRENT_WASHER_LEAK_DEVICE_ID`
- `SMARTRENT_KITCHEN_LEAK_DEVICE_ID`
- `SMARTRENT_OBSERVE_SECONDS` — optional integer from 1 to 120; defaults to 15.

The four device IDs must be distinct. The discovered records must match each explicit ID and the expected code-level device type. Display names are not used for identity. IDs are retained only in process memory and are never printed.

## Command and request bounds

With the runtime variables securely provided to the process, run:

```sh
npm run validate:account
```

The command builds locally, then invokes a standalone Node entry point. It authenticates, reads `/api/v3/units`, enumerates each discovered hub's devices, repeats discovery to check ID/type stability, reads each configured device once, joins four Phoenix channels, and checks three correlated heartbeats. It observes for the configured bounded window, closes only its own socket, reconnects, rejoins the channels, checks three heartbeats, reads each device once more, observes briefly, and disconnects.

Authentication and WebSocket-token endpoints use POST for session setup, but no device state or configuration is changed. Device API calls are GET only. There are no recurring lock reads, retrying writes, HomeKit imports, Homebridge registration, or bridge advertisements.

## Output and limits

Output contains fixed role aliases, allowlisted values, field-presence metadata, sanitized timestamps, counts, and transport outcomes. It suppresses account and unit details, names, IDs, credentials, token contents, token-bearing URLs, raw payloads, and unrecognized strings. Unexpected lock values stop validation with `UNKNOWN`; they are not coerced to a lock state.

No natural device event is manufactured. If no event arrives during the bounded window, event-envelope shape and REST-versus-WebSocket agreement remain unknown. The command cannot observe the SmartRent mobile app; compare its displayed lock state with the contemporaneous REST result separately. API rate limits and rare error payloads are not inferred from a successful read-only run.

The validator does not import the Homebridge entry point and does not perform HomeKit or real-device acceptance testing.
