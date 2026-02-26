# node-red-ads-eventlogger

Node-RED nodes for subscribing to **Beckhoff TwinCAT 3 EventLogger** events and alarms via ADS protocol.

Uses [ads-client](https://github.com/jisotalo/ads-client) (v2.x) in raw mode to communicate directly with the EventLogger Publisher V2 on ADS port 132.

> **TwinCAT 3 Build 4022+ required.**

---

## Features

- Subscribe to EventLogger notifications (events **and** alarms)
- Automatic binary parsing of event data (GUIDs, timestamps, UTF-16LE strings)
- Configurable severity filter (Verbose / Info / Warning / Error / Critical)
- Event history storage in Node-RED global context (survives dashboard reloads)
- Automatic deduplication: cleared events update existing raised entries
- Auto-reconnect with configurable retry interval
- Shared connection config node (multiple subscriber nodes can share one connection)

## Installation

### From a local folder (development)

```bash
cd ~/.node-red
npm install /path/to/node-red-ads-eventlogger
```

### From npm (once published)

```bash
cd ~/.node-red
npm install node-red-ads-eventlogger
```

Then restart Node-RED.

## Nodes

### ads-eventlogger-connection (config node)

Manages the ADS connection to the TwinCAT system.

| Setting             | Description                                             | Default  |
| ------------------- | ------------------------------------------------------- | -------- |
| Target AmsNetId     | AMS Net ID of the TwinCAT target (e.g. `192.168.1.1.1.1`) | required |
| Target ADS Port     | ADS port of the EventLogger service                     | `132`    |
| Router Address      | IP/hostname of the ADS router (empty = local)           | —        |
| Router TCP Port     | TCP port of the ADS router                              | `48898`  |
| Local AmsNetId      | Override local AMS Net ID (empty = auto)                | —        |
| Local ADS Port      | Override local ADS port (empty = auto)                  | —        |
| Auto Reconnect      | Reconnect automatically on disconnect                   | `true`   |
| Reconnect Interval  | Milliseconds between reconnection attempts              | `2000`   |
| Timeout             | ADS request timeout in milliseconds                     | `5000`   |

### ads-eventlogger-subscribe

Subscribes to EventLogger notifications and outputs parsed event messages.

| Setting       | Description                                        | Default        |
| ------------- | -------------------------------------------------- | -------------- |
| Connection    | Reference to an `ads-eventlogger-connection` node   | required       |
| Min. Severity | Only output events at or above this severity level  | Verbose (all)  |

#### Output `msg.payload`

```jsonc
{
  "eventClass":     "160d9f14-d97e-4462-afad-ea4cd48296b4",
  "eventId":        1,
  "severity":       "Verbose",        // human-readable
  "severityLevel":  0,               // numeric (0-4)
  "timeRaised":     "2026-02-26T09:36:22.400Z",
  "timeCleared":    null,            // null until alarm is cleared
  "timeConfirmed":  null,            // null until alarm is confirmed
  "alarmState":     "Raised",        // Raised | Cleared
  "isAlarm":        true,
  "sourceName":     "MAIN.fbEventTester",
  "message":        ""
}
```

- `msg.topic` is always `"eventlogger"`.

#### Input

Send `msg.payload = "resubscribe"` to drop and re-create the subscription.

### ads-eventlogger-history

Stores events in Node-RED's **global context** so they survive dashboard reloads and (optionally) Node-RED restarts.

| Setting        | Description                                                   | Default                |
| -------------- | ------------------------------------------------------------- | ---------------------- |
| Max Events     | Maximum events to keep (oldest discarded first)               | `1000`                 |
| Context Key    | Global context key name                                       | `eventlogger_history`  |
| Context Store  | Context store (`""` = default memory, `"file"` = persistent)  | `""` (default)         |
| Pass through   | Forward incoming events to the output                         | `false`                |

#### Wiring

Wire the output of an **eventlogger subscribe** node into this node. Events are stored automatically and deduplicated — when a cleared event arrives matching an existing raised event (same `eventClass` + `eventId` + `timeRaised`), the entry is updated in-place.

#### Query interface

Send a message to the input to query the history:

| `msg.payload`                              | Response                                 |
| ------------------------------------------ | ---------------------------------------- |
| `"getAll"` / `"getHistory"`                | All stored events                        |
| `"clear"`                                  | Clears all stored events                 |
| `"count"`                                  | Number of stored events                  |
| `{ severity: "Warning" }`                  | Events ≥ Warning severity               |
| `{ sourceName: "MAIN" }`                   | Events matching source (substring)       |
| `{ alarmState: "Raised" }`                 | Only raised events                       |
| `{ last: 50 }`                             | Last 50 events                           |
| `{ since: "2026-02-26T10:00:00Z" }`        | Events after timestamp                   |

Filters can be combined: `{ severity: "Warning", sourceName: "MAIN", last: 100 }`

#### Dashboard integration

Because events are stored in global context, dashboard nodes can read them directly:

```js
// In a function node:
const events = global.get("eventlogger_history") || [];
```

## Status Indicators

| Colour / Shape    | Meaning                       |
| ----------------- | ----------------------------- |
| 🟢 green dot      | Subscribed, receiving events  |
| 🟡 yellow dot     | Subscribing in progress       |
| 🟢 green ring     | Connected, not yet subscribed |
| 🔴 red ring       | Disconnected                  |
| 🔴 red dot        | Subscription failed           |

## Notes

- **ADS Port 132** is the EventLogger Publisher V2 port. This is different from port 100 (TwinCAT Logger for system text messages) and port 110 (EventLogger V1, which does not accept subscriptions).
- The subscription uses Index Group 1, Index Offset 0xFFFF with cyclic mode and 0ms cycle time (immediate delivery). These values were determined through packet capture analysis.
- The binary event structure was reverse-engineered from live TwinCAT 3.1 Build 4026 traffic. It may vary between TwinCAT versions. The parser handles minor variations defensively.
- The EventLogger sends periodic 16-byte heartbeat notifications which are automatically filtered out.
- For remote connections (Node-RED running on a different machine than TwinCAT), configure the **Router Address** to point to the TwinCAT system's ADS router and ensure the ADS route is set up on both sides.

## References

- [Beckhoff TwinCAT 3 EventLogger Documentation](https://infosys.beckhoff.com/english.php?content=../content/1033/tc3_eventlogger/index.html)
- [ads-client library (GitHub)](https://github.com/jisotalo/ads-client)
- [node-red-contrib-ads-client (reference)](https://github.com/jisotalo/node-red-contrib-ads-client)

## License

MIT
