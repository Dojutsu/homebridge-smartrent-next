# State model and ordering

## Observation envelope

Each device has an envelope containing:

- normalized `reported` value, if any;
- `requested` target and command generation, if a user command is pending;
- source (`rest`, `websocket`, `cached`, or `none`), local receive time, and optional SmartRent timestamp;
- active connection epoch and local generation;
- freshness (`fresh`, `stale`, `unknown`), online (`online`, `offline`, `unknown`), and fault code;
- last-known values retained only as history, never silently promoted to current after restart or loss of authority.

## Fences

Every REST read captures `{connectionEpoch, generationAtStart}`. Apply the result only if both still match. Every socket belongs to one connection epoch; ignore events from retired sockets. Increment the local generation for every accepted authoritative event, status change, and requested command. Duplicate events are idempotent. A parseable older SmartRent timestamp is rejected; absent or contradictory timestamps do not establish ordering.

If equal timestamps carry conflicting values, mark the state unknown and request one bounded authoritative read. Do not let an older REST request overwrite a newer event, and do not let command acceptance overwrite any report.

The reducer implements device generations and connection epochs. A REST request captures both values; a report arriving before the REST response invalidates the response. Timestamped event IDs are deduplicated, older event timestamps are discarded, and conflicting values at an equal timestamp become unknown. Starting a newer connection epoch invalidates reports from older sockets. Transport connectivity loss clears current authority while retaining no value as current.

The supervisor waits for channel-join acknowledgements before its one-per-device read. It captures the REST fence immediately before each request. REST failures mark that device unknown without polling again; socket loss is recovered with bounded jittered backoff. Heartbeat acknowledgement failure causes reconnect, while late callbacks from older epochs are ignored.

## Command semantics

Record a command target with a new command generation. Send one write. HTTP success records acceptance only. A matching authoritative report resolves the pending command. A contradictory report becomes the current reported state and is logged as a conflict. A timeout is ambiguous and leaves current state unknown/unresolved. No command is automatically retried.

## Lock truth table

| SmartRent observation                           | HAP CurrentLockState |
| ----------------------------------------------- | -------------------- |
| explicit `locked=true`                          | `SECURED`            |
| explicit `locked=false`                         | `UNSECURED`          |
| explicit tested jam value                       | `JAMMED`             |
| absent, null, malformed, offline, or unresolved | `UNKNOWN`            |

`LockTargetState` is always separate; it has no unknown enum and is never used as current state.

The first device adapter uses the native HAP `LockMechanism` service and `LockCurrentState` / `LockTargetState` characteristics. Getters return immediately from the reducer cache. An accepted PATCH leaves current state unchanged. A command error/timeout marks that lock's current observation unknown and reports a HAP communication fault; the write is not retried. Jam maps only when a fresh, explicit boolean `jammed=true` observation exists. The real SmartRent jam payload remains unknown and must be validated before relying on this mapping.

Leak sensors accept only explicit `leak=true` or `leak=false` reports (including canonical string forms). A missing, malformed, stale, or offline value leaves the last HomeKit value untouched, marks `StatusFault`, and makes a HomeKit read return a communication failure. The plugin never changes an unknown leak state into dry.
