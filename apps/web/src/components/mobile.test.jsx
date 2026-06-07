// src/components/mobile.test.jsx
//
// Tests for MobileRoom terminal-state overlays (TC-T6-104/105 added in #54)
// and the PullToResync gesture component (TC-T6-#51-H2 added in #63).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MobileRoom } from './mobile.jsx';
import { PullToResync } from './PullToResync.jsx';
import { BidErrorCode, bidRejectCopy } from '../lib/types.js';

const hlsMock = vi.hoisted(() => ({ instances: [] }));
vi.mock('hls.js', () => {
  class MockHls {
    static Events = { ERROR: 'ERROR' };
    static isSupported() { return true; }

    constructor() {
      this.handlers = new Map();
      this.destroyed = false;
      hlsMock.instances.push(this);
    }

    on(event, handler) {
      this.handlers.set(event, handler);
    }

    loadSource() {}
    attachMedia() {}
    destroy() {
      this.destroyed = true;
    }
  }

  return { default: MockHls };
});

describe('MobileRoom · TerminalOverlay (TC-T6-104/105)', () => {
  it('does NOT render the overlay during LIVE status', () => {
    const { container } = render(<MobileRoom status="LIVE" leaders={[]}/>);
    // Should not include the NO_BID / CANCELLED copy
    expect(container.textContent).not.toMatch(/本场无人出价|本场已取消|流拍|卖家终止/);
  });

  it('renders the NO_BID overlay (TC-T6-104)', () => {
    const { container } = render(<MobileRoom status="NO_BID" leaders={[]}/>);
    expect(container.textContent).toMatch(/本场无人出价|流拍/);
  });

  it('renders the CANCELLED overlay (TC-T6-105)', () => {
    const { container } = render(<MobileRoom status="CANCELLED" leaders={[]}/>);
    expect(container.textContent).toMatch(/本场已取消|卖家终止/);
  });

  it('NO_BID and CANCELLED produce visually distinct overlays', () => {
    const { container: noBidContainer } = render(<MobileRoom status="NO_BID" leaders={[]}/>);
    const { container: cancelContainer } = render(<MobileRoom status="CANCELLED" leaders={[]}/>);
    // The two states must NOT render the same copy
    const noBidText = noBidContainer.textContent;
    const cancelText = cancelContainer.textContent;
    expect(noBidText).not.toBe(cancelText);
  });

  it('does NOT render the overlay during SOLD (hammer transition handles SOLD)', () => {
    const { container } = render(<MobileRoom status="SOLD" leaders={[]}/>);
    expect(container.textContent).not.toMatch(/本场无人出价|本场已取消/);
  });
});

describe('MobileRoom · reject toast copy', () => {
  it('renders canonical reject copy for known rejection codes', () => {
    render(<MobileRoom rejectCode={BidErrorCode.ERR_NOT_ALLOWED} leaders={[]}/>);
    expect(screen.getByText('✗')).toBeInTheDocument();
    expect(screen.getByText(bidRejectCopy[BidErrorCode.ERR_NOT_ALLOWED])).toBeInTheDocument();
  });

  it('falls back to raw code when copy is unavailable', () => {
    // The raw code shows once as the message fallback; the machine code
    // otherwise lives in the toast's title attribute (design review P0-1).
    render(<MobileRoom rejectCode={'ERR_UNKNOWN_REJECTION'} leaders={[]}/>);
    expect(screen.getByText('ERR_UNKNOWN_REJECTION')).toBeInTheDocument();
  });
});

