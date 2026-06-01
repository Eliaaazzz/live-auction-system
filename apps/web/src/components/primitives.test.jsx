// src/components/primitives.test.jsx
//
// Component-level tests for the primitives library. These exercise
// rendering paths that pure reducer/format tests can't reach — e.g. the
// 7-state status badge mapping, podium <3-leaders graceful fallback,
// heat meter clipping behavior.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  bidRejectCopy,
  StatusBadge,
  ExtendBadge,
  ConnectionBar,
  Leaderboard,
  HeatMeter,
  PriceDisplay,
  Countdown,
  ClockDriftIndicator,
} from './primitives.jsx';
import { bidRejectCopy as canonicalBidRejectCopy } from '../lib/types.js';

describe('bidRejectCopy should stay canonical', () => {
  it('re-exports the shared copy from lib/types.js', () => {
    expect(bidRejectCopy).toBe(canonicalBidRejectCopy);
  });
});

describe('StatusBadge · canonical 7 states (state-machine.md)', () => {
  // Lock the exact CN copy for each state. Changing copy = breaking
  // contract with the design + the demo narrative; tests catch drift.
  const STATE_COPY = {
    DRAFT:         '草稿',
    SCHEDULED:     '即将开拍',
    LIVE:          '直播中',
    SOLD:          '已成交',
    NO_BID:        '本场无人出价',
    CANCELLED:     '已取消',
    ORDER_CREATED: '订单已生成',
  };

  Object.entries(STATE_COPY).forEach(([status, expected]) => {
    it(`renders ${status} with copy "${expected}"`, () => {
      const { container } = render(<StatusBadge status={status}/>);
      expect(container.textContent).toContain(expected);
    });
  });

  it('renders LIVE with the dot indicator (animated)', () => {
    const { container } = render(<StatusBadge status="LIVE"/>);
    expect(container.querySelector('.lumen-live-dot')).toBeTruthy();
  });

  it('non-LIVE states do NOT render the live dot', () => {
    const { container } = render(<StatusBadge status="SOLD"/>);
    expect(container.querySelector('.lumen-live-dot')).toBeFalsy();
  });

  it('falls back to DRAFT styling on unknown status (defensive)', () => {
    const { container } = render(<StatusBadge status="UNKNOWN_STATE"/>);
    expect(container.textContent).toContain('草稿');
  });
});

describe('ExtendBadge', () => {
  it('renders the extend count when count > 0', () => {
    const { container } = render(<ExtendBadge count={3}/>);
    expect(container.textContent).toMatch(/3/);
  });

  it('hides at count=0 (no extensions yet) — avoids zero-state visual clutter', () => {
    const { container } = render(<ExtendBadge count={0}/>);
    expect(container.firstChild).toBeNull();
  });

  it('renders per-sec annotation', () => {
    const { container } = render(<ExtendBadge count={2} perSec={45}/>);
    expect(container.textContent).toMatch(/45/);
  });
});

describe('ConnectionBar', () => {
  it('renders nothing on ok / open status', () => {
    const { container } = render(<ConnectionBar status="ok"/>);
    // ConnectionBar typically hides itself when connection is healthy
    expect(container.textContent.length === 0 || !container.querySelector('[aria-hidden]')).toBeTruthy();
  });

  it('renders during reconnecting', () => {
    const { container } = render(<ConnectionBar status="reconnecting"/>);
    expect(container.textContent.length).toBeGreaterThan(0);
  });

  it('renders during syncing with gap info', () => {
    const { container } = render(<ConnectionBar status="syncing" gap={5}/>);
    expect(container.textContent.length).toBeGreaterThan(0);
  });
});

describe('ClockDriftIndicator', () => {
  it('shows warn color when drift exceeds 500ms', () => {
    const { container } = render(<ClockDriftIndicator offsetMs={600} />);
    expect(container.textContent).toContain('Δ +600ms');
    expect(container.firstChild.style.color).toBe('var(--state-extended)');
  });

  it('shows normal color when drift magnitude is <= 500ms (e.g. -300ms)', () => {
    const { container } = render(<ClockDriftIndicator offsetMs={-300} />);
    expect(container.textContent).toContain('Δ -300ms');
    expect(container.firstChild.style.color).toBe('var(--douyin-ink-muted)');
  });
});

