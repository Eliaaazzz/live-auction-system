import { CURRENT_SCHEMA_VERSION } from '../src/lib/types.js';

const DEFAULT_AUCTION_ID = 'auc_demo';

function trimOrEmpty(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function inCI() {
  return process.env.CI === '1' || process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';
}

function pickSchemaVersion() {
  const raw = process.env.WEB_SMOKE_SCHEMA_VERSION || process.env.SCHEMA_VERSION;
  if (!raw) return CURRENT_SCHEMA_VERSION;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid smoke schema override: WEB_SMOKE_SCHEMA_VERSION/SCHEMA_VERSION must be positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export const SCHEMA_VERSION = pickSchemaVersion();

function requireToken(respBody, fallbackMessage) {
  if (!respBody || typeof respBody.token !== 'string' || respBody.token.length === 0) {
    throw new Error(fallbackMessage || 'login response missing token');
  }
}

export async function login(host, nick) {
  let body;
  let r;

  r = await fetch(`${host}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: nick }),
  }).catch((err) => {
    throw new Error(`api/login failed for ${host}: ${err.message}`);
  });

  if (r.ok) {
    body = await r.json();
    requireToken(body, `api/login response missing token; status=${r.status}`);
    return body;
  }

  r = await fetch(`${host}/api/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: nick }),
  }).catch((err) => {
    throw new Error(`api/dev-login failed for ${host}: ${err.message}`);
  });

  if (!r.ok) {
    throw new Error(`api/login ${r.status}; dev-login fallback ${r.status}`);
  }

  body = await r.json();
  requireToken(body, `api/dev-login response missing token; fallback status=${r.status}`);
  return body;
}

export function resolveAuctionId({ scriptName } = {}) {
  const explicit = trimOrEmpty(process.env.WEB_SMOKE_AID)
    || trimOrEmpty(process.env.VERIFY_AID)
    || trimOrEmpty(process.env.AUCTION_ID);
  if (explicit) {
    return explicit;
  }

  if (inCI()) {
    const reason = process.env.CI === 'true' ? 'CI=true' : process.env.CI === '1' ? 'CI=1' : 'GITHUB_ACTIONS=true';
    throw new Error(`[smoke] missing auction id env (${reason}); set WEB_SMOKE_AID, VERIFY_AID, or AUCTION_ID`);
  }

  const name = scriptName ? `[${scriptName}]` : '[smoke script]';
  console.warn(
    `${name} no WEB_SMOKE_AID, VERIFY_AID, or AUCTION_ID found, falling back to ${DEFAULT_AUCTION_ID} ` +
      '(legacy dev default). Set WEB_SMOKE_AID or VERIFY_AID=<auction-id> for explicit intent.',
  );
  return DEFAULT_AUCTION_ID;
}
