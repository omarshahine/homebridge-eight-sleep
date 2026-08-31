# Changelog

## 1.0.0 (2026-08-31)

Initial release.

- Heater/Cooler accessory per bed side: power, Heat/Cool, 0–100 % intensity mapped to Eight Sleep level -100..100.
- Heating/cooling threshold temperatures on the same 55–110 °F pseudo-scale, so the Home tile reads "Cooling to 77°" instead of "(null)" and the dial sets the level.
- Optional "Eight Sleep Away" switch for household away mode.
- Sides and names discovered from the account; handles away-mode payloads where side IDs move into `awaySides`.
- Token cached on disk and reused across restarts; automatic backoff on HTTP 429.
- "No Response" in Home when the Pod is offline or the API has not answered for 5 minutes.