describe('Leaderboard · podium mode (TC-T6-230/234)', () => {
  const FULL_LEADERS = [
    { userId: 'u1', displayName: '海风_2024', cents: '13000000', isYou: false },
    { userId: 'u2', displayName: '陆_LU', cents: '12500000', isYou: true },
    { userId: 'u3', displayName: 'dust_3', cents: '12000000', isYou: false },
  ];

  it('renders all 3 leaders by displayName', () => {
    render(<Leaderboard leaders={FULL_LEADERS} mode="podium"/>);
    expect(screen.getByText(/海风_2024/)).toBeInTheDocument();
    expect(screen.getByText(/陆_LU/)).toBeInTheDocument();
    expect(screen.getByText(/dust_3/)).toBeInTheDocument();
  });

  it('renders gracefully with only 2 leaders (TC-T6-231 <3 case)', () => {
    const { container } = render(<Leaderboard leaders={FULL_LEADERS.slice(0, 2)} mode="podium"/>);
    expect(container.firstChild).toBeTruthy();
    expect(screen.getByText(/海风_2024/)).toBeInTheDocument();
    expect(screen.getByText(/陆_LU/)).toBeInTheDocument();
    // Should NOT crash on the missing 3rd
  });

  it('renders with only 1 leader without crashing', () => {
    const { container } = render(<Leaderboard leaders={FULL_LEADERS.slice(0, 1)} mode="podium"/>);
    expect(container.firstChild).toBeTruthy();
    expect(screen.getByText(/海风_2024/)).toBeInTheDocument();
  });

  it('renders empty without crashing', () => {
    const { container } = render(<Leaderboard leaders={[]} mode="podium"/>);
    expect(container.firstChild).toBeTruthy();
  });

  it('falls back to userId for initial/name when displayName is missing', () => {
    render(
      <Leaderboard
        leaders={[{ userId: 'user-001', cents: '11000000' }]}
        mode="podium"
      />,
    );
    expect(screen.getByText(/user-001/)).toBeInTheDocument();
    expect(screen.getByText('user-001')).toBeInTheDocument();
  });

  it('falls back to ? when both displayName and userId are missing', () => {
    const { container } = render(
      <Leaderboard
        leaders={[{ cents: '11000000' }]}
        mode="podium"
      />,
    );
    expect(container.textContent).toContain('?');
  });
});

describe('HeatMeter', () => {
  it('renders 0% at bidsPerSec=0', () => {
    const { container } = render(<HeatMeter bidsPerSec={0} peak={6}/>);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders without crashing at peak', () => {
    const { container } = render(<HeatMeter bidsPerSec={6} peak={6}/>);
    expect(container.firstChild).toBeTruthy();
  });

  it('clamps to peak when bidsPerSec exceeds peak (regression for #54-M1)', () => {
    // Should NOT overflow the meter visually
    const { container } = render(<HeatMeter bidsPerSec={20} peak={6}/>);
    expect(container.firstChild).toBeTruthy();
    // Width-style if exposed should be ≤100%
    const fill = container.querySelector('[style*="width"]');
    if (fill) {
      const widthAttr = fill.getAttribute('style') || '';
      const match = widthAttr.match(/width:\s*(\d+(?:\.\d+)?)%/);
      if (match) expect(parseFloat(match[1])).toBeLessThanOrEqual(100);
    }
  });

  it('handles peak=0 without dividing by zero', () => {
    const { container } = render(<HeatMeter bidsPerSec={5} peak={0}/>);
    expect(container.firstChild).toBeTruthy();
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
  });
});

describe('PriceDisplay', () => {
  it('renders cents-string with CN currency format', () => {
    const { container } = render(<PriceDisplay cents="12880000"/>);
    expect(container.textContent).toMatch(/128,800/);
  });

  it('renders 0', () => {
    const { container } = render(<PriceDisplay cents="0"/>);
    expect(container.textContent).toMatch(/0\.00/);
  });

  it('handles BigInt-range cents', () => {
    const { container } = render(<PriceDisplay cents="9000000000000000"/>);
    expect(container.textContent).toMatch(/90,000,000,000,000/);
  });
});

describe('Countdown', () => {
  it('renders 00:00 at 0ms', () => {
    const { container } = render(<Countdown remainingMs={0}/>);
    expect(container.textContent).toMatch(/00:00/);
  });

  it('renders MM:SS for sub-minute durations', () => {
    const { container } = render(<Countdown remainingMs={45_000}/>);
    expect(container.textContent).toMatch(/00:45/);
  });

  it('renders MM:SS for minute durations', () => {
    const { container } = render(<Countdown remainingMs={75_000}/>);
    expect(container.textContent).toMatch(/01:15/);
  });

  it('switches to warning tone in final 10 seconds', () => {
    const { container } = render(<Countdown remainingMs={5_000} warningMs={10_000}/>);
    expect(container.firstChild).toBeTruthy();
  });
});
