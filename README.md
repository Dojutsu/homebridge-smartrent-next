# Dojutsu SmartRent Homebridge (next)

A focused Homebridge dynamic platform for one SmartRent installation: a front-door lock, thermostat, and two leak sensors. Apple Home, Siri, and Apple Watch are the user interface. The platform is intended to run as an independent Homebridge child bridge.

This repository is under development. The Homebridge platform does not automatically authenticate to SmartRent. A separate explicitly invoked read-only protocol validator can connect when runtime credentials and device mappings are securely provided. Tests use synthetic devices and a loopback fake server. No production deployment, live credentials, or real lock operation is part of development.

See `docs/` for protocol evidence, state rules, identity constraints, tests, and the future Apple Watch acceptance plan.

The standalone real-account protocol validator is documented in [`docs/read-only-account-validation.md`](docs/read-only-account-validation.md). It requires runtime-only environment variables and enforces `READ_ONLY` at the transport layer. Do not run it until the credentials and explicit device IDs are securely available to the process.
