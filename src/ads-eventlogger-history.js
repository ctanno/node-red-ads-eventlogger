/**
 * ads-eventlogger-history  –  Node-RED node
 *
 * Stores the last N EventLogger events in Node-RED global context so they
 * persist across dashboard reloads and (with localfilesystem context store)
 * across Node-RED restarts.
 *
 * Wiring:
 *   Input 1 (top)  : connect to ads-eventlogger-subscribe output → stores events
 *   Input 2 (bottom): query messages → outputs matching history
 *
 * Query messages (send to input 2):
 *   { payload: "getAll" }                     → all stored events
 *   { payload: "getHistory" }                 → alias for getAll
 *   { payload: "clear" }                      → clears history
 *   { payload: { severity: "Error" } }        → events with severity "Error" or higher
 *   { payload: { severityLevel: 3 } }         → same (numeric)
 *   { payload: { sourceName: "MAIN.fb..." } } → events from specific source (substring match)
 *   { payload: { alarmState: "Raised" } }     → only raised / cleared
 *   { payload: { last: 50 } }                 → last 50 events
 *   { payload: { since: "2026-02-26T10:00:00Z" } }  → events after timestamp
 *
 *   Filters can be combined:
 *   { payload: { severity: "Warning", sourceName: "MAIN", last: 100 } }
 */

module.exports = function (RED) {
  function AdsEventloggerHistory(config) {
    RED.nodes.createNode(this, config);

    const node = this;
    const maxEvents = parseInt(config.maxEvents) || 1000;
    const contextKey = config.contextKey || "eventlogger_history";
    const contextStore = config.contextStore || undefined; // default or "file"
    const passthrough = config.passthrough === true;

    // Severity name → level mapping for filter comparisons
    const SEVERITY_MAP = {
      verbose: 0,
      info: 1,
      warning: 2,
      error: 3,
      critical: 4,
    };

    // ---- Load existing history from global context -----------------------
    let events = node.context().global.get(contextKey, contextStore) || [];
    if (!Array.isArray(events)) events = [];
    updateStatus();

    // ---- Helper: persist to global context --------------------------------
    function persist() {
      node.context().global.set(contextKey, events, contextStore);
    }

    // ---- Helper: update node status --------------------------------------
    function updateStatus() {
      node.status({
        fill: events.length >= maxEvents ? "yellow" : "green",
        shape: "dot",
        text: `${events.length} / ${maxEvents} events`,
      });
    }

    // ---- Helper: normalize a date value to ISO string for comparison ------
    function toISOStr(val) {
      if (!val) return null;
      if (val instanceof Date) return val.toISOString();
      return String(val);
    }

    // ---- Helper: find existing event by identity key ----------------------
    function findExistingIndex(eventPayload) {
      // An alarm instance is uniquely identified by eventClass + eventId + timeRaised
      const incomingTime = toISOStr(eventPayload.timeRaised);
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (
          e.eventClass === eventPayload.eventClass &&
          e.eventId === eventPayload.eventId &&
          toISOStr(e.timeRaised) === incomingTime
        ) {
          return i;
        }
      }
      return -1;
    }

    // ---- Helper: add or update an event in the ring buffer ---------------
    function addEvent(eventPayload) {
      const now = new Date().toISOString();
      const existingIdx = findExistingIndex(eventPayload);

      if (existingIdx >= 0) {
        // Update existing entry (e.g. Raised → Cleared)
        events[existingIdx] = {
          ...events[existingIdx],
          ...eventPayload,
          _receivedAt: now,
          _updatedAt: now,
        };
      } else {
        // New event — append
        const entry = {
          ...eventPayload,
          _receivedAt: now,
        };
        events.push(entry);

        // Trim to max size
        if (events.length > maxEvents) {
          events = events.slice(events.length - maxEvents);
        }
      }

      persist();
      updateStatus();
    }

    // ---- Helper: filter events -------------------------------------------
    function filterEvents(query) {
      let result = [...events];

      if (!query || typeof query !== "object") return result;

      // Filter by minimum severity level
      if (query.severity !== undefined) {
        const minLevel =
          typeof query.severity === "string"
            ? SEVERITY_MAP[query.severity.toLowerCase()] ?? 0
            : parseInt(query.severity) || 0;
        result = result.filter((e) => (e.severityLevel ?? 0) >= minLevel);
      }
      if (query.severityLevel !== undefined) {
        const minLevel = parseInt(query.severityLevel) || 0;
        result = result.filter((e) => (e.severityLevel ?? 0) >= minLevel);
      }

      // Filter by source name (substring, case-insensitive)
      if (query.sourceName) {
        const search = query.sourceName.toLowerCase();
        result = result.filter(
          (e) => e.sourceName && e.sourceName.toLowerCase().includes(search)
        );
      }

      // Filter by alarm state
      if (query.alarmState) {
        const state = query.alarmState.toLowerCase();
        result = result.filter(
          (e) => e.alarmState && e.alarmState.toLowerCase() === state
        );
      }

      // Filter by event ID
      if (query.eventId !== undefined) {
        const id = parseInt(query.eventId);
        result = result.filter((e) => e.eventId === id);
      }

      // Filter by event class
      if (query.eventClass) {
        const ec = query.eventClass.toLowerCase();
        result = result.filter(
          (e) => e.eventClass && e.eventClass.toLowerCase() === ec
        );
      }

      // Filter by time (events after a given timestamp)
      if (query.since) {
        const sinceDate = new Date(query.since);
        result = result.filter((e) => {
          const t = e.timeRaised ? new Date(e.timeRaised) : null;
          return t && t >= sinceDate;
        });
      }

      // Limit count (return last N)
      if (query.last) {
        const n = parseInt(query.last);
        if (n > 0 && result.length > n) {
          result = result.slice(result.length - n);
        }
      }

      return result;
    }

    // ---- Input handler ---------------------------------------------------
    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (err) { if (err) node.error(err, msg); };

      // Determine which input received the message.
      // Convention: events from subscribe node have topic "eventlogger"
      // and contain the event payload fields.
      // Query messages use specific payload commands.

      const payload = msg.payload;

      // ---- String commands -----------------------------------------------
      if (typeof payload === "string") {
        const cmd = payload.toLowerCase().trim();

        if (cmd === "getall" || cmd === "gethistory") {
          send({ topic: "eventlogger/history", payload: [...events] });
          done();
          return;
        }

        if (cmd === "clear") {
          events = [];
          persist();
          updateStatus();
          node.log("Event history cleared");
          done();
          return;
        }

        if (cmd === "count") {
          send({ topic: "eventlogger/history", payload: events.length });
          done();
          return;
        }
      }

      // ---- Query object ---------------------------------------------------
      if (typeof payload === "object" && payload !== null) {
        // Is this an event from the subscribe node? Check for event-specific fields.
        if (
          payload.eventClass !== undefined &&
          payload.eventId !== undefined &&
          payload.alarmState !== undefined
        ) {
          // This is an event — store it
          addEvent(payload);
          // Optionally pass the event through to the output
          if (passthrough) {
            send(msg);
          }
          done();
          return;
        }

        // Otherwise treat as a query
        const result = filterEvents(payload);
        send({
          topic: "eventlogger/history",
          payload: result,
          _query: payload,
          _count: result.length,
        });
        done();
        return;
      }

      // Unrecognised input — pass through
      done();
    });

    // ---- Cleanup ---------------------------------------------------------
    node.on("close", function (done) {
      // Ensure latest state is persisted
      persist();
      node.status({});
      done();
    });
  }

  RED.nodes.registerType("ads-eventlogger-history", AdsEventloggerHistory);
};
