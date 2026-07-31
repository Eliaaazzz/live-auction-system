import { useState } from 'react';
import type { AuctionState, Lot } from '../lib/types';
import { fmtYuan, fmtCompactYuan } from '../lib/format';
import { computeIncrement } from '../lib/pricing';
import { ME } from '../lib/mockData';
import { Icon, type IconName } from './icons';
import { Avatar } from './components';

export type TabKey = 'overview' | 'history' | 'comments' | 'join' | 'rules';

export interface CommentItem { id: number; name: string; text: string; color?: string; self?: boolean; avatar?: string; }

interface SheetProps {
  state: AuctionState;
  lot: Lot;
  joined: boolean;
  agreed: boolean;
  onAgree: (v: boolean) => void;
  onJoin: () => void;
  placeBid: (amount: number) => { ok: boolean; reason?: string };
  nextMinBid: number;
  autoBidMax: number | null;
  setAutoBidMax: (n: number | null) => void;
  comments: CommentItem[];
  onSendComment: (text: string) => void;
  onOpenSheetBid: () => void;
  setActive: (t: TabKey) => void;
}

const TAB_META: { key: TabKey; label: string; icon: IconName }[] = [
  { key: 'overview', label: 'Overview', icon: 'trophy' },
  { key: 'history', label: 'History', icon: 'clock' },
  { key: 'comments', label: 'Comments', icon: 'comment' },
  { key: 'join', label: 'Join', icon: 'gavel' },
  { key: 'rules', label: 'Rules', icon: 'shield' },
];

