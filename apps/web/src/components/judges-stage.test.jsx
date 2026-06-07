// src/components/judges-stage.test.jsx
//
// P0 sweep from the judges-stage design review:
//  P0-3 AntiSnipeFlash — the anti-snipe rule firing as a visible event
//  P0-5 OvertakenSlam  — action-typed CTA ("再加 X 反超")
//  P0-7 EngineeringRibbon — invariants on screen, expandable
//  P0-4 BidConsole long-press — 400ms hold opens the tier wheel, click suppressed
//  P0-6 MobileEvidence — honest trust copy (哈希链可验证 · 非外部公证)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AntiSnipeFlash, OvertakenSlam } from './atmosphere.jsx';
import { EngineeringRibbon, BidConsole } from './primitives.jsx';
import { MobileEvidence } from './mobile.jsx';

describe('AntiSnipeFlash (P0-3)', () => {
  it('renders rule + count + seq from the flash payload', () => {
    render(<AntiSnipeFlash flash={{ count: 3, seq: 14945, addedSec: 30 }}/>);
    expect(screen.getByText(/反狙击触发 · 延时 \+30s · 第 3 次/)).toBeTruthy();
    expect(screen.getByText(/序列 #14945/)).toBeTruthy();
  });

  it('renders nothing without a flash', () => {
    const { container } = render(<AntiSnipeFlash flash={null}/>);
    expect(container.firstChild).toBeNull();
  });

  it('omits the seq chip when seq is unknown (catchup replay)', () => {
    render(<AntiSnipeFlash flash={{ count: 1, seq: null, addedSec: 30 }}/>);
    expect(screen.queryByText(/序列 #/)).toBeNull();
  });
});

describe('OvertakenSlam CTA (P0-5)', () => {
  it('names the exact increment on the reverse button', () => {
    render(<OvertakenSlam visible byName="海风_2024" gapCents="500000" stepCents="500000" onReverse={() => {}}/>);
    expect(screen.getByRole('button', { name: /再加 ¥5,000 反超/ })).toBeTruthy();
  });

  it('falls back to the bare arrow without stepCents', () => {
    render(<OvertakenSlam visible byName="海风_2024" gapCents="500000" onReverse={() => {}}/>);
    expect(screen.getByRole('button', { name: '反超 →' })).toBeTruthy();
  });

  it('fires onReverse when tapped', () => {
    const onReverse = vi.fn();
    render(<OvertakenSlam visible byName="海风_2024" gapCents="500000" stepCents="500000" onReverse={onReverse}/>);
    fireEvent.click(screen.getByRole('button', { name: /反超/ }));
    expect(onReverse).toHaveBeenCalledTimes(1);
  });
});

describe('EngineeringRibbon (P0-7)', () => {
  it('shows conn + seq + drift + rate collapsed', () => {
    render(<EngineeringRibbon connStatus="ok" lastSeq={14998} driftMs={12.4} bidsPerSec={2.4} extendCount={3} viewerCount={1024}/>);
    const btn = screen.getByRole('button', { name: '工程指标' });
    expect(btn.textContent).toContain('WS OK');
    expect(btn.textContent).toContain('#14998');
    expect(btn.textContent).toContain('Δ+12ms');
    expect(btn.textContent).toContain('2.4/s');
    expect(btn.textContent).toContain('延时×3');
  });

  it('expands into labeled rows on tap', () => {
    render(<EngineeringRibbon connStatus="ok" lastSeq={7} driftMs={-3} bidsPerSec={0} extendCount={0} viewerCount={12}/>);
    fireEvent.click(screen.getByRole('button', { name: '工程指标' }));
    const panel = screen.getByRole('region', { name: '工程指标明细' });
    expect(panel.textContent).toContain('事件序列');
    expect(panel.textContent).toContain('时钟漂移');
    expect(panel.textContent).toContain('Δ-3ms');
    expect(panel.textContent).toContain('反狙击');
    expect(panel.textContent).toContain('12 人');
  });

  it('renders the reconnecting state distinctly', () => {
    render(<EngineeringRibbon connStatus="reconnecting" lastSeq={1} driftMs={0} bidsPerSec={0} extendCount={0} viewerCount={0}/>);
    expect(screen.getByRole('button', { name: '工程指标' }).textContent).toContain('WS 重连');
  });
});

describe('BidConsole long-press (P0-4)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const consoleProps = {
    remainingMs: 20_000,
    currentCents: '12880000',
    stepCents: '500000',
  };

  it('hold 400ms fires onLongPress and the trailing click is swallowed', () => {
    const onBid = vi.fn();
    const onLongPress = vi.fn();
    render(<BidConsole {...consoleProps} onBid={onBid} onLongPress={onLongPress}/>);
    const btn = screen.getByRole('button', { name: '立即出价' });

    fireEvent.pointerDown(btn);
    act(() => { vi.advanceTimersByTime(420); });
    expect(onLongPress).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(btn);
    fireEvent.click(btn); // browsers fire click after pointerup — must NOT bid
    expect(onBid).not.toHaveBeenCalled();
  });

  it('a quick tap still submits the staged amount', () => {
    const onBid = vi.fn();
    const onLongPress = vi.fn();
    render(<BidConsole {...consoleProps} onBid={onBid} onLongPress={onLongPress}/>);
    const btn = screen.getByRole('button', { name: '立即出价' });

    fireEvent.pointerDown(btn);
    act(() => { vi.advanceTimersByTime(120); }); // released before 400ms
    fireEvent.pointerUp(btn);
    fireEvent.click(btn);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(onBid).toHaveBeenCalledWith('13380000'); // current + 1 step
  });

  it('pointer leaving the button cancels the pending long-press', () => {
    const onLongPress = vi.fn();
    render(<BidConsole {...consoleProps} onBid={() => {}} onLongPress={onLongPress}/>);
    const btn = screen.getByRole('button', { name: '立即出价' });

    fireEvent.pointerDown(btn);
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.pointerLeave(btn);
    act(() => { vi.advanceTimersByTime(400); });
    expect(onLongPress).not.toHaveBeenCalled();
  });
});

describe('MobileEvidence trust copy (P0-6)', () => {
  it('frames the chain honestly — verifiable, not notarized', () => {
    render(<MobileEvidence/>);
    expect(screen.getByText(/T4 Evidence v0 · 哈希链可验证 · 非外部公证/)).toBeTruthy();
    expect(screen.getByText('HMAC 链式哈希')).toBeTruthy();
    expect(screen.getByText(/非区块链\/第三方公证/)).toBeTruthy();
  });
});
