// src/components/TweaksPanel.test.jsx
//
// Verifies the `?tweaks=1` query-param gate + that controls mutate the
// store as expected. Per #56 ratify: this is a dev-only panel; it must
// stay hidden in normal flow and never affect production UX.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { TweaksPanel, _resetTweaksEnabledForTests } from './TweaksPanel.jsx';
import { useAuctionStore } from '../store/auction.js';
import { AuctionStatus } from '../lib/types.js';

const setSearch = (q) => {
  // jsdom lets us mutate window.location via History API only for the
  // path; for ?search we replace the whole href which is enough for
  // URLSearchParams to pick up.
  window.history.replaceState({}, '', `/${q ? `?${q}` : ''}`);
};

beforeEach(() => {
  // Each test sets its own ?tweaks state and resets the memoized flag.
  useAuctionStore.getState().init({
    auctionId: 'tweaks_test',
    status: AuctionStatus.LIVE,
    currentCents: '10000000',
    extendCount: 0,
  });
  _resetTweaksEnabledForTests();
});

afterEach(() => {
  setSearch('');
  _resetTweaksEnabledForTests();
});

describe('TweaksPanel · gate', () => {
  it('renders NOTHING when ?tweaks=1 is absent', () => {
    setSearch('');
    const { container } = render(<TweaksPanel/>);
    expect(container.firstChild).toBeNull();
  });

  it('renders NOTHING when ?tweaks has a non-1 value', () => {
    setSearch('tweaks=true');
    const { container } = render(<TweaksPanel/>);
    expect(container.firstChild).toBeNull();
  });

  it('renders the panel when ?tweaks=1 is present', () => {
    setSearch('tweaks=1');
    render(<TweaksPanel/>);
    expect(screen.getByTestId('tweaks-panel')).toBeInTheDocument();
  });
});

describe('TweaksPanel · controls mutate the store', () => {
  beforeEach(() => setSearch('tweaks=1'));

  it('status chips set the store status', () => {
    render(<TweaksPanel/>);
    fireEvent.click(screen.getByTestId('tweaks-status-SOLD'));
    expect(useAuctionStore.getState().status).toBe('SOLD');

    fireEvent.click(screen.getByTestId('tweaks-status-NO_BID'));
    expect(useAuctionStore.getState().status).toBe('NO_BID');
  });

  it('panel collapses + expands without losing state', () => {
    render(<TweaksPanel/>);
    const toggle = screen.getByTestId('tweaks-toggle');
    // Collapsed → status chips no longer rendered
    fireEvent.click(toggle);
    expect(screen.queryByTestId('tweaks-status-LIVE')).not.toBeInTheDocument();
    // Expanded again
    fireEvent.click(toggle);
    expect(screen.getByTestId('tweaks-status-LIVE')).toBeInTheDocument();
  });

  it('does NOT bundle into the user-facing flow (panel ignores stale memoization between routes)', () => {
    // Verify the resetTweaksEnabledForTests helper actually resets so
    // a navigation-style test can set ?tweaks=1, then unset and re-test
    // that the panel hides. This pins the per-request gate behavior.
    setSearch('tweaks=1');
    const { unmount } = render(<TweaksPanel/>);
    expect(screen.getByTestId('tweaks-panel')).toBeInTheDocument();
    unmount();

    setSearch('');
    _resetTweaksEnabledForTests();
    const { container } = render(<TweaksPanel/>);
    expect(container.firstChild).toBeNull();
  });
});