describe('MobileRoom bid locking', () => {
  // The join gate (拍卖须知) sits in front of the chips — pre-seed acceptance
  // so these tests exercise the chips themselves.
  beforeEach(() => {
    window.localStorage.setItem('lumen:joined:lumen-auction', '1');
  });

  it('does not submit bids after the local countdown reaches zero', () => {
    const onBid = vi.fn();
    const { container } = render(
      <MobileRoom status="LIVE" remainingMs={0} leaders={[]} onBid={onBid} capCents="15000000"/>,
    );

    const bidButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent.includes('竞拍已结束'));

    expect(bidButton).toBeDefined();
    expect(bidButton).toBeDisabled();

    fireEvent.click(bidButton);

    expect(onBid).not.toHaveBeenCalled();
  });

  it('submits the staged stepper amount while LIVE and time remains', () => {
    const onBid = vi.fn();
    const { container } = render(
      <MobileRoom status="LIVE" remainingMs={1000} leaders={[]} onBid={onBid}
        currentCents="12880000" stepCents="500000" capCents="15000000"/>,
    );

    const bidButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent.includes('立即出价'));

    expect(bidButton).toBeDefined();
    expect(bidButton).not.toBeDisabled();

    fireEvent.click(bidButton);

    expect(onBid).toHaveBeenCalledTimes(1);
    // default staged amount = current + one step (always on the grid)
    expect(onBid).toHaveBeenCalledWith('13380000');
  });
});

describe('MobileRoom · join gate (拍卖参与流程)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  // Detect the unlocked bid console via the 立即出价 CTA.
  const hasBidChips = (container) =>
    [...container.querySelectorAll('button')].some((b) => b.textContent.includes('立即出价'));

  it('locks the bid chips behind 我要参与竞拍 until the 须知 is accepted', () => {
    const { container } = render(<MobileRoom status="LIVE" leaders={[]}/>);
    expect(screen.getByText('我要参与竞拍')).toBeInTheDocument();
    expect(hasBidChips(container)).toBe(false);
  });

  it('我要参与 → 须知 sheet → 勾选同意 → chips unlock + persisted', () => {
    const { container } = render(
      <MobileRoom status="LIVE" leaders={[]} followScopeId="auc-join"/>,
    );

    fireEvent.click(screen.getByText('我要参与竞拍'));
    expect(screen.getByRole('dialog', { name: '拍卖须知' })).toBeInTheDocument();
    expect(container.textContent).toMatch(/透明单品竞拍/);
    expect(container.textContent).toMatch(/虚拟币演示/);

    // Agree button stays locked until the checkbox is ticked.
    const agreeBtn = screen.getByText('同意并参与');
    expect(agreeBtn).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(agreeBtn).not.toBeDisabled();
    fireEvent.click(agreeBtn);

    // Sheet closes, chips unlock, acceptance persists per room.
    expect(screen.queryByRole('dialog', { name: '拍卖须知' })).not.toBeInTheDocument();
    expect(hasBidChips(container)).toBe(true);
    expect(window.localStorage.getItem('lumen:joined:auc-join')).toBe('1');
  });

  it('暂不参与 closes the sheet without unlocking', () => {
    const { container } = render(<MobileRoom status="LIVE" leaders={[]}/>);
    fireEvent.click(screen.getByText('我要参与竞拍'));
    fireEvent.click(screen.getByText('暂不参与'));
    expect(screen.queryByRole('dialog', { name: '拍卖须知' })).not.toBeInTheDocument();
    expect(screen.getByText('我要参与竞拍')).toBeInTheDocument();
    expect(hasBidChips(container)).toBe(false);
  });

  it('scopes acceptance by room — joining auc-a leaves auc-b gated', () => {
    window.localStorage.setItem('lumen:joined:auc-a', '1');
    const { container, rerender } = render(
      <MobileRoom status="LIVE" leaders={[]} followScopeId="auc-a"/>,
    );
    expect(hasBidChips(container)).toBe(true);

    rerender(<MobileRoom status="LIVE" leaders={[]} followScopeId="auc-b"/>);
    expect(screen.getByText('我要参与竞拍')).toBeInTheDocument();
    expect(hasBidChips(container)).toBe(false);
  });

  it('re-opens the 须知 read-only from the rules summary after joining', () => {
    window.localStorage.setItem('lumen:joined:lumen-auction', '1');
    render(<MobileRoom status="LIVE" leaders={[]}/>);
    fireEvent.click(screen.getByText(/查看完整《拍卖须知》/));
    expect(screen.getByRole('dialog', { name: '拍卖须知' })).toBeInTheDocument();
    // Already joined → no re-consent dance, just an acknowledge button.
    expect(screen.queryByText('同意并参与')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('我知道了'));
    expect(screen.queryByRole('dialog', { name: '拍卖须知' })).not.toBeInTheDocument();
  });
});

