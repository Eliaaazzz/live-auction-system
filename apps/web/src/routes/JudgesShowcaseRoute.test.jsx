// src/routes/JudgesShowcaseRoute.test.jsx
//
// The /showcase stage is only trustworthy if its script is deterministic:
// these tests walk the exact 6-button director sequence and assert the
// per-viewer perspective mapping plus the synthesized evidence chain.

import { describe, it, expect } from 'vitest';
import {
  showcaseReducer,
  initialShowcase,
  viewerProps,
  buildScriptEvidence,
  SHOWCASE_STEPS,
} from './JudgesShowcaseRoute.jsx';

const run = (...actions) =>
  actions.reduce((s, a) => showcaseReducer(s, typeof a === 'string' ? { type: a } : a), initialShowcase());

describe('showcaseReducer · the 6-step director script', () => {
  it('exposes exactly the six review-mandated beats', () => {
    expect(SHOWCASE_STEPS.map((s) => s.key))
      .toEqual(['FINAL10', 'BID_A', 'BID_B', 'EXTEND', 'HAMMER', 'EVIDENCE']);
  });

  it('FINAL10 clamps the countdown into the endgame', () => {
    const s = run('FINAL10');
    expect(s.remainingMs).toBeLessThanOrEqual(10_000);
    expect(s.status).toBe('LIVE');
  });

  it('BID_A: A leads (+1 step), B sees 被超越', () => {
    const s = run('FINAL10', 'BID_A');
    expect(s.currentCents).toBe('13380000'); // 12880000 + 500000
    expect(s.leaderId).toBe('uA');
    expect(s.flags.A.leadingToast).toBe(true);
    expect(s.flags.B.overtakeBanner).toBe(true);
    expect(s.lastSeq).toBe(initialShowcase().lastSeq + 1);
  });

  it('BID_B: B reverses, perspectives flip', () => {
    const s = run('FINAL10', 'BID_A', 'BID_B');
    expect(s.currentCents).toBe('13880000');
    expect(s.leaderId).toBe('uB');
    expect(s.flags.B.leadingToast).toBe(true);
    expect(s.flags.A.overtakeBanner).toBe(true);
  });

  it('EXTEND: +30s, extendFlash carries count + seq', () => {
    const before = run('FINAL10', 'BID_A', 'BID_B');
    const s = showcaseReducer(before, { type: 'EXTEND' });
    expect(s.extendCount).toBe(before.extendCount + 1);
    expect(s.remainingMs).toBe(before.remainingMs + 30_000);
    expect(s.extendFlash).toEqual({ count: s.extendCount, seq: s.lastSeq, addedSec: 30 });
  });

  it('HAMMER: SOLD to the current leader; further bids are rejected', () => {
    const s = run('FINAL10', 'BID_A', 'BID_B', 'EXTEND', 'HAMMER');
    expect(s.status).toBe('SOLD');
    expect(s.winnerId).toBe('uB');
    expect(s.remainingMs).toBe(0);
    const after = showcaseReducer(s, { type: 'BID_A' });
    expect(after).toBe(s); // terminal — scripted room also refuses bids
  });

  it('EVIDENCE flips the rail; RESET restores the opening state', () => {
    const s = run('FINAL10', 'BID_A', 'BID_B', 'EXTEND', 'HAMMER', 'EVIDENCE');
    expect(s.showEvidence).toBe(true);
    expect(showcaseReducer(s, { type: 'RESET' })).toEqual(initialShowcase());
  });

  it('BID_FROM (judge taps a real chip) joins the same script lane', () => {
    const s = run('FINAL10', { type: 'BID_FROM', who: 'A', amountCents: '13500000' });
    expect(s.currentCents).toBe('13500000');
    expect(s.leaderId).toBe('uA');
    // and a stale/low amount is refused like the backend would
    const rejected = showcaseReducer(s, { type: 'BID_FROM', who: 'B', amountCents: '13000000' });
    expect(rejected).toBe(s);
  });

  it('TICK only advances time while LIVE', () => {
    const live = showcaseReducer(initialShowcase(), { type: 'TICK', ms: 1_000 });
    expect(live.remainingMs).toBe(initialShowcase().remainingMs - 1_000);
    const sold = run('BID_A', 'HAMMER');
    expect(showcaseReducer(sold, { type: 'TICK', ms: 1_000 })).toBe(sold);
  });
});

describe('viewerProps · two perspectives of one room', () => {
  it('flips isYouLeading / banners / winner between A and B', () => {
    const s = run('FINAL10', 'BID_A');
    const a = viewerProps(s, 'A');
    const b = viewerProps(s, 'B');
    expect(a.isYouLeading).toBe(true);
    expect(b.isYouLeading).toBe(false);
    expect(a.showLeadingToast).toBe(true);
    expect(b.overtakeBanner).toBe(true);
    expect(a.leaders[0].isYou).toBe(true);
    expect(b.leaders[0].isYou).toBe(false);

    const sold = run('FINAL10', 'BID_A', 'HAMMER');
    expect(viewerProps(sold, 'A').isYouWinner).toBe(true);
    expect(viewerProps(sold, 'B').isYouWinner).toBe(false);
  });

  it('both phones share price / seq / extend state', () => {
    const s = run('FINAL10', 'BID_A', 'BID_B', 'EXTEND');
    const a = viewerProps(s, 'A');
    const b = viewerProps(s, 'B');
    expect(a.currentCents).toBe(b.currentCents);
    expect(a.lastSeq).toBe(b.lastSeq);
    expect(a.extendFlash).toEqual(b.extendFlash);
  });
});

describe('buildScriptEvidence · the card matches what judges watched', () => {
  it('links prevHash→eventHash with no gaps and ends at the hammer price', () => {
    const s = run('FINAL10', 'BID_A', 'BID_B', 'EXTEND', 'HAMMER', 'EVIDENCE');
    const ev = buildScriptEvidence(s);
    expect(ev.chainVerified).toBe(true);
    expect(ev.currentPriceCents).toBe(s.currentCents);

    expect(ev.timeline[0].prevHash).toBe('0000000000000000');
    for (let i = 1; i < ev.timeline.length; i++) {
      expect(ev.timeline[i].prevHash).toBe(ev.timeline[i - 1].eventHash);
    }
    const last = ev.timeline[ev.timeline.length - 1];
    expect(last.eventType).toBe('AUCTION_SOLD');
    expect(JSON.parse(last.payload).amountCents).toBe(s.currentCents);
  });
});
