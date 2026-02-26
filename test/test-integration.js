/**
 * Integration test for node-red-ads-eventlogger
 * 
 * Verifies:
 *   1. Connection to EventLogger Publisher on port 132
 *   2. Subscription with IG=1, IO=0xFFFF, size=4096, cyclic mode
 *   3. Heartbeat filtering (16-byte notifications are skipped)
 *   4. Event binary parsing (GUID, eventId, timestamps, sourceName, alarmState)
 * 
 * Usage: node test/test-integration.js [targetAmsNetId]
 * Then trigger bTriggerAlarm := TRUE in the PLC.
 */

const ads = require('ads-client');
const constants = require('../src/eventlogger-constants');

const TARGET = process.argv[2] || 'localhost';

/** Parse event entry - mirrors the logic in ads-eventlogger-subscribe.js */
function parseEventEntry(data) {
  if (!Buffer.isBuffer(data) || data.length < 84) return null;

  const entry = {};

  // Header
  entry.version = data.readUInt32LE(0);
  entry.messageType = data.readUInt16LE(4);
  entry.payloadSize = data.readUInt32LE(8);

  // Event identity
  entry.eventClass = constants.parseGuid(data, 12);
  entry.eventId = data.readUInt32LE(28);

  // Severity
  const severityRaw = data.readUInt32LE(32);
  entry.severityRaw = severityRaw;
  if (severityRaw <= 4) {
    entry.severityLevel = severityRaw;
    entry.severity = constants.SEVERITY_STR[severityRaw];
  } else {
    entry.severityLevel = 0;
    entry.severity = 'Verbose';
  }

  // Alarm
  entry.eventKind = data.readUInt32LE(40);
  entry.isAlarm = entry.eventKind === 2;

  const raisedFlag = data.readUInt8(52);
  entry.alarmState = raisedFlag === 1 ? 'Raised' : 'Cleared';

  // Timestamps
  entry.timeRaised = constants.parseFileTime(data, 60);
  entry.timeCleared = constants.parseFileTime(data, 68);
  entry.timeConfirmed = constants.parseFileTime(data, 76);

  // Source name (scan for ASCII strings after offset 128)
  entry.sourceName = '';
  entry.message = '';
  if (data.length > 128) {
    let start = -1;
    const strings = [];
    for (let i = 128; i < data.length; i++) {
      if (data[i] >= 0x20 && data[i] < 0x7f) {
        if (start === -1) start = i;
      } else {
        if (start !== -1 && i - start >= 3) {
          strings.push(data.toString('ascii', start, i));
        }
        start = -1;
      }
    }
    if (start !== -1 && data.length - start >= 3) {
      strings.push(data.toString('ascii', start, data.length));
    }
    if (strings.length >= 1) entry.sourceName = strings[0];
    if (strings.length >= 2) entry.message = strings[1];
  }

  return entry;
}

async function main() {
  console.log(`=== EventLogger Integration Test ===`);
  console.log(`Target: ${TARGET}:${constants.ADS_PORT_EVENTLOGGER}`);
  console.log(`Subscribe: IG=${constants.SUBSCRIBE_INDEX_GROUP}, IO=0x${constants.SUBSCRIBE_INDEX_OFFSET.toString(16)}, size=${constants.SUBSCRIBE_BUFFER_SIZE}\n`);

  const client = new ads.Client({
    targetAmsNetId: TARGET,
    targetAdsPort: constants.ADS_PORT_EVENTLOGGER,
    rawClient: true,
    autoReconnect: false,
  });

  const res = await client.connect();
  console.log(`✓ Connected (local port ${res.localAdsPort})`);

  let heartbeatCount = 0;
  let eventCount = 0;

  await client.subscribeRaw(
    constants.SUBSCRIBE_INDEX_GROUP,
    constants.SUBSCRIBE_INDEX_OFFSET,
    constants.SUBSCRIBE_BUFFER_SIZE,
    (data) => {
      const buf = data.value;

      // Heartbeat filtering
      if (buf.length <= 16) {
        heartbeatCount++;
        if (heartbeatCount === 1) {
          console.log(`✓ First heartbeat received (${buf.length} bytes) - filtering active`);
        }
        return;
      }

      // Event!
      eventCount++;
      const entry = parseEventEntry(buf);
      if (!entry) {
        console.log(`✗ Failed to parse event (${buf.length} bytes)`);
        return;
      }

      console.log(`\n--- Event #${eventCount} (${buf.length} bytes) ---`);
      console.log(`  eventClass:   ${entry.eventClass}`);
      console.log(`  eventId:      ${entry.eventId}`);
      console.log(`  severity:     ${entry.severity} (raw: 0x${entry.severityRaw.toString(16)})`);
      console.log(`  isAlarm:      ${entry.isAlarm}`);
      console.log(`  alarmState:   ${entry.alarmState}`);
      console.log(`  timeRaised:   ${entry.timeRaised ? entry.timeRaised.toISOString() : 'null'}`);
      console.log(`  timeCleared:  ${entry.timeCleared ? entry.timeCleared.toISOString() : 'null'}`);
      console.log(`  timeConfirmed:${entry.timeConfirmed ? entry.timeConfirmed.toISOString() : 'null'}`);
      console.log(`  sourceName:   "${entry.sourceName}"`);
      console.log(`  message:      "${entry.message}"`);
    },
    0,     // cycle time
    false  // cyclic mode
  );

  console.log(`✓ Subscribed!`);
  console.log(`\nWaiting for events... Set bTriggerAlarm := TRUE in the PLC`);
  console.log(`(Alarm will auto-clear after 10 seconds)\n`);

  // Wait 120 seconds
  await new Promise(r => setTimeout(r, 120000));

  console.log(`\n=== Summary ===`);
  console.log(`Heartbeats: ${heartbeatCount}`);
  console.log(`Events:     ${eventCount}`);

  await client.disconnect();
  console.log('Disconnected.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
