# Architecture

## Product boundary

Apple Home, Siri, and Apple Watch are the user interface. The plugin exposes only the four installed SmartRent device roles. It does not provide a household dashboard or replacement app.

## Process layout

The plugin is a Homebridge dynamic platform intended to run in its own child bridge. Homebridge/HAP owns the HomeKit server, pairing, accessory cache, service identifiers, and HomeKit-facing logging. The child process isolates SmartRent faults from unrelated plugins. SmartRent cloud failure must not prevent the HAP bridge from starting or answering cached reads.

```text
Apple Home / Siri / Apple Watch
              │ HAP
      Homebridge child bridge
              │
   HomeKit service adapters
              │
     per-device state reducer
       ┌──────┴──────┐
  REST/auth       Phoenix WS
       └──────┬──────┘
        SmartRent cloud
```

## Layers

1. `transport`: injectable protocol boundary; production adapter and fake server share types.
2. `state`: normalized observations, ordering fences, freshness, requested commands, and fault state.
3. `devices`: lock, thermostat, leak, and battery domain rules with no Homebridge dependency.
4. `homekit`: HAP characteristic mappings and immediate cache-backed getters.
5. `platform`: discovery, cached accessory restore, stable UUIDs, and child-process lifecycle.
6. `diagnostics`: structured event logging with redaction at the boundary.

## Startup and recovery

Restore cached accessories and make HAP responsive before cloud authentication. Authenticate and discover devices asynchronously. Subscribe before requesting a baseline snapshot. A newer event or command generation fences off an older REST response. After a channel rejoin is acknowledged, make one state read for that device; never run recurring lock-state polls.

The process remains alive through authentication, REST, or WebSocket failures. Reconnect is bounded and jittered. No HomeKit getter waits for SmartRent. HAP availability and SmartRent availability are separate states.

## Implementation policy

The new TypeScript client is authored in this repository behind `SmartRentTransport`. The prior GPL-3.0-or-later integration is protocol evidence, not copied source. No SmartRent request is made by tests except to a loopback fake server.

