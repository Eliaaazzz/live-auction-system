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
    render(<MobileRoom rejectCode={'ERR_UNKNOWN_REJECTION'} leaders={[]}/>);
    expect(screen.getAllByText('ERR_UNKNOWN_REJECTION')).toHaveLength(2);
  });
});

describe('MobileRoom bid locking', () => {
  it('does not submit chip bids after the local countdown reaches zero', () => {
    const onBid = vi.fn();
    const { container } = render(
      <MobileRoom status="LIVE" remainingMs={0} leaders={[]} onBid={onBid}/>,
    );

    const maxButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent.includes('MAX'));

    expect(maxButton).toBeDefined();
    expect(maxButton).toBeDisabled();

    fireEvent.click(maxButton);

    expect(onBid).not.toHaveBeenCalled();
  });

  it('still submits chip bids while LIVE and time remains', () => {
    const onBid = vi.fn();
    const { container } = render(
      <MobileRoom status="LIVE" remainingMs={1000} leaders={[]} onBid={onBid}/>,
    );

    const maxButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent.includes('MAX'));

    expect(maxButton).toBeDefined();
    expect(maxButton).not.toBeDisabled();

    fireEvent.click(maxButton);

    expect(onBid).toHaveBeenCalledTimes(1);
    expect(onBid).toHaveBeenCalledWith(expect.any(String));
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

const findBtn = (container, text) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent.includes(text));

describe('MobileRoom · participation gate (我要参与 + T&C)', () => {
  beforeEach(() => window.localStorage.clear());

  it('hides the bid chips behind 我要参与 when requireJoin and not yet joined', () => {
    const { container } = render(
      <MobileRoom status="LIVE" remainingMs={30000} leaders={[]} requireJoin joinKey="auc_gate_1"/>,
    );
    expect(container.textContent).toMatch(/我要参与/);
    expect(findBtn(container, 'MAX')).toBeUndefined(); // chips not rendered yet
  });

  it('opens terms, requires agreement, then unlocks the chips', () => {
    const { container } = render(
      <MobileRoom status="LIVE" remainingMs={30000} leaders={[]} requireJoin joinKey="auc_gate_2"/>,
    );
    fireEvent.click(findBtn(container, '我要参与'));

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const confirm = [...container.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === '确认参与');
    expect(confirm).toBeDisabled();

    fireEvent.click(container.querySelector('input[type="checkbox"]'));
    expect(confirm).not.toBeDisabled();

    fireEvent.click(confirm);
    expect(findBtn(container, 'MAX')).toBeDefined(); // chips unlocked
    expect(window.localStorage.getItem('lumen.joined.auc_gate_2')).toBe('1');
  });

  it('skips the gate when participation was already persisted', () => {
    window.localStorage.setItem('lumen.joined.auc_gate_3', '1');
    const { container } = render(
      <MobileRoom status="LIVE" remainingMs={30000} leaders={[]} requireJoin joinKey="auc_gate_3"/>,
    );
    expect(findBtn(container, 'MAX')).toBeDefined();
    expect(container.textContent).not.toMatch(/我要参与/);
  });

  it('shows chips directly when requireJoin is not set (preview/default path)', () => {
    const { container } = render(<MobileRoom status="LIVE" remainingMs={30000} leaders={[]}/>);
    expect(findBtn(container, 'MAX')).toBeDefined();
    expect(container.textContent).not.toMatch(/我要参与/);
  });

  it('re-applies the gate when joinKey changes without a remount (room→room nav)', () => {
    window.localStorage.setItem('lumen.joined.aucA', '1'); // A already joined
    const { container, rerender } = render(
      <MobileRoom status="LIVE" remainingMs={30000} leaders={[]} requireJoin joinKey="aucA"/>,
    );
    expect(findBtn(container, 'MAX')).toBeDefined(); // A → chips unlocked

    // Same component instance, switch to a not-yet-joined auction B.
    rerender(<MobileRoom status="LIVE" remainingMs={30000} leaders={[]} requireJoin joinKey="aucB"/>);
    expect(findBtn(container, 'MAX')).toBeUndefined(); // gate re-applied for B
    expect(container.textContent).toMatch(/我要参与/);
  });
});

describe('MobileRoom · follow persistence (关注状态持久化)', () => {
  beforeEach(() => window.localStorage.clear());

  it('reads initial follow state from storage and persists toggles per seller', () => {
    const { container, unmount } = render(<MobileRoom status="LIVE" leaders={[]} sellerId="seller-x"/>);
    const followBtn = findBtn(container, '关注');
    expect(followBtn.textContent).toContain('+ 关注');

    fireEvent.click(followBtn);
    expect(followBtn.textContent).toContain('已关注');
    expect(window.localStorage.getItem('lumen.follow.seller-x')).toBe('1');
    unmount();

    // Fresh mount must initialise from storage → already following.
    const { container: c2 } = render(<MobileRoom status="LIVE" leaders={[]} sellerId="seller-x"/>);
    expect(findBtn(c2, '关注').textContent).toContain('已关注');
  });
});

describe('MobileRoom · recent bids strip (出价历史)', () => {
  it('renders recent bid names when history is present', () => {
    const { container } = render(
      <MobileRoom status="LIVE" leaders={[]} recentBids={[
        { id: 1, name: '海风_2024', cents: '12880000' },
        { id: 2, name: '听雨人', cents: '12750000' },
      ]}/>,
    );
    expect(container.textContent).toMatch(/最近出价/);
    expect(container.textContent).toMatch(/海风_2024/);
  });

  it('renders no strip when there is no history', () => {
    const { container } = render(<MobileRoom status="LIVE" leaders={[]} recentBids={[]}/>);
    expect(container.textContent).not.toMatch(/最近出价/);
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
