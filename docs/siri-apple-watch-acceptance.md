# Siri and Apple Watch acceptance plan

Apple Home is the household UI. These checks happen only in a future approved test Home with a real Homebridge child bridge and SmartRent devices. They are not run during implementation.

1. Apple Watch on home Wi-Fi: ask, “Is the front door locked?” Compare the answer with the explicit SmartRent report and physical lock.
2. Apple Watch: “Unlock the front door.” Observe the physical lock, SmartRent report, HomeKit current state, and any Apple confirmation prompt.
3. Apple Watch: “Lock the front door.” Make the same independent observations.
4. Repeat status, unlock, and lock commands from iPhone.
5. Test Apple Watch away from home through the configured Apple home hub.
6. Restart only the test child bridge. Repeat the query and confirm recovery without pairing changes.
7. Allow a SmartRent outage and restoration in a controlled test environment. Verify HAP remains reachable, lock state is unknown while untrusted, and recovery requires no re-pairing.
8. Soak for multiple days, preferably weeks. Track bridge uptime, event-loop delay, reconnects, auth refresh, command/report convergence, memory, and Siri “can't reach” reports.

Every lock test distinguishes `TARGET`, `SMARTRENT_REPORTED`, and `PHYSICAL_CONFIRMED`. A command response alone never proves physical state. Do not repeat a command because convergence is slow.

## Stop conditions

Stop if Siri/Home reports a confident unlocked state when SmartRent is unavailable, identities change, duplicate accessories appear, the bridge cannot recover automatically, a command is repeated, or Apple Watch cannot reliably reach the lock after the configured home-hub path is verified.