export function BottomTabs({ active, joined, unread, leadDot, onTap }: { active: TabKey | null; joined: boolean; unread: number; leadDot: boolean; onTap: (t: TabKey) => void; }) {
  return (
    <div className="lm-tabbar">
      {TAB_META.map((t) => {
        const label = t.key === 'join' ? (joined ? 'Bid' : 'Join') : t.label;
        const on = active === t.key;
        return (
          <button key={t.key} className={'lm-tabbtn' + (on ? ' on' : '')} onClick={() => onTap(t.key)}>
            <span className="lm-tabbtn-ic">
              <Icon name={t.icon} size={20} fill={on} stroke={1.9} />
              {t.key === 'comments' && unread > 0 && !on && <i className="lm-tabdot" />}
              {t.key === 'join' && leadDot && <i className="lm-tabdot gold" />}
            </span>
            <span className="lm-tabbtn-l">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TabSheet({ active, onClose, ...p }: SheetProps & { active: TabKey | null; onClose: () => void }) {
  if (!active) return null;
  const title = active === 'overview' ? 'Live ranking' : active === 'history' ? 'Bid history' : active === 'comments' ? 'Comments' : active === 'join' ? (p.joined ? 'Place a bid' : 'Join the auction') : 'Auction rules';
  return (
    <>
      <div className="lm-sheet-backdrop" onClick={onClose} />
      <div className="lm-tabsheet">
        <div className="lm-tabsheet-head">
          <div className="lm-tabsheet-grip" onClick={onClose} />
          <span className="lm-tabsheet-title">{title}</span>
          <button className="lm-tabsheet-x" onClick={onClose} aria-label="Collapse"><Icon name="chevronD" size={18} /></button>
        </div>
        <div className="lm-tabsheet-body no-sb">
          {active === 'overview' && <OverviewTab {...p} />}
          {active === 'history' && <HistoryTab state={p.state} />}
          {active === 'comments' && <CommentsTab comments={p.comments} onSend={p.onSendComment} />}
          {active === 'join' && (p.joined ? <AuctionTab {...p} /> : <ParticipateTab {...p} />)}
          {active === 'rules' && <RulesTab lot={p.lot} online={p.state.participants} />}
        </div>
      </div>
    </>
  );
}

function OverviewTab({ state, joined, setActive }: SheetProps) {
  const first = state.ranking[0];
  const second = state.ranking[1];
  const iLead = state.myRank === 1;
  const gap = state.myMaxBid != null ? Math.max(0, state.currentPrice - state.myMaxBid) : state.currentPrice;
  // #261-4/9: when first or second place is you, show "Me" (this client's view); otherwise show the real name.
  const nameOf = (r?: { userName: string; self?: boolean }) => (r ? (r.self ? 'Me' : r.userName) : 'Open spot');
  return (
    <div>
      <div className="lm-section-t"><Icon name="trophy" size={13} /> Live ranking - {state.participants} participants - {state.bidCount} bids</div>
      <div className="lm-podium">
        <div className={'lm-rankcard r1' + (first?.self ? ' me' : '')}>
          <div className="lm-rank-badge"><Icon name="crown" size={12} fill /> 1st - leading</div>
          <div className="lm-rank-user">{first ? <Avatar src={first.avatar} size={22} /> : <span className="lm-rank-ph" />}<span className="lm-rank-nm">{nameOf(first)}</span></div>
          <div className="lm-rank-amt tnum">{first ? fmtCompactYuan(first.amount) : fmtYuan(0)}</div>
        </div>
        <div className={'lm-rankcard r2' + (second?.self ? ' me' : '')}>
          <div className="lm-rank-badge">2nd - close behind</div>
          <div className="lm-rank-user">{second ? <Avatar src={second.avatar} size={22} /> : <span className="lm-rank-ph" />}<span className="lm-rank-nm">{nameOf(second)}</span></div>
          <div className="lm-rank-amt tnum">{second ? fmtCompactYuan(second.amount) : '—'}</div>
        </div>
      </div>
      {iLead ? (
        <div className="lm-lead-note"><Icon name="lock" size={14} /> You are holding 1st place - consider raising your bid to stay ahead</div>
      ) : joined && state.myRank != null ? (
        <div className="lm-myrow">
          <div className="left"><span className="lm-myrank-pill">#{state.myRank}</span><div><div style={{ fontSize: 12.5, fontWeight: 700 }}>My highest bid</div><div className="tnum" style={{ fontSize: 14, fontWeight: 800, color: '#ffce54' }}>{fmtYuan(state.myMaxBid ?? 0)}</div></div></div>
          <div className="lm-gap"><div className="v tnum">{fmtCompactYuan(gap)}</div><div className="l">Gap to 1st</div></div>
        </div>
      ) : (
        <div className="lm-myrow" style={{ cursor: 'pointer' }} onClick={() => setActive('join')}>
          <div className="left"><span className="lm-myrank-pill">Unranked</span><div style={{ fontSize: 12.5 }}>Tap Join to enter the auction and go for 1st</div></div>
          <Icon name="chevronR" size={18} style={{ color: '#ff8fa3' }} />
        </div>
      )}
      {/* #UIUX fill out the ranking panel: a recent-bids list under the ranking card, so the lower half is
          no longer empty black; it shows that the highest bid wins and the price is still climbing, which
          explains why to keep bidding, and links to the full history at the bottom. */}
      {state.bids.length > 0 ? (
        <div className="lm-recent">
          <div className="lm-recent-h"><Icon name="clock" size={12} /> Recent bids</div>
          {state.bids.slice(0, 6).map((b, i) => (
            <div className={'lm-recent-row' + (b.self ? ' self' : '')} key={b.id}>
              <Avatar src={b.avatar} size={20} />
              <span className="nm">{b.self ? 'Me' : b.userName}</span>
              {i === 0 && <span className="tag">Leading</span>}
              <span className="amt tnum">{fmtCompactYuan(b.amount)}</span>
            </div>
          ))}
          <div className="lm-recent-more" onClick={() => setActive('history')}>See the full bid history ›</div>
        </div>
      ) : (
        <div className="lm-recent-empty">Recent bids appear here live once the auction opens - highest bid wins</div>
      )}
    </div>
  );
}

function HistoryTab({ state }: { state: AuctionState }) {
  const rows = state.bids.slice(0, 50);
  const now = Date.now();
  const ago = (ts: number) => { const s = Math.max(0, Math.round((now - ts) / 1000)); return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`; };
  return (
    <div>
      <div className="lm-section-t"><Icon name="clock" size={13} /> Bid history - {state.bidCount} in total (latest 50)</div>
      {rows.length === 0 && <div className="lm-empty">No bids yet - be the first</div>}
      {/* #261-1 fixed height with its own scrollbar, so a long list never pushes the panel open */}
      <div className="lm-hist-list">
        {rows.map((b, i) => (
          <div className={'lm-hist-row' + (b.self ? ' self' : '')} key={b.id}>
            <Avatar src={b.avatar} size={26} />
            <span className="lm-hist-nm">{b.self ? 'Me' : b.userName}</span>
            {String(b.userId || '').startsWith('user_sim') && <span className="lm-hist-sim">sim</span>}
            {i === 0 && <span className="lm-hist-lead">Leading</span>}
            <span className={'lm-hist-amt tnum' + (i === 0 ? ' lead' : '')}>{fmtCompactYuan(b.amount)}</span>
            <span className="lm-hist-t">{ago(b.ts)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CommentsTab({ comments, onSend }: { comments: CommentItem[]; onSend: (t: string) => void }) {
  const [text, setText] = useState('');
  const send = () => { const t = text.trim(); if (!t) return; onSend(t); setText(''); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="no-sb" style={{ flex: 1, overflowY: 'auto' }}>
        {comments.map((c) => (
          <div className="lm-cmt" key={c.id}>
            <Avatar src={c.avatar ?? `https://i.pravatar.cc/40?img=${(c.id % 60) + 1}`} size={26} ring={c.self ? '#fe2c55' : undefined} />
            <div className="bd"><span className="nm" style={c.color ? { color: c.color } : undefined}>{c.name}</span>{c.text}</div>
          </div>
        ))}
      </div>
      <div className="lm-cmt-input">
        <input className="lm-input" placeholder="Say something..." value={text} maxLength={50} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
        <button className="lm-send" onClick={send} aria-label="Send"><Icon name="send" size={18} /></button>
      </div>
    </div>
  );
}

function ParticipateTab({ lot, agreed, onAgree, onJoin }: SheetProps) {
  return (
    <div>
      <div className="lm-join-hd">
        <Icon name="gavel" size={24} style={{ color: '#ff8fa3' }} />
        <div><div style={{ fontSize: 15, fontWeight: 800 }}>Join this auction</div><div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.55)' }}>Complete the steps below to start bidding</div></div>
      </div>
      <div className="lm-req"><Icon name="check" size={15} style={{ color: '#2fd6a8' }} /> Identity verification complete</div>
      <div className="lm-req"><Icon name="check" size={15} style={{ color: '#2fd6a8' }} /> Payment method and shipping address linked</div>
      <div className="lm-req"><Icon name="shield" size={15} style={{ color: '#ffce54' }} /> Deposit of <b style={{ color: '#ffce54' }}>{fmtYuan(lot.deposit)}</b> (refunded after payment, released if you do not win)</div>
      <div className="lm-terms">
        <div className={'lm-checkbox' + (agreed ? ' on' : '')} onClick={() => onAgree(!agreed)}>{agreed && <Icon name="check" size={12} stroke={3} />}</div>
        <div>I have read and accept the <a>Live Auction Terms of Service</a> and the <a>Deposit and Performance Rules</a>. An auction bid is a <b style={{ color: '#ff8fa3' }}>legally binding</b> commitment to buy, and withdrawing forfeits the deposit.</div>
      </div>
      <button className="lm-cta" disabled={!agreed} style={!agreed ? { opacity: 0.5, boxShadow: 'none' } : undefined} onClick={onJoin}>Accept and join - hold a {fmtYuan(lot.deposit)} deposit</button>
    </div>
  );
}

function AuctionTab(p: SheetProps) {
  const { lot, state, nextMinBid, placeBid, autoBidMax, setAutoBidMax, onOpenSheetBid } = p;
  const dynStep = Math.max(lot.increment, computeIncrement(lot.capPrice > 0 ? lot.capPrice : state.currentPrice, state.participants, lot.increment));
  const effCap = lot.capPrice > 0 ? lot.capPrice : Number.MAX_SAFE_INTEGER; // a cap price of 0 means no cap
  const [custom, setCustom] = useState('');
  const [autoOn, setAutoOn] = useState(autoBidMax != null);
  const [autoVal, setAutoVal] = useState(String(autoBidMax ?? state.currentPrice + lot.increment * 6));
  const [msg, setMsg] = useState<string | null>(null);
  const ratios = [{ label: '+1 step', value: nextMinBid }, { label: '+3 steps', value: state.currentPrice + dynStep * 3 }, { label: '+5 steps', value: state.currentPrice + dynStep * 5 }];
  const tryBid = (v: number) => { const r = placeBid(v); setMsg(r.ok ? `Bid of ${fmtYuan(v)} submitted - waiting on server adjudication` : r.reason ?? 'Bid failed'); setTimeout(() => setMsg(null), 1800); };
  const bidCustom = () => { const v = parseInt(custom, 10); if (!Number.isFinite(v)) { setMsg('Enter a valid amount'); return; } tryBid(v); setCustom(''); };
  const toggleAuto = () => { const next = !autoOn; setAutoOn(next); setAutoBidMax(next ? parseInt(autoVal, 10) || null : null); };
  return (
    <div>
      <div className="lm-section-t"><Icon name="bolt" size={13} /> Quick bid - now <b className="tnum" style={{ color: '#fff' }}>{fmtYuan(state.currentPrice)}</b> - increment ¥{dynStep} <span style={{ color: '#ff8fa3' }}>scales with activity</span></div>
      <div className="lm-quickbids">{ratios.map((r) => (<div className="lm-chip" key={r.label} onClick={() => tryBid(Math.min(r.value, effCap))}><div className="x">{r.label}</div><div className="v tnum">{fmtYuan(Math.min(r.value, effCap))}</div></div>))}</div>
      <div className="lm-field">
        <label>Custom bid</label>
        <input className="lm-num tnum" inputMode="numeric" placeholder={`≥ ${nextMinBid}`} value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, ''))} />
        <button className="lm-mini-cta" onClick={bidCustom}>Bid</button>
      </div>
      <div className="lm-field">
        <label>Auto-bid ceiling</label>
        <input className="lm-num tnum" inputMode="numeric" disabled={!autoOn} value={autoVal} onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, ''); setAutoVal(v); if (autoOn) setAutoBidMax(parseInt(v, 10) || null); }} style={!autoOn ? { opacity: 0.4 } : undefined} />
        <div className={'lm-switch' + (autoOn ? ' on' : '')} onClick={toggleAuto}><i /></div>
      </div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 8 }}>Set the highest price you are willing to pay. Bids never go above it, so you stay within budget.</div>
      <button className="lm-cta ghost" onClick={onOpenSheetBid}>Exact bid / raise several steps at once</button>
      {msg && <div className="lm-warn">{msg}</div>}
    </div>
  );
}

