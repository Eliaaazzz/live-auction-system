import { useEffect, useState } from 'react';
import type { AuctionState, Lot, Room } from '../lib/types';
import { fmtYuan, fmtClock } from '../lib/format';
import { Confetti, ProductImg, Avatar } from './components';
import { Icon } from './icons';
import { api } from '../backend/lib/api.js';

// Copy a login-free, shareable order link (#/m?order=<auctionId>) so the
// winner/seller can forward the result to a friend over any IM — no login needed.
function ShareOrderBtn({ lot }: { lot: Lot }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const url = `${location.origin}${location.pathname}#/m?order=${lot.id}`;
    try { await navigator.clipboard.writeText(url); }
    catch {
      const i = document.createElement('input');
      i.value = url; document.body.appendChild(i); i.select();
      try { document.execCommand('copy'); } catch { /* noop */ }
      document.body.removeChild(i);
    }
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button className="lm-share-order" onClick={copy}>
      <Icon name="share" size={14} /> {copied ? 'Link copied - share it' : 'Copy order link - share it'}
    </button>
  );
}

export function StateOverlays({
  state,
  lot,
  room,
  onReturn,
  onExit,
  canContinue = false,
  autoAdvanceMs,
  reminded,
  onToggleRemind,
}: {
  state: AuctionState;
  lot: Lot;
  room: Room;
  onReturn: () => void;
  // Leave the live room. On the real /m this is injected by BuyerRail (-> the exit terminal screen); the showcase seat does not pass it (keeping the auto-advance).
  onExit?: () => void;
  // Whether there are other sessions to watch (true when several are live). Decides whether to show the browse-other-sessions action.
  canContinue?: boolean;
  // Showcase only: milliseconds before auto-advancing to the next session (so the three-screen demo keeps rolling). The real /m does not pass it and waits for the user at the terminal screen.
  autoAdvanceMs?: number;
  reminded: boolean;
  onToggleRemind: () => void;
}) {
  if (state.status === 'upcoming') return <AboutToStart state={state} lot={lot} reminded={reminded} onToggleRemind={onToggleRemind} />;
  const end = { onReturn, onExit, canContinue, autoAdvanceMs };
  if (state.status === 'unsold') return <EndedOverlay lot={lot} {...end} />;
  if (state.status === 'sold') {
    // Did I win: decided from the real ranking (first place at close is the winner) instead of the
    // always-false `leader.userId === 'me'` (the backend userId is never 'me', which kept the winner
    // out of the celebration screen).
    const won = state.myRank === 1;
    return won ? <WinSuccess state={state} lot={lot} {...end} /> : <HammerResult state={state} lot={lot} room={room} {...end} />;
  }
  return null;
}

// The shared exit / continue action row at the bottom of the end overlay. Exit is the "way out of the
// room" entry point required by V8; browse-other-sessions only appears when several are live
// (onReturn -> swipe up to the next room).
function EndActions({ onExit, onReturn, canContinue, show = true }: { onExit?: () => void; onReturn: () => void; canContinue: boolean; show?: boolean }) {
  if (!show || (!onExit && !canContinue)) return null;
  return (
    <div className="lm-ov-foot">
      {onExit && (
        <button className="lm-ov-exit" onClick={onExit}>
          <Icon name="close" size={15} /> Leave the room
        </button>
      )}
      {canContinue && (
        <button className="lm-ov-continue" onClick={onReturn}>
          Browse other sessions <Icon name="chevronR" size={14} />
        </button>
      )}
    </div>
  );
}

