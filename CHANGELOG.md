# Changelog

## 1.0.0 (2026-08-31)

Initial release.

- Heater/Cooler accessory per bed side: power, Heat/Cool, 0–100 % intensity mapped to Eight Sleep level -100..100.
- Heating/cooling threshold temperatures on the same 55–110 °F pseudo-scale, so the Home tile reads "Cooling to 77°" instead of "(null)" and the dial sets the level.
- Optional away-mode Switch per person ("Omar Away"), since Eight Sleep tracks away mode per user.
- Away switches read each person's authoritative away-mode endpoint instead of treating `awaySides` assignment data as live state.
- Away writes match `eightctl` timestamps exactly and keep their accepted state while Eight Sleep's eventually consistent status catches up.
- Sides and names discovered from the account; keeps the stable left/right mapping when top-level IDs collapse during away mode.
- Token cached on disk and reused across restarts; automatic backoff on HTTP 429.
- "No Response" in Home when the Pod is offline or the API has not answered for 5 minutes.
