/**
 * TwinCAT 3 EventLogger ADS Protocol Constants & Helpers
 *
 * Protocol discovered via packet capture analysis:
 *   - ADS Port 132 = "EventLogger Publisher (V2)"
 *   - Subscription: IG=1, IO=0xFFFF, size=4096, cyclic, 0ms
 *   - Notifications: 16-byte heartbeats + 183+ byte event entries
 *
 * References:
 * - Beckhoff InfoSys: AMS Port Numbers
 *   https://infosys.beckhoff.com/index.php?content=../content/1031/tc3_grundlagen/116159883.html
 * - Port 100 = TwinCAT Logger (text-based system messages, different!)
 * - Port 110 = EventLogger V1 (does not accept subscriptions)
 * - Port 130 = EventLogger UserMode V2
 * - Port 131 = EventLogger Realtime V2
 * - Port 132 = EventLogger Publisher V2 (the one we subscribe to)
 */

/** ADS port for the TwinCAT 3 EventLogger Publisher (V2) service */
const ADS_PORT_EVENTLOGGER = 132;

/** Subscription parameters */
const SUBSCRIBE_INDEX_GROUP = 1;
const SUBSCRIBE_INDEX_OFFSET = 0xFFFF;
const SUBSCRIBE_BUFFER_SIZE = 4096;

/**
 * Notification message types (UINT16 at byte offset 4)
 */
const MSG_TYPE = {
  ALARM_RAISED: 1,
  ALARM_CHANGED: 2,
  HEARTBEAT: 10,
};

/**
 * EventLogger severity levels (TcEventSeverity)
 * Matches the TwinCAT enum definition.
 */
const SEVERITY = {
  VERBOSE: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
  CRITICAL: 4,
};

const SEVERITY_STR = {
  [SEVERITY.VERBOSE]: "Verbose",
  [SEVERITY.INFO]: "Info",
  [SEVERITY.WARNING]: "Warning",
  [SEVERITY.ERROR]: "Error",
  [SEVERITY.CRITICAL]: "Critical",
};

/**
 * Alarm states
 *
 * Derived from observation:
 *   - "Raised" event: byte[52] = 1, timeConfirmed = null, timeCleared = null
 *   - "Cleared" event: byte[52] = 0, timeConfirmed filled in
 */
const ALARM_STATE = {
  RAISED: 1,    // byte[52] = 1
  CLEARED: 0,   // byte[52] = 0
};

const ALARM_STATE_STR = {
  [ALARM_STATE.RAISED]: "Raised",
  [ALARM_STATE.CLEARED]: "Cleared",
};

// ---------------------------------------------------------------------------
// Binary helpers
// ---------------------------------------------------------------------------

/**
 * Parse a GUID from a 16-byte buffer segment.
 * GUID binary layout (mixed-endian):
 *   Data1 (4 bytes LE) - Data2 (2 bytes LE) - Data3 (2 bytes LE) - Data4 (8 bytes BE)
 *
 * Returns string "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 */
function parseGuid(buffer, offset) {
  if (buffer.length < offset + 16) return null;

  const data1 = buffer.readUInt32LE(offset).toString(16).padStart(8, "0");
  const data2 = buffer.readUInt16LE(offset + 4).toString(16).padStart(4, "0");
  const data3 = buffer.readUInt16LE(offset + 6).toString(16).padStart(4, "0");
  const data4High = buffer.subarray(offset + 8, offset + 10).toString("hex");
  const data4Low = buffer.subarray(offset + 10, offset + 16).toString("hex");

  return `${data1}-${data2}-${data3}-${data4High}-${data4Low}`;
}

/**
 * Parse a Windows FILETIME (100 ns intervals since 1601-01-01) to a Date.
 * Stored as two 32-bit LE values (low, high).
 * Returns null for zero / empty timestamps.
 */
function parseFileTime(buffer, offset) {
  if (buffer.length < offset + 8) return null;

  const low = buffer.readUInt32LE(offset);
  const high = buffer.readUInt32LE(offset + 4);

  if (low === 0 && high === 0) return null;

  // FILETIME → ms since Unix epoch
  const fileTimeMs = (high * 0x100000000 + low) / 10000;
  const unixMs = fileTimeMs - 11644473600000;

  return new Date(unixMs);
}

/**
 * Decode a UTF-16LE encoded string from a buffer range.
 * Strips null terminators.
 */
function parseUtf16String(buffer, offset, byteLength) {
  if (byteLength <= 0 || buffer.length < offset + byteLength) return "";

  let str = buffer.subarray(offset, offset + byteLength).toString("utf16le");

  const nullIdx = str.indexOf("\0");
  if (nullIdx !== -1) {
    str = str.substring(0, nullIdx);
  }
  return str;
}

module.exports = {
  ADS_PORT_EVENTLOGGER,
  SUBSCRIBE_INDEX_GROUP,
  SUBSCRIBE_INDEX_OFFSET,
  SUBSCRIBE_BUFFER_SIZE,
  MSG_TYPE,
  SEVERITY,
  SEVERITY_STR,
  ALARM_STATE,
  ALARM_STATE_STR,
  parseGuid,
  parseFileTime,
  parseUtf16String,
};
