/**
 * ads-eventlogger-subscribe  –  Node-RED node
 *
 * Subscribes to TwinCAT 3 EventLogger notifications via ADS and outputs
 * parsed event / alarm objects on its single output.
 *
 * Protocol (discovered via packet capture analysis):
 *   - ADS Port: 132 (EventLogger Publisher V2)
 *   - Subscribe: IG=1, IO=0xFFFF, size=4096, cyclic mode, 0ms cycle time
 *   - Notifications come in two flavours:
 *       a) Heartbeat (16 bytes) – periodic status, no event data
 *       b) Event entry (183+ bytes) – alarm raise / clear / change
 *
 * Binary event layout (verified against live TwinCAT 3.1 Build 4026):
 *
 *   Offset | Size  | Field
 *   -------|-------|-----------------------------------
 *   0      | 4     | version          (always 1)
 *   4      | 2     | messageType      (1=raised, 2=changed, 10=heartbeat)
 *   6      | 2     | source hint      (variable, informational)
 *   8      | 4     | payloadSize      (size of data after this field)
 *   12     | 16    | eventClass       (GUID, mixed-endian)
 *   28     | 4     | eventId
 *   32     | 4     | flags            (varies, not severity)
 *   36     | 1     | severity         (0=Verbose,1=Info,2=Warning,3=Error,4=Critical)
 *   37     | 3     | reserved
 *   40     | 4     | eventKind        (2 = alarm)
 *   44     | 4     | totalSize        (0x78 = 120)
 *   48     | 4     | field48          (0x2F = 47)
 *   52     | 1     | raisedFlag       (1=raised, 0=cleared/confirmed)
 *   53     | 3     | flags bytes
 *   56     | 4     | field56
 *   60     | 8     | timeRaised       (FILETIME)
 *   68     | 8     | timeCleared      (FILETIME, 0 = n/a)
 *   76     | 8     | timeConfirmed    (FILETIME, 0 = n/a)
 *   84..   | var   | structure data + string table
 *   ~152   | 4     | sourceNameLen    (incl. null terminator)
 *   ~160   | var   | sourceName       (ASCII, null-terminated)
 *   …      | var   | message data     (may be truncated)
 */

const constants = require("./eventlogger-constants");

