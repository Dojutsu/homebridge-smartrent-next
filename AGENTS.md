# Repository instructions

- Production Homebridge, Ludmini, and live SmartRent services are out of scope by default. Do not access them without a separate explicit approval.
- Never issue real lock commands from tests. Tests use only synthetic devices and a local fake server.
- Never put SmartRent credentials, TOTP seeds/codes, access tokens, pairing data, or raw payloads in fixtures, logs, snapshots, or commits.
- Never automatically retry lock or unlock writes. A timeout can mean SmartRent received the command.
- Unknown or offline lock state must never become unlocked. Missing, null, malformed, or unavailable state is `UNKNOWN`.
- Requested/target state is distinct from SmartRent-reported state. HTTP success is acceptance, not physical confirmation.
- Label protocol and architecture claims `VERIFIED`, `INFERRED`, or `UNKNOWN`; verified means evidenced by source/tests, not vendor-supported.
- Redact tokens, pairing material, raw payloads, credentials, and identifying account data from diagnostics.
- Git commits are ground truth for project history. Keep commits focused and do not rewrite shared history.
- Update `DEVELOPMENT-STATE.md` when scope, architecture, phase, test status, or material unknowns change.
- Run format, lint, type-check, unit tests, integration tests, and build before considering a change complete.
- Tests must not require network access. Mocked protocol tests must use `.invalid` hostnames or a loopback-only fake server.
- Preserve deterministic accessory UUIDs, bridge pairing persistence, and service/subtype layout. Identity changes require explicit documentation and migration tests.