describe('MobileRoom simplified buyer flow', () => {
  it('keeps the buyer essentials visible without tab navigation', () => {
    const { container } = render(
      <MobileRoom
        status="LIVE"
        leaders={[
          { userId: 'u1', displayName: 'Alice', cents: '13000000' },
          { userId: 'u2', displayName: 'Bob', cents: '12800000' },
          { userId: 'u3', displayName: 'You', cents: '12600000', isYou: true },
        ]}
        ticker={[{ id: 1, kind: 'bid', name: 'Alice', cents: '13000000' }]}
      />,
    );

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
    expect(container.textContent).toMatch(/当前领先/);
    // Champion + runner-up render; ranks 3+ stay dropped (化繁为简) — the
    // rank-3 bidder ("You") only surfaces through the my-position pill.
    expect(container.textContent).toMatch(/Alice/);
    expect(container.textContent).toMatch(/Bob/);
    expect(container.textContent).not.toMatch(/\bYou\b/);
    expect(container.textContent).toMatch(/最近出价/);
    expect(container.textContent).toMatch(/规则/);
    expect(container.textContent).toMatch(/最低加价/);
  });

  it('expands the full standings behind the 全部排行 toggle (collapsed by default)', () => {
    const { container } = render(
      <MobileRoom
        status="LIVE"
        leaders={[
          { userId: 'u1', displayName: 'Alice', cents: '13000000' },
          { userId: 'u2', displayName: 'Bob', cents: '12800000' },
          { userId: 'u3', displayName: 'Carol', cents: '12600000', isYou: true },
          { userId: 'u4', displayName: 'Dave', cents: '12400000' },
        ]}
      />,
    );

    // Collapsed: ranks 3+ hidden, toggle shows the total count.
    expect(container.textContent).not.toMatch(/Carol|Dave/);
    const toggle = screen.getByText(/全部排行（4）/);

    fireEvent.click(toggle);
    expect(container.textContent).toMatch(/Carol/);
    expect(container.textContent).toMatch(/Dave/);

    fireEvent.click(screen.getByText(/收起完整排行/));
    expect(container.textContent).not.toMatch(/Carol|Dave/);
  });

  it('scopes the follow state by room instead of sharing it globally', () => {
    window.localStorage.clear();
    const { rerender } = render(
      <MobileRoom status="LIVE" leaders={[]} followScopeId="auc-a"/>,
    );

    fireEvent.click(screen.getByText('+ 关注'));
    expect(screen.getByText('已关注')).toBeInTheDocument();
    expect(window.localStorage.getItem('lumen:follow:auc-a')).toBe('1');

    rerender(<MobileRoom status="LIVE" leaders={[]} followScopeId="auc-b"/>);

    expect(screen.getByText('+ 关注')).toBeInTheDocument();
    expect(window.localStorage.getItem('lumen:follow:auc-b')).toBeNull();
  });
});

describe('MobileRoom · LiveVideo fallback (#126)', () => {
  it('falls back to the simulated sheen when a configured video errors at runtime', () => {
    const { container } = render(
      <MobileRoom status="LIVE" leaders={[]} videoUrl="https://cdn.example.invalid/live.m3u8"/>,
    );

    const video = container.querySelector('video');
    expect(video).not.toBeNull();

    fireEvent.error(video);

    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('.lumen-livefeed')).not.toBeNull();
  });

  it('resets the runtime fallback when videoUrl changes', () => {
    const { container, rerender } = render(
      <MobileRoom status="LIVE" leaders={[]} videoUrl="https://cdn.example.invalid/broken.m3u8"/>,
    );

    fireEvent.error(container.querySelector('video'));
    expect(container.querySelector('.lumen-livefeed')).not.toBeNull();

    rerender(
      <MobileRoom status="LIVE" leaders={[]} videoUrl="https://cdn.example.invalid/recovered.m3u8"/>,
    );

    expect(container.querySelector('video')).not.toBeNull();
    expect(container.querySelector('.lumen-livefeed')).toBeNull();
  });

  it('falls back when hls.js reports a fatal runtime error', async () => {
    hlsMock.instances.length = 0;
    const { container } = render(
      <MobileRoom status="LIVE" leaders={[]} videoUrl="https://cdn.example.invalid/live.m3u8"/>,
    );

    await waitFor(() => expect(hlsMock.instances.length).toBe(1));
    act(() => {
      hlsMock.instances[0].handlers.get('ERROR')?.('ERROR', { fatal: true });
    });

    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('.lumen-livefeed')).not.toBeNull();
  });

  it('does not recreate hls.js on parent rerender when the url is unchanged', async () => {
    hlsMock.instances.length = 0;
    const { rerender } = render(
      <MobileRoom status="LIVE" leaders={[]} remainingMs={30000} videoUrl="https://cdn.example.invalid/live.m3u8"/>,
    );

    await waitFor(() => expect(hlsMock.instances.length).toBe(1));
    rerender(
      <MobileRoom status="LIVE" leaders={[]} remainingMs={29984} videoUrl="https://cdn.example.invalid/live.m3u8"/>,
    );

    expect(hlsMock.instances.length).toBe(1);
    expect(hlsMock.instances[0].destroyed).toBe(false);
  });
});

