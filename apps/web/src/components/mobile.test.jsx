// src/components/mobile.test.jsx
//
// Tests for MobileRoom terminal-state overlays (TC-T6-104/105 added in #54)
// and the PullToResync gesture component (TC-T6-#51-H2 added in #63).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileEvidence, MobileRoom } from './mobile.jsx';
import { PullToResync } from './PullToResync.jsx';
import { BidErrorCode, bidRejectCopy, ConnStatus } from '../lib/types.js';

describe('MobileRoom · TerminalOverlay (TC-T6-104/105)', () => {
  it('forwards syncing gap to ConnectionBar', () => {
    const { container } = render(
      <MobileRoom
        status="LIVE"
        connStatus={ConnStatus.SYNCING}
        connGap={{ from: 1450, to: 1472 }}
        leaders={[]}
      />,
    );
    expect(container.textContent).toContain('正在同步 #1450→#1472');
  });

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

describe('MobileEvidence · summary winner visibility', () => {
  it('shows winner for SOLD evidence and hides it when winner is not present', () => {
    const soldEvidence = {
      auctionId: 'a1',
      status: 'SOLD',
      currentPriceCents: '12000',
      winnerId: 'winner-user',
      timeline: [
        { seq: 1, eventType: 'BID_ACCEPTED', payload: '{"userId":"bid-user","displayName":"Bidder","amountCents":"11000"}', eventHash: 'aaa', prevHash: '000', },
        { seq: 2, eventType: 'AUCTION_SOLD', payload: '{"winnerId":"winner-user","amountCents":"12000"}', eventHash: 'bbb', prevHash: 'aaa' },
      ],
      chainVerified: true,
      eventsHash: 'ccc',
    };

    const soldRender = render(<MobileEvidence evidence={soldEvidence} />);
    expect(soldRender.container.textContent).toContain('拍卖状态: SOLD · 成交方: winner-user');

    const noBidEvidence = {
      ...soldEvidence,
      status: 'NO_BID',
      winnerId: '',
      timeline: [
        { seq: 1, eventType: 'BID_ACCEPTED', payload: '{"userId":"bid-user","displayName":"Bidder","amountCents":"11000"}', eventHash: 'aaa', prevHash: '000', },
      ],
    };

    const noBidRender = render(<MobileEvidence evidence={noBidEvidence} />);
    expect(noBidRender.container.textContent).not.toContain('成交方:');
  });

  it('shows second-price settlement label on evidence for second-price mode', () => {
    const soldEvidence = {
      auctionId: 'a4',
      status: 'SOLD',
      currentPriceCents: '12000',
      winnerId: 'winner-user',
      winnerDisplayName: '赢家',
      auctionMode: 'second_price',
      timeline: [
        { seq: 1, eventType: 'BID_ACCEPTED', payload: '{"userId":"bidder","displayName":"先到先得","amountCents":"12000"}', eventHash: 'aaa', prevHash: '000', },
        { seq: 2, eventType: 'AUCTION_SOLD', payload: '{"winnerId":"winner-user","amountCents":"12000"}', eventHash: 'bbb', prevHash: 'aaa' },
      ],
      chainVerified: true,
      eventsHash: 'ccc',
    };

    const soldRender = render(<MobileEvidence evidence={soldEvidence} />);
    expect(soldRender.container.textContent).toContain('结算规则：二价拍 · 赢者付次高价');
  });

  it('prefers winnerDisplayName when provided by evidence summary', () => {
    const evidence = {
      auctionId: 'a2',
      status: 'ORDER_CREATED',
      currentPriceCents: '15000',
      winnerId: 'winner-user',
      winnerDisplayName: '优先展示名字',
      timeline: [
        { seq: 1, eventType: 'BID_ACCEPTED', payload: '{"userId":"bid-user","displayName":"Bidder","amountCents":"11000"}', eventHash: 'aaa', prevHash: '000' },
        { seq: 2, eventType: 'AUCTION_SOLD', payload: '{"winnerId":"winner-user","amountCents":"15000"}', eventHash: 'bbb', prevHash: 'aaa' },
      ],
      chainVerified: true,
      eventsHash: 'ccc',
    };

    const renderResult = render(<MobileEvidence evidence={evidence} />);
    expect(renderResult.container.textContent).toContain('拍卖状态: ORDER_CREATED · 成交方: 优先展示名字');
  });

  it('falls back summary winnerDisplayName to sold-event winner when evidence summary is empty', () => {
    const evidence = {
      auctionId: 'a3',
      status: 'ORDER_CREATED',
      currentPriceCents: '15000',
      winnerDisplayName: '',
      winnerId: 'winner-id',
      timeline: [
        { seq: 1, eventType: 'BID_ACCEPTED', payload: '{"userId":"bid-user","displayName":"","amountCents":"11000"}', eventHash: 'aaa', prevHash: '000' },
        { seq: 2, eventType: 'AUCTION_SOLD', payload: '{"winnerId":"sold-user","amountCents":"15000"}', eventHash: 'bbb', prevHash: 'aaa' },
      ],
      chainVerified: true,
      eventsHash: 'ccc',
    };

    const renderResult = render(<MobileEvidence evidence={evidence} />);
    expect(renderResult.container.textContent).toContain('拍卖状态: ORDER_CREATED · 成交方: sold-user');
  });
});
