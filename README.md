![Logo](admin/staleguard.png)
# ioBroker.staleguard

[![NPM version](https://img.shields.io/npm/v/iobroker.staleguard.svg)](https://www.npmjs.com/package/iobroker.staleguard)
[![Downloads](https://img.shields.io/npm/dm/iobroker.staleguard.svg)](https://www.npmjs.com/package/iobroker.staleguard)
![Number of Installations](https://iobroker.live/badges/staleguard-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/staleguard-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.staleguard.png?downloads=true)](https://nodei.co/npm/iobroker.staleguard/)

**Tests:** ![Test and Release](https://github.com/typhosj/ioBroker.staleguard/workflows/Test%20and%20Release/badge.svg)

## Staleguard adapter for ioBroker

### What it does

Staleguard tells you when an ioBroker state has stopped receiving data. You mark any state in the
object browser and give it a deadline. When the state stays silent longer than that, Staleguard
raises an ioBroker notification, can restart the adapter instance that owns the state, and reports
when data arrives again.

It watches states, not devices or adapters, so it works with any adapter and with your own scripts.
Typical cases:

- a cloud adapter keeps `info.connection` true, but its values stopped moving;
- a Shelly, Zigbee or radio sensor stopped reporting;
- a script stopped writing its heartbeat state.

### Setup

1. Install the adapter and create an instance. The defaults work for most systems.
2. Open **Objects**, click the gear icon (custom settings) of the state you want to watch, and
   enable `staleguard.0`.
3. Set the fields:

| Field | Range | Default | Meaning |
|---|---|---|---|
| Watch this state | on / off | off | watch this state |
| Deadline (min) | 1–10080 | 60 | alarm when there is no sign of life for this long (max. 7 days) |
| Sign of life | Any update / Value change | Any update | which timestamp counts, see below |
| Instance restarts per outage | 0–5 | 0 | restart the owning instance, 0 = off |

Instance settings:

| Setting | Range | Default | Meaning |
|---|---|---|---|
| Check interval (s) | 10–600 | 60 | how often all watched states are checked |
| Restart lock (min) | 10–1440 | 60 | minimum time between two restarts of the same instance |

Invalid per-state settings are not replaced by defaults: the watch is rejected and reported as a
notification, so you notice the mistake.

### Any update or value change

- **Any update** checks the time of the last write (`ts`). Use it for sensors and scripts that
  write only when they have something new.
- **Value change** checks the time of the last value change (`lc`). Cloud adapters often rewrite
  the same value with a new timestamp on every poll, so frozen cloud data only shows up with this
  mode.

Values that legitimately stay constant for a long time (PV power at night, the charge level of a
parked car) cause false alarms with **Value change**. For frozen cloud data, watch a timestamp the
cloud itself delivers (`lastSeen` or similar) with **Value change** instead.

After Staleguard starts, every watched state gets its full deadline before it can be reported, so a
host reboot does not cause a burst of alarms for states that were already old.

### Notifications

Staleguard raises ioBroker notifications in the scope `staleguard`. They appear in the admin
notification area; [notification-manager](https://github.com/foxriver76/ioBroker.notification-manager)
forwards them to Telegram, e-mail and other messengers. Staleguard contains no delivery code itself.

| Category | Severity | When |
|---|---|---|
| State silent | alert | a state missed its deadline; the last restart attempt did not help |
| State back | info | a silent state is sending again |
| Watch problem | notify | the state does not exist or has no value, a setting is invalid, a restart failed |

A state is reported once when it goes silent and once when it comes back, not on every check. The
texts are written in German on a German system and in English otherwise.

### Instance restarts

With **Instance restarts per outage** above 0, Staleguard restarts the adapter instance the state
belongs to (`<adapter>.<n>`):

- the first restart comes as soon as the state is silent;
- each further restart comes one full deadline after the previous one, if the state is still silent;
- several silent states of one instance cause at most one restart per **Restart lock**;
- after the last attempt, one more notification says that no further attempts follow;
- a disabled instance is never started, and Staleguard never restarts itself;
- a failed restart is reported and still counts as an attempt.

Restarts are only possible for states of another adapter instance, not for `0_userdata`, `alias`
or `system` states.

### States

| State | Type | Meaning |
|---|---|---|
| `staleguard.0.summary.watched` | number | number of watched states |
| `staleguard.0.summary.stale` | number | number of silent states |
| `staleguard.0.summary.list` | JSON | `[{id, name, status, since}]` of all watches |
| `staleguard.0.watches.<id>.stale` | boolean | `true` = silent |
| `staleguard.0.watches.<id>.status` | string | `ok`, `stale` or `missing` |
| `staleguard.0.watches.<id>.since` | number | time of the last status change |
| `staleguard.0.watches.<id>.restarts` | number | restart attempts in the current outage |

`<id>` is the watched state id with `.` replaced by `__`. All states are read-only. When a watch
is disabled, its channel is removed.

### Limits

- At most 5000 watched states; further entries are rejected and reported.
- A watched object that is deleted at runtime shows `missing` until Staleguard restarts.
- A timestamp in the future (the clock moved back) keeps a watch `ok` until the clock catches up.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (typhosj) initial release

## License
MIT License

Copyright (c) 2026 typhosj <typhosj@gmx.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.