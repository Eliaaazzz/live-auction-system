import { useState } from 'react';
import type { AuctionState, Lot } from '../lib/types';
import { fmtMoney, fmtYuan, fmtClock } from '../lib/format';
import { computeIncrement } from '../lib/pricing';
import { Icon } from './icons';
import { ProductImg } from './components';

/**
 * The bid sheet - three states from the reference design: a normal bid, several steps at once, and outbidding yourself.
 */
export function BidSheet({
  lot,
  state,
  nextMinBid,
  onClose,
  onConfirm,
}: {
  lot: Lot;
  state: AuctionState;
  nextMinBid: number;
  onClose: () => void;
  onConfirm: (amount: number) => void;
}) {
  const [amount, setAmount] = useState(nextMinBid);
  // Am I already the highest bidder: decided from the real ranking (myRank===1) rather than the mock ME (whose id never equals a backend userId).
  const iAmHighest = state.myRank === 1;
  // Dynamic increment: computed from the item's value and the number of viewers online, never below the backend minimum step.
  const dynStep = Math.max(lot.increment, computeIncrement(lot.capPrice > 0 ? lot.capPrice : state.currentPrice, state.participants, lot.increment));
  // A cap price of 0 means no cap (unlimited); effCap is used for clamping and validation so it is not mistaken for a ¥0 cap that would disable bidding.
  const effCap = lot.capPrice > 0 ? lot.capPrice : Number.MAX_SAFE_INTEGER;

  // #2 do not jump around with the live price: the amount the user set stays put. When the price passes
  // it we do not silently change it - we clamp to the latest minimum only when "bid" is tapped (bidAmt)
  // and show a "the price went up" hint.
  const dec = () => setAmount((a) => Math.max(nextMinBid, a - dynStep));
  const inc = () => setAmount((a) => Math.min(effCap, a + dynStep));
  const bidAmt = Math.min(effCap, Math.max(amount, nextMinBid));
  const staleLow = amount < nextMinBid;

  const quicks = [
    { label: '+1 step', value: nextMinBid },
    { label: '¥100 over current', value: state.currentPrice + 100, hot: true },
    ...(lot.capPrice > 0 ? [{ label: 'Go straight to the cap', value: lot.capPrice }] : []),
  ].filter((q) => q.value >= nextMinBid && q.value <= effCap);

  const valid = nextMinBid <= effCap; // a bid at the latest minimum is always possible (bidAmt is clamped to [nextMinBid, effCap])

  return (
    <div className="lm-mask" onClick={onClose}>
      <div className="lm-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="lm-sheet-grip" />
        <div className="lm-sheet-cd">
          Auction ends in <b className="tnum">{fmtClock(state.remainingMs)}</b>
        </div>

        <div className="lm-sheet-lot">
          <ProductImg lot={lot} radius={12} className="img" />
          <div>
            <div className="ti">{lot.title}</div>
            <div className="es">{lot.estimate}</div>
          </div>
        </div>

        <div className="lm-sheet-cur">
          <div>
            <div className="k">Current price - {state.leader ? state.leader.userName + ' leading' : 'starts at zero'}</div>
            <div className="v tnum">{fmtYuan(state.currentPrice)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="k">My bid</div>
            <div className="v tnum" style={{ color: state.myMaxBid ? '#ffce54' : 'rgba(255,255,255,0.4)' }}>
              {state.myMaxBid ? fmtYuan(state.myMaxBid) : 'No bid yet'}
            </div>
          </div>
        </div>

        <div className="lm-bigstep">
          <button onClick={dec} disabled={amount <= nextMinBid} aria-label="Decrease">
            <Icon name="minus" size={22} />
          </button>
          <div className="amt tnum">
            <small>¥</small>
            {fmtMoney(amount)}
          </div>
          <button onClick={inc} disabled={amount >= effCap} aria-label="Increase">
            <Icon name="plus" size={22} />
          </button>
        </div>
        <div className="lm-incr-note">Increment ¥{dynStep} (scales with activity) - minimum bid {fmtYuan(nextMinBid)} - cap {lot.capPrice > 0 ? fmtYuan(lot.capPrice) : 'none'}</div>

        <div className="lm-quickrow">
          {quicks.map((q) => (
            <div key={q.label} className={'q' + (q.hot ? ' hot' : '')} onClick={() => setAmount(q.value)}>
              {q.label}
            </div>
          ))}
        </div>

        <button className={'lm-cta' + (iAmHighest ? ' self' : '')} disabled={!valid} onClick={() => onConfirm(bidAmt)}>
          {iAmHighest ? `Raise again - bid ${fmtYuan(bidAmt)}` : `Bid now ${fmtYuan(bidAmt)}`}
        </button>

        {staleLow && (
          <div className="lm-warn">
            <Icon name="bolt" size={13} /> The price went up - your bid will go in at the latest minimum, {fmtYuan(nextMinBid)}
          </div>
        )}
        {iAmHighest && (
          <div className="lm-warn">
            <Icon name="bolt" size={13} /> You are already the highest bidder - outbid yourself?
          </div>
        )}
        {lot.capPrice > 0 && amount >= lot.capPrice && (
          <div className="lm-warn">
            <Icon name="gavel" size={13} /> The cap price is reached - this bid closes the sale immediately
          </div>
        )}
      </div>
    </div>
  );
}
