// src/components/mobile.test.jsx
//
// Tests for MobileRoom terminal-state overlays (TC-T6-104/105 added in #54)
// and the PullToResync gesture component (TC-T6-#51-H2 added in #63).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileRoom } from './mobile.jsx';
import { PullToResync } from './PullToResync.jsx';
import { BidErrorCode, bidRejectCopy } from '../lib/types.js';

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
