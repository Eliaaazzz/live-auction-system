// src/lib/clock.js
// Server-corrected clock per blueprint §4 P4 / F05.
// All countdown UI MUST use serverNow() instead of Date.now().
//
// Calibration: on every WS heartbeat ack, the server sends `serverTs`.
// We compute `offset = serverTs - clientTs` and apply it everywhere.

let offsetMs = 0;

export function setClockOffset(serverTs, clientTs) {
  offsetMs = Number(serverTs) - Number(clientTs);
}

export function serverNow() {
  return Date.now() + offsetMs;
}

export function getDriftMs() {
  return offsetMs;
}

// ms remaining until `endTs` (which is server time, ms since epoch).
export function msRemaining(endTs) {
  return Math.max(0, Number(endTs) - serverNow());
}
