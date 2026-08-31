# homebridge-eight-sleep

[![npm](https://img.shields.io/npm/v/homebridge-eight-sleep)](https://www.npmjs.com/package/homebridge-eight-sleep)

Eight Sleep Pod for [Homebridge](https://homebridge.io). Each bed side shows up in the Home app as a Heater/Cooler, plus an optional switch for away mode.

I wanted "Hey Siri, set the bed to cool" and a Leave Home automation that puts the Pod in away mode. Eight Sleep has no HomeKit support and no public API, so this plugin talks to the same cloud endpoints the Eight Sleep app uses. The API layer is a port of [steipete/eightctl](https://github.com/steipete/eightctl).

## What you get

| Accessory | HomeKit type | What it does |
|---|---|---|
| One per bed side ("Omar's Side", "Left Side", …) | Heater/Cooler | Power, Heat/Cool, and an intensity slider |
| Eight Sleep Away | Switch | Away mode on/off for everyone on the Pod |

Sides and names come from your account. A solo Pod gets one tile called "Bed".

### How the slider maps to Eight Sleep levels

Eight Sleep uses a level from -100 (coldest) to +100 (warmest). In HomeKit:

- **Heat / Cool** picks the sign.
- The **intensity slider (0–100 %)** is the magnitude. "Cool at 40 %" is level -40.
- Turning the tile **off** turns the side off. Turning it **on** resumes Autopilot ("smart" mode).
- Moving the slider on an off side turns it on, same as the Eight Sleep app.

The Heater/Cooler tile also has to show a "current temperature". Eight Sleep doesn't report degrees, so the plugin maps the side's current level onto Eight Sleep's published 55–110 °F range. Treat it as a rough indicator, not a thermometer.

## Install

Search for `homebridge-eight-sleep` in the Homebridge UI, or:

```sh
npm install -g homebridge-eight-sleep
```

## Configure

Use the Homebridge UI, or add a platform block:

```json
{
  "platform": "EightSleep",
  "name": "Eight Sleep",
  "email": "you@example.com",
  "password": "your-eight-sleep-password",
  "pollInterval": 60,
  "awaySwitch": true
}
```

| Key | Default | Notes |
|---|---|---|
| `email`, `password` | required | Your Eight Sleep login. Both people on a shared Pod are controlled through the one account. |
| `pollInterval` | `60` | Seconds between state reads. Minimum 30. |
| `awaySwitch` | `true` | Expose the away-mode switch. |
| `leftName`, `rightName` | auto | Override the tile names. |
| `debug` | `false` | Log every poll. |

## Good to know

- **Rate limits.** Eight Sleep throttles this API. The plugin caches its login token on disk (`<homebridge storage>/homebridge-eight-sleep/token.json`, mode 0600) so restarts don't re-authenticate, and it backs off automatically when told to. If you see "rate limiting us" in the log, it will recover on its own.
- **No Response.** If the Pod is offline or the cloud hasn't answered for 5 minutes, the tiles show "No Response" rather than stale state.
- **Latency.** Changes made in the Eight Sleep app show up in HomeKit within one poll interval. Changes from HomeKit are confirmed a few seconds later.
- **Unofficial.** Eight Sleep can change or remove these endpoints at any time. This plugin is not affiliated with Eight Sleep.

## Credits

- [steipete/eightctl](https://github.com/steipete/eightctl) for the reverse-engineered API surface this plugin ports.
- Earlier plugins by [nfarina](https://github.com/nfarina/homebridge-eightsleep) and [tjmehta](https://github.com/tjmehta/homebridge-eightsleep-pod) for the Heater/Cooler idea.

## License

MIT
