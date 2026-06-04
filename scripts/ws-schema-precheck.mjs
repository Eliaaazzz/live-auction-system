#!/usr/bin/env node
// Minimal WS preflight for schema contract guard:
// connect -> send ROOM_JOIN -> assert first schema-bearing server envelope
// carries the expected schemaVersion.

function usage() {
  console.error('usage: ws-schema-precheck.mjs --url <ws_url> --auction <auction-id> --schema <n> [--token <token>] [--timeout-ms <ms>]');
  process.exit(2);
}

function parseArgs(argv) {
  const out = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--url':
      case '--auction':
      case '--token':
      case '--schema':
      case '--timeout-ms': {
        const value = argv[i + 1];
        if (!value) usage();
        out[arg.slice(2)] = value;
        i += 1;
        break;
      }
      case '-h':
      case '--help':
        usage();
        break;
      default:
        usage();
    }
  }
  return out;
}

function isPositiveInt(v) {
  return /^[1-9][0-9]*$/.test(String(v));
}

const args = parseArgs(process.argv.slice(2));
const wsUrl = args.url;
const auctionId = args.auction || process.env.WS_PRECHECK_AUCTION || process.env.AID || '';
const expectedSchemaRaw = args.schema || process.env.WS_PRECHECK_SCHEMA || process.env.SCHEMA_VERSION;
const expectedSchema = Number(expectedSchemaRaw);
const timeoutMs = Number(args['timeout-ms'] || process.env.WS_PRECHECK_TIMEOUT_MS || '8000');
const token = args.token || process.env.WS_PRECHECK_TOKEN || '';

if (!wsUrl || !auctionId || !isPositiveInt(expectedSchema) || !isPositiveInt(timeoutMs)) {
  usage();
}

async function loadWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;

  try {
    const wsPkg = await import('ws');
    if (typeof wsPkg.WebSocket === 'function') return wsPkg.WebSocket;
  } catch (_) {
    // fallthrough
  }

  console.error('[ws-schema-precheck] WebSocket runtime unavailable. Node 20+ has global WebSocket, or install ws in this environment.');
  process.exit(1);
}

async function main() {
  const WebSocket = await loadWebSocket();
  const endpoint = new URL(wsUrl);
  if (!/^wss?:$/.test(endpoint.protocol)) {
    console.error(`[ws-schema-precheck] invalid wsUrl protocol "${endpoint.protocol}", expected ws or wss`);
    process.exit(1);
  }

  endpoint.searchParams.set('auction', auctionId);
  if (token) endpoint.searchParams.set('token', token);

  const ws = new WebSocket(endpoint.toString());
  let finished = false;
  const on = (type, handler) => {
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener(type, handler);
    } else {
      ws.on(type, handler);
    }
  };
  const fail = (message, code = 2) => {
    if (finished) return;
    finished = true;
    console.error(`[ws-schema-precheck] ${message}`);
    try {
      ws.close(1000, 'schema-precheck-fail');
    } catch (_) {
      // ignore
    }
    process.exit(code);
  };
  const pass = (schemaVersion) => {
    if (finished) return;
    finished = true;
    console.log(JSON.stringify({ ok: true, schemaVersion, expectedSchemaVersion: expectedSchema }));
    ws.close(1000, 'schema-precheck-pass');
    process.exit(0);
  };

  const timer = setTimeout(() => {
    fail(`timeout after ${timeoutMs}ms waiting for schema-bearing message`);
  }, timeoutMs);

  const cleanupTimer = () => {
    if (timer) clearTimeout(timer);
  };

  on('open', () => {
    try {
      ws.send(JSON.stringify({
        schemaVersion: expectedSchema,
        type: 'ROOM_JOIN',
        auctionId,
        serverTimeMs: Date.now(),
        data: { auctionId },
      }));
    } catch (e) {
      fail(`failed to send ROOM_JOIN: ${e.message}`);
    }
  });

  on('message', (event) => {
    const raw = event?.data === undefined ? event : event.data;
    let env;
    try {
      env = JSON.parse(String(raw));
    } catch (_) {
      return;
    }
    if (env.type === 'SCHEMA_ERROR' || env?.data?.code === 'ERR_SCHEMA') {
      fail(`schema mismatch from server: type=${env.type || 'SCHEMA_ERROR'} code=${env?.data?.code || 'ERR_SCHEMA'}`);
    }
    if (env.schemaVersion === undefined) return;
    if (!isPositiveInt(env.schemaVersion)) {
      fail(`non-integer schemaVersion in message: ${JSON.stringify(env.schemaVersion)}`);
    }
    if (Number(env.schemaVersion) !== expectedSchema) {
      fail(`schemaVersion mismatch: got ${Number(env.schemaVersion)} expected ${expectedSchema}`);
    }
    cleanupTimer();
    pass(Number(env.schemaVersion));
  });

  on('close', (eventOrCode, maybeReason) => {
    const code = typeof eventOrCode === 'number' ? eventOrCode : eventOrCode?.code;
    const reason = typeof eventOrCode === 'number' ? (maybeReason || '') : (eventOrCode?.reason || '');
    if (finished) return;
    fail(`connection closed before schema validation: code=${code} reason=${reason || ''}`);
  });

  on('error', (event) => {
    fail(`websocket error: ${event.message || event.error?.message || 'unknown'}`);
  });
}

main().catch((err) => {
  console.error(`[ws-schema-precheck] ${err?.message || err}`);
  process.exit(1);
});

process.on('exit', () => {
  // no-op, keeps script explicit and intentional for lints
});