describe('PullToResync · gesture handling (TC-T6-#51-H2)', () => {
  it('renders children unchanged', () => {
    const { getByTestId } = render(
      <PullToResync onResync={() => {}}>
        <div data-testid="child">child content</div>
      </PullToResync>,
    );
    expect(getByTestId('child').textContent).toBe('child content');
  });

  it('does NOT fire onResync on a pull that never crosses threshold', () => {
    const onResync = vi.fn();
    const { container } = render(
      <PullToResync onResync={onResync} threshold={100}>
        <div>child</div>
      </PullToResync>,
    );
    const root = container.firstChild;

    // Simulate a short pull that doesn't reach threshold
    fireEvent.touchStart(root, { touches: [{ clientY: 0 }] });
    fireEvent.touchMove(root, { touches: [{ clientY: 30 }] });   // 30px < 100 threshold
    fireEvent.touchEnd(root, {});

    expect(onResync).not.toHaveBeenCalled();
  });

  it('FIRES onResync when a pull crosses threshold and ends normally', () => {
    const onResync = vi.fn();
    const { container } = render(
      <PullToResync onResync={onResync} threshold={64}>
        <div>child</div>
      </PullToResync>,
    );
    const root = container.firstChild;

    fireEvent.touchStart(root, { touches: [{ clientY: 0 }] });
    fireEvent.touchMove(root, { touches: [{ clientY: 100 }] });  // 100px > 64 threshold
    fireEvent.touchEnd(root, {});

    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('DOES NOT fire onResync when touch is cancelled mid-pull (#51-H2 fix)', () => {
    const onResync = vi.fn();
    const { container } = render(
      <PullToResync onResync={onResync} threshold={64}>
        <div>child</div>
      </PullToResync>,
    );
    const root = container.firstChild;

    fireEvent.touchStart(root, { touches: [{ clientY: 0 }] });
    fireEvent.touchMove(root, { touches: [{ clientY: 100 }] });  // armed
    fireEvent.touchCancel(root, {});                              // iOS abort

    expect(onResync).not.toHaveBeenCalled();
  });

  it('subsequent pull after a cancel does NOT carry armed flag (#51-H2 regression)', () => {
    const onResync = vi.fn();
    const { container } = render(
      <PullToResync onResync={onResync} threshold={64}>
        <div>child</div>
      </PullToResync>,
    );
    const root = container.firstChild;

    // First pull: arm + cancel
    fireEvent.touchStart(root, { touches: [{ clientY: 0 }] });
    fireEvent.touchMove(root, { touches: [{ clientY: 100 }] });
    fireEvent.touchCancel(root, {});
    expect(onResync).not.toHaveBeenCalled();

    // Second pull: short, under threshold. Must NOT fire from residual armed flag.
    fireEvent.touchStart(root, { touches: [{ clientY: 0 }] });
    fireEvent.touchMove(root, { touches: [{ clientY: 30 }] });
    fireEvent.touchEnd(root, {});

    expect(onResync).not.toHaveBeenCalled();
  });
});