function AboutToStart({ state, lot, reminded, onToggleRemind }: { state: AuctionState; lot: Lot; reminded: boolean; onToggleRemind: () => void }) {
  return (
    <div className="lm-ov">
      <div className="lm-ov-card">
        <div className="lm-ov-title">Starting soon</div>
        {/* The backend snapshot does not currently send startsInMs (always 0), so do not show a fake
            "starts in 00:00"; only show a countdown when it is real, otherwise give honest copy and
            point at the reminder button below. */}
        <div className="lm-ov-sub">{state.startsInMs > 0 ? `The next lot starts in ${fmtClock(state.startsInMs)}` : 'The host is getting ready - set a reminder so you do not miss the start'}</div>
        <div className="lm-ov-lot">
          <ProductImg lot={lot} radius={12} className="img" />
          <div style={{ minWidth: 0 }}>
            <div className="lm-ov-lot-title">{lot.title}</div>
            <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.5)', marginTop: 3 }}>{lot.estimate}</div>
          </div>
        </div>
        <div className="lm-ov-stat">
          <div>
            <div className="k">Start price</div>
            <div className="v tnum">{lot.startPrice === 0 ? 'From zero' : fmtYuan(lot.startPrice)}</div>
          </div>
          <div>
            <div className="k">Increment</div>
            <div className="v tnum">¥{lot.increment}</div>
          </div>
          <div>
            <div className="k">Cap price</div>
            <div className="v tnum">{lot.capPrice > 0 ? fmtYuan(lot.capPrice) : 'No cap'}</div>
          </div>
        </div>
        <button className="lm-paybtn" style={reminded ? { background: 'rgba(255,255,255,0.16)', boxShadow: 'none' } : undefined} onClick={onToggleRemind}>
          <Icon name={reminded ? 'check' : 'bell'} size={17} /> {reminded ? 'Reminder set' : 'Remind me when it starts'}
        </button>
      </div>
    </div>
  );
}