function RulesTab({ lot, online }: { lot: Lot; online: number }) {
  const dynStep = Math.max(lot.increment, computeIncrement(lot.capPrice > 0 ? lot.capPrice : lot.startPrice, online, lot.increment));
  const rules: { ic: IconName; t: string; d: string }[] = [
    { ic: 'tag', t: lot.startPrice === 0 ? 'Starts at zero' : `Start price ${fmtYuan(lot.startPrice)}`, d: 'Any verified user can take part.' },
    { ic: 'bolt', t: `Increment ¥${dynStep}`, d: `Computed from the item's value and the number of viewers online, with a floor of ¥${lot.minIncrement}.` },
    { ic: 'gavel', t: lot.capPrice > 0 ? `Cap price ${fmtYuan(lot.capPrice)}` : 'No cap (unlimited)', d: lot.capPrice > 0 ? 'A bid that reaches the cap closes the sale immediately.' : 'This session has no cap - the highest bid wins.' },
    { ic: 'clock', t: `Auto-extend ${lot.extendSec}s`, d: `A bid in the last 10 seconds extends the countdown by ${lot.extendSec} seconds.` },
    { ic: 'shield', t: `Deposit ${fmtYuan(lot.deposit)}`, d: 'Held when you join and refunded after payment; forfeited if you withdraw.' },
    { ic: 'bell', t: 'Abnormal cancellation', d: 'The host or the platform can cancel a faulty auction at any time, releasing deposits immediately.' },
  ];
  return (
    <div>
      <div className="lm-section-t"><Icon name="shield" size={13} /> Auction rules - {lot.category}</div>
      {rules.map((r, i) => (<div className="lm-rule" key={i}><span className="ic"><Icon name={r.ic} size={17} /></span><div><div className="t">{r.t}</div><div className="d">{r.d}</div></div></div>))}
    </div>
  );
}

export { ME };