module.exports = function (RED) {
  function AdsEventloggerSubscribe(config) {
    RED.nodes.createNode(this, config);

    const node = this;

    // Editor properties
    node.connection = RED.nodes.getNode(config.connection);
    node.minSeverity = parseInt(config.minSeverity) || 0;

    // ---- guard: no connection configured ----------------------------------
    if (!node.connection) {
      node.status({
        fill: "red",
        shape: "ring",
        text: "no connection configured",
      });
      return;
    }

    const eventEmitter = node.connection.getEventEmitter();

    // ---- binary parser ----------------------------------------------------

    /** Minimum size for a valid event entry (header + GUID + timestamps) */
    const MIN_EVENT_SIZE = 84;

    /** Size of a heartbeat notification */
    const HEARTBEAT_SIZE = 16;

    /**
     * Parse a single event entry from a Buffer.
     * Returns an object or null on failure.
     */
    function parseEventEntry(data) {
      if (!Buffer.isBuffer(data) || data.length < MIN_EVENT_SIZE) {
        node.warn(
          `Event data too short (${data.length} bytes, need >= ${MIN_EVENT_SIZE})`
        );
        return null;
      }

      const entry = {};

      // ---- header (bytes 0-11) -------------------------------------------
      entry.version = data.readUInt32LE(0);
      entry.messageType = data.readUInt16LE(4);
      entry.payloadSize = data.readUInt32LE(8);

      // ---- event identity (bytes 12-31) ----------------------------------
      entry.eventClass = constants.parseGuid(data, 12);
      entry.eventId = data.readUInt32LE(28);

      // ---- severity (byte 36) ---------------------------------------------
      // Severity is a UINT8 at offset 36 (0=Verbose, 1=Info, 2=Warning, 3=Error, 4=Critical)
      const severityRaw = data.readUInt8(36);
      entry.severityRaw = severityRaw;
      if (severityRaw <= 4) {
        entry.severityLevel = severityRaw;
        entry.severity = constants.SEVERITY_STR[severityRaw] || `Unknown(${severityRaw})`;
      } else {
        // Use Verbose as fallback for unrecognised values
        entry.severityLevel = 0;
        entry.severity = "Verbose";
      }

      // ---- alarm fields (bytes 36-83) ------------------------------------
      entry.eventKind = data.readUInt32LE(40);
      entry.isAlarm = entry.eventKind === 2;

      // Raised flag: byte 52 (1=raised, 0=cleared/confirmed)
      const raisedFlag = data.readUInt8(52);
      if (raisedFlag === 1) {
        entry.alarmState = "Raised";
        entry.alarmStateValue = constants.ALARM_STATE.RAISED;
      } else {
        entry.alarmState = "Cleared";
        entry.alarmStateValue = constants.ALARM_STATE.CLEARED;
      }

      // ---- timestamps (bytes 60-83) --------------------------------------
      entry.timeRaised = constants.parseFileTime(data, 60);
      entry.timeCleared = constants.parseFileTime(data, 68);
      entry.timeConfirmed = constants.parseFileTime(data, 76);

      // ---- source name (scan for ASCII string near end of data) ----------
      entry.sourceName = "";
      entry.message = "";

      // The source name is an ASCII null-terminated string.
      // Its length is at offset 152 (UINT32), and it starts at the
      // offset indicated by the string table.  We scan for it by
      // looking for the longest printable string in the tail section.
      if (data.length > 128) {
        const strings = findAsciiStrings(data, 128);
        if (strings.length >= 1) {
          entry.sourceName = strings[0].text;
        }
        if (strings.length >= 2) {
          entry.message = strings[1].text;
        }
      }

      return entry;
    }

    /**
     * Find ASCII strings (>= 3 printable chars) in a buffer region.
     */
    function findAsciiStrings(buf, startOffset) {
      const strings = [];
      let start = -1;
      for (let i = startOffset; i < buf.length; i++) {
        if (buf[i] >= 0x20 && buf[i] < 0x7f) {
          if (start === -1) start = i;
        } else {
          if (start !== -1 && i - start >= 3) {
            strings.push({ offset: start, text: buf.toString("ascii", start, i) });
          }
          start = -1;
        }
      }
      if (start !== -1 && buf.length - start >= 3) {
        strings.push({ offset: start, text: buf.toString("ascii", start, buf.length) });
      }
      return strings;
    }

    // ---- output -----------------------------------------------------------

    /**
     * Build a Node-RED msg from a parsed event and send it on output 0.
     */
    function sendEvent(entry) {
      // Severity filter
      if (entry.severityLevel < node.minSeverity) return;

      const msg = {
        topic: "eventlogger",
        payload: {
          eventClass: entry.eventClass,
          eventId: entry.eventId,
          severity: entry.severity,
          severityLevel: entry.severityLevel,
          timeRaised: entry.timeRaised,
          timeCleared: entry.timeCleared,
          timeConfirmed: entry.timeConfirmed,
          alarmState: entry.alarmState,
          isAlarm: entry.isAlarm,
          sourceName: entry.sourceName,
          message: entry.message,
        },
      };

      node.send(msg);
    }

    // ---- subscribe / unsubscribe ------------------------------------------

    async function subscribe() {
      if (!node.connection) return;

      try {
        node.status({ fill: "yellow", shape: "dot", text: "subscribing..." });

        // Register with the connection node's shared subscription.
        // The connection node owns the single ADS subscription (IG=1/IO=0xFFFF)
        // and emits "eventData" events to all subscribe nodes.
        await node.connection.addSubscriber();

        node.status({ fill: "green", shape: "dot", text: "subscribed" });
        node.log("Subscribed to EventLogger notifications on port 132");
      } catch (err) {
        node.status({
          fill: "red",
          shape: "dot",
          text: `subscribe failed: ${err.message}`,
        });
        node.error(`Failed to subscribe to EventLogger: ${err.message}`);
      }
    }

    async function unsubscribe() {
      if (!node.connection) return;
      try {
        await node.connection.removeSubscriber();
        node.log("Unsubscribed from EventLogger");
      } catch (err) {
        node.warn(`Error unsubscribing: ${err.message}`);
      }
    }

    // ---- event data listener (from shared subscription) -------------------

    function onEventData(data) {
      try {
        const buffer = data.value;
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) return;

        // Skip heartbeat notifications (16 bytes, messageType = 0x0A)
        if (buffer.length <= HEARTBEAT_SIZE) return;

        // Parse the event entry
        const entry = parseEventEntry(buffer);
        if (entry) sendEvent(entry);
      } catch (err) {
        node.error(`Error processing event notification: ${err.message}`);
      }
    }

    eventEmitter.on("eventData", onEventData);

    // ---- connection state -------------------------------------------------

    function onConnectionStateChange(connected) {
      if (connected) {
        node.status({ fill: "green", shape: "ring", text: "connected" });
        subscribe();
      } else {
        node.status({ fill: "red", shape: "ring", text: "disconnected" });
      }
    }

    eventEmitter.on("connected", onConnectionStateChange);

    // Determine initial state
    if (node.connection.isConnected()) {
      subscribe();
    } else if (node.connection.isConnecting()) {
      node.status({ fill: "yellow", shape: "ring", text: "connecting..." });
    } else {
      node.status({ fill: "red", shape: "ring", text: "disconnected" });
    }

    // ---- input handler ----------------------------------------------------
    node.on("input", async function (msg) {
      if (msg.payload === "resubscribe") {
        await unsubscribe();
        await subscribe();
      }
    });

    // ---- cleanup ----------------------------------------------------------
    node.on("close", async (done) => {
      eventEmitter.removeListener("connected", onConnectionStateChange);
      eventEmitter.removeListener("eventData", onEventData);
      await unsubscribe();
      node.status({});
      done();
    });
  }

  RED.nodes.registerType("ads-eventlogger-subscribe", AdsEventloggerSubscribe);
};