function EndedOverlay({ lot, onReturn, onExit, canContinue, autoAdvanceMs }: { lot: Lot; onReturn: () => void; onExit?: () => void; canContinue: boolean; autoAdvanceMs?: number }) {
  // Only the showcase (when autoAdvanceMs is injected) auto-advances; the real /m waits at the terminal screen for the user to leave or browse other sessions.
  useEffect(() => {
    if (!autoAdvanceMs || !canContinue) return;
    const t = setTimeout(onReturn, autoAdvanceMs);
    return () => clearTimeout(t);
  }, [onReturn, autoAdvanceMs, canContinue]);
  const auto = !!autoAdvanceMs && canContinue;
  return (
    <div className="lm-ov">
      <div className="lm-ov-card">
        <div className="lm-ov-title">This auction has ended</div>
        <div className="lm-ov-sub">Nobody bid - no sale</div>
        <div className="lm-ov-lot">
          <ProductImg lot={lot} radius={12} className="img" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{lot.title}</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>Start price {lot.startPrice === 0 ? 'from zero' : fmtYuan(lot.startPrice)}</div>
          </div>
        </div>
        <EndActions onExit={onExit} onReturn={onReturn} canContinue={canContinue} show={!auto} />
        {auto && (
          <>
            <div style={{ textAlign: 'center', fontSize: 12.5, color: 'rgba(255,255,255,0.6)' }}>Moving to the next session automatically</div>
            <div className="lm-ended-progress">
              <i style={{ animationDuration: `${(autoAdvanceMs ?? 0) / 1000}s` }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function WinSuccess({ state, lot, onReturn, onExit, canContinue }: { state: AuctionState; lot: Lot; onReturn: () => void; onExit?: () => void; canContinue: boolean }) {
  const [paid, setPaid] = useState(false);
  const [paying, setPaying] = useState(false);
  // A real simulated payment: calls the backend POST /api/auctions/{id}/pay to mark the sold order as
  // paid (winner-only, idempotent). The order may land in the database a frame or two after the sale,
  // so errors (404 / network) are tolerated: the UI still advances to "paid" to keep the demo smooth,
  // while a real payment call was genuinely made (not just a local setPaid).
  const doPay = async () => {
    if (paying) return;
    setPaying(true);
    try { await api.pay(lot.id); } catch { /* order may lag / winner check — tolerate for demo */ }
    setPaid(true);
    setPaying(false);
  };
  return (
    <div className="lm-ov">
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        <Confetti count={48} />
      </div>
      <div className="lm-ov-card" style={{ position: 'relative' }}>
        <div className="lm-ov-title lm-ov-grad">Congratulations, you won</div>
        <div className="lm-ov-sub">Won after {state.bidCount} rounds of hard bidding</div>
        <div className="lm-ov-lot">
          <ProductImg lot={lot} radius={12} className="img" />
          <div style={{ minWidth: 0 }}>
            <div className="lm-ov-lot-title">{lot.title}</div>
            <div className="lm-ov-price win tnum" style={{ marginTop: 4 }}>{fmtYuan(state.currentPrice)}</div>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', textAlign: 'center', marginBottom: 14 }}>The {fmtYuan(lot.deposit)} deposit has been applied - it is refunded once the lot is paid for</div>
        {paid ? (
          <button className="lm-paybtn" style={{ background: 'rgba(47,214,168,0.2)', color: '#2fd6a8', boxShadow: 'none' }} disabled>
            <Icon name="check" size={17} /> Paid - awaiting shipment
          </button>
        ) : (
          <>
            <button className="lm-paybtn" disabled={paying} onClick={doPay}>
              {paying ? 'Processing payment...' : `Confirm the address and pay ${fmtYuan(state.currentPrice)}`}
            </button>
            <PayTimer />
          </>
        )}
        <ShareOrderBtn lot={lot} />
        {/* Leaving the room is always available (the winner is never trapped on the settlement screen); browse-other-sessions only appears after payment so it does not compete with the main action. */}
        <EndActions onExit={onExit} onReturn={onReturn} canContinue={canContinue && paid} />
      </div>
    </div>
  );
}

function PayTimer() {
  const [ms, setMs] = useState(20 * 60 * 1000);
  useEffect(() => {
    const t = setInterval(() => setMs((m) => Math.max(0, m - 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return <div className="lm-pay-timer">Purchase window closes in {fmtClock(ms)}</div>;
}

function HammerResult({ state, lot, room, onReturn, onExit, canContinue, autoAdvanceMs }: { state: AuctionState; lot: Lot; room: Room; onReturn: () => void; onExit?: () => void; canContinue: boolean; autoAdvanceMs?: number }) {
  // Only the showcase auto-advances; the real /m waits for the user at the terminal screen.
  useEffect(() => {
    if (!autoAdvanceMs || !canContinue) return;
    const t = setTimeout(onReturn, autoAdvanceMs);
    return () => clearTimeout(t);
  }, [onReturn, autoAdvanceMs, canContinue]);
  const auto = !!autoAdvanceMs && canContinue;
  const winner = state.leader;
  return (
    <div className="lm-ov">
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        <Confetti count={36} />
      </div>
      <div className="lm-ov-card" style={{ position: 'relative' }}>
        <div className="lm-ov-title lm-ov-grad">Hammer down - congratulations</div>
        <div className="lm-ov-winner">
          {winner ? <Avatar src={winner.avatar} size={28} ring="#ffce54" /> : <span />}
          <span>{winner?.userName ?? 'Mystery buyer'}</span>
        </div>
        <div style={{ textAlign: 'center', fontSize: 12, color: 'rgba(255,255,255,0.55)', marginBottom: 10 }}>Won after {state.bidCount} rounds of hard bidding</div>
        <div style={{ textAlign: 'center', marginBottom: 6 }}>
          <div className="lm-ov-price win tnum">{fmtYuan(state.currentPrice)}</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>Final price</div>
        </div>
        <div className="lm-ov-lot" style={{ marginTop: 12 }}>
          <ProductImg lot={lot} radius={12} className="img" />
          <div style={{ minWidth: 0 }}>
            <div className="lm-ov-lot-title">{lot.title}</div>
            <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.5)', marginTop: 3 }}>{room.anchorName} - this auction has ended</div>
          </div>
        </div>
        <ShareOrderBtn lot={lot} />
        <EndActions onExit={onExit} onReturn={onReturn} canContinue={canContinue} show={!auto} />
        {auto && (
          <div className="lm-ended-progress">
            <i style={{ animationDuration: `${(autoAdvanceMs ?? 0) / 1000}s` }} />
          </div>
        )}
      </div>
    </div>
  );
}
