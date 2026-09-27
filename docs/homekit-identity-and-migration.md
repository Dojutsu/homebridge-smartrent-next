# HomeKit identity and migration

## Stable identifiers

Use Homebridge's deterministic HAP UUID generation with the SmartRent device ID as seed: `api.hap.uuid.generate(device.id.toString())`. Keep the serial number equal to the stable device ID when available. Display names are mutable labels, never identity keys. Persist a device mapping so missing discovery results do not immediately unregister an accessory.

The dynamic platform stores a schema-versioned `{deviceId, role, alias}` mapping in `PlatformAccessory.context.smartRentNext`, registers services by the SmartRent device ID as subtype, and restores cached accessories before discovery. Unit tests compare the resulting accessory UUID with the prior plugin's documented `uuid.generate(device.id.toString())` seed. This proves deterministic UUID matching in code; it does not prove pairing, AID/IID, room, scene, or automation continuity.

The Homebridge child bridge identity and HomeKit pairing persistence must remain intact. Preserve the child-bridge username, pairing/private-key data, accessory UUIDs, accessory/service/subtype layout, identifier cache, cached accessory records, and the plugin/platform cache mapping. A package-name or platform-name change may affect Homebridge cache restoration even if UUIDs match.

## Migration constraints

Matching the old plugin's UUID seed and serial number may preserve bridged accessory identity only when the same paired bridge identity and HAP accessory/service identifiers are restored. Those matches alone are not a guarantee. The old integration and this plugin must not advertise the same child-bridge identity simultaneously on the household LAN.

Before any production migration, test an isolated clone of Homebridge storage. Verify the bridge identity, all four accessory UUIDs, HAP AIDs/IIDs, service/subtype layout, and cached accessory records. If identity continuity is not exact, stop; do not remove/re-add accessories as a fallback.

No migration is implemented or attempted by this repository phase.
