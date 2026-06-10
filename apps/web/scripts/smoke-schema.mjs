// Smoke test for schema-version mismatch detection.
// Mirrors TC-T6-110 from docs/test-cases/T6-frontend-wire.md.
//
// Backend rejects WS envelopes with schemaVersion !== CURRENT_SCHEMA_VERSION
// and closes the connection with code 4001 ("schema mismatch"). This guards
// against shipping a frontend bundle older than the backend's contract.
//
// Scenario:
//   1. Login + open WS
//   2. Send ROOM_JOIN with SCHEMA_VERSION + 1
//   3. Assert: connection closes with code 4001 (NOT a normal close)
//
// Usage:
//   make up && make seed
//   cd apps/web && node scripts/smoke-schema.mjs

import { WebSocket } from 'ws';
import { resolveAuctionId, SCHEMA_VERSION, login } from './smoke-shared.mjs';

const HOST_HTTP = process.env.HOST_HTTP || process.env.WS_HOST || 'http://localhost:8080';
const HOST_WS = process.env.HOST_WS || process.env.WS_ADDR || 'ws://localhost:8080';
const AUCTION_ID = resolveAuctionId({ scriptName: 'smoke-schema' });

const errors = [];
const must = (cond, msg) => { if (!cond) errors.push(msg); };

const { token } = await login(HOST_HTTP, 'fari-schema');
const url = `${HOST_WS}/ws?token=${encodeURIComponent(token)}&auction=${encodeURIComponent(AUCTION_ID)}`;
const ws = new WebSocket(url);

let closeCode = null;
let closeReason = '';
let receivedSchemaErr = false;

await new Promise((resolve) => {
  ws.on('open', () => {
    console.log('ws open · sending bad-schema ROOM_JOIN');
    ws.send(JSON.stringify({
      schemaVersion: SCHEMA_VERSION + 1,
      type: 'ROOM_JOIN',
      auctionId: AUCTION_ID,
      serverTimeMs: Date.now(),
      data: { auctionId: AUCTION_ID },
    }));
  });
  ws.on('message', (raw) => {
    try {
      const env = JSON.parse(raw.toString());
      // Backend MAY send a SCHEMA_ERROR envelope before closing
      if (env.type === 'SCHEMA_ERROR' || env.data?.code === 'ERR_SCHEMA') {
        receivedSchemaErr = true;
      }
      console.log('← recv', env.type, env.data?.code || '');
    } catch (e) { /* ignore non-JSON */ }
  });
  ws.on('close', (code, reason) => {
    closeCode = code;
    closeReason = reason?.toString() || '';
    console.log('ws close · code=' + code + ' reason=' + closeReason);
    resolve();
  });
  ws.on('error', (e) => console.log('ws error', e.message));
  setTimeout(resolve, 3000);
});

// Backend's contract: 4001 = schema mismatch (per proto/ws-envelope.md)
// Acceptable: 4001 typed close OR generic 1006 (abnormal) with envelope hint
must(
  closeCode === 4001 || receivedSchemaErr,
  `expected close code 4001 (schema) or SCHEMA_ERROR envelope; got code=${closeCode} reason="${closeReason}" schemaErr=${receivedSchemaErr}`,
);

console.log('\n=== results ===');
if (errors.length === 0) {
  console.log('✓ TC-T6-110 schema-mismatch smoke PASSED');
  process.exit(0);
} else {
  console.log('✗ ' + errors.length + ' FAILURES:');
  errors.forEach((e) => console.log('  · ' + e));
  process.exit(1);
}
