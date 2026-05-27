// src/lib/clock.test.js
//
// Tests the server-corrected clock per blueprint §4 P4.
// The module holds offsetMs as MODULE STATE — tests must reset it.

import { describe, it, expect, beforeEach } from 'vitest';
import { setClockOffset, serverNow, msRemaining, getDriftMs } from './clock.js';

describe('setClockOffset / serverNow', () => {
  beforeEach(() => setClockOffset(0, 0));

  it('serverNow returns client time when offset is 0', () => {
    const before = Date.now();
    const sn = serverNow();
    const after = Date.now();
    expect(sn).toBeGreaterThanOrEqual(before);
    expect(sn).toBeLessThanOrEqual(after);
  });

  it('positive offset (server ahead of client) advances serverNow', () => {
    setClockOffset(2000, 1000);     // server +1000ms ahead of client
    const sn = serverNow();
    expect(sn - Date.now()).toBeCloseTo(1000, -1);
  });

  it('negative offset (server behind client) rewinds serverNow', () => {
    setClockOffset(1000, 2000);     // server -1000ms behind
    const sn = serverNow();
    expect(sn - Date.now()).toBeCloseTo(-1000, -1);
  });

  it('getDriftMs reports the active offset', () => {
    setClockOffset(5000, 3000);
    expect(getDriftMs()).toBe(2000);
  });

  it('coerces string inputs (defensive — wire envelope sends numbers but JSON would coerce)', () => {
    setClockOffset('5000', '3000');
    expect(getDriftMs()).toBe(2000);
  });
});

describe('msRemaining', () => {
  beforeEach(() => setClockOffset(0, 0));

  it('returns positive ms while endTs is in the future', () => {
    const end = Date.now() + 5000;
    expect(msRemaining(end)).toBeGreaterThan(4000);
    expect(msRemaining(end)).toBeLessThanOrEqual(5000);
  });

  it('clamps to 0 once endTs is past', () => {
    const end = Date.now() - 1000;
    expect(msRemaining(end)).toBe(0);
  });

  it('uses server-corrected time, not raw Date.now (blueprint P4)', () => {
    // Server is 5 seconds ahead → endAtMs reachable from server perspective
    // is 5 seconds earlier from client perspective.
    setClockOffset(Date.now() + 5000, Date.now());
    const end = Date.now() + 3000;  // client thinks 3s away, server says past
    expect(msRemaining(end)).toBe(0);
  });
});
