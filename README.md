# Dojutsu SmartRent Homebridge (next)

A focused Homebridge dynamic platform for one SmartRent installation: a front-door lock, thermostat, and two leak sensors. Apple Home, Siri, and Apple Watch are the user interface. The platform is intended to run as an independent Homebridge child bridge.

This repository is under development. It does not connect to SmartRent unless a future explicitly configured transport is supplied. Tests use synthetic devices and a loopback fake server. No production deployment, live credentials, or real lock operation is part of development.

See `docs/` for protocol evidence, state rules, identity constraints, tests, and the future Apple Watch acceptance plan.
