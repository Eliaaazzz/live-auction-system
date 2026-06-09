import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineEvent, Room } from '../lib/types';
import { useAuctionEngine } from '../lib/useAuctionEngine';
import { COMMENT_POOL, ENTER_POOL, BOT_USERS, pick } from '../lib/mockData';
import { fmtYuan, fmtCompactYuan, splitClock } from '../lib/format';
import { computeIncrement } from '../lib/pricing';
import { sfx, isMuted, setMuted, unlockAudio } from '../lib/sound';
import { VideoBackground, LiveHeader, LotChip, ActionRail, Danmaku, EmotionFX, RoomSkeleton, GiftPanel, ShareModal, type DanmakuItem, type FxToken, type GiftTier } from './components';
import { BottomTabs, TabSheet, type TabKey, type CommentItem } from './tabs';
import { BidSheet } from './BidSheet';
import { StateOverlays } from './overlays';
import { Icon } from './icons';
import { ProfileButton, AccountSheet } from './account';
import { useIdentity, type SeatIdentity } from '../lib/identity';
import './motion.css';

interface Props { room: Room; seedToPrice?: number; startDelaySec?: number; running?: boolean; onEnded?: () => void; seat?: string; identity?: SeatIdentity; }

export default function LiveRoom({ room, seedToPrice, startDelaySec = 0, running = true, onEnded, seat = '', identity }: Props) {
  const lot = room.lot;
  // Showcase seats (买家A/买家B) pass an explicit per-seat identity; real /m uses
  // the global login store. Everything below reads `ident`, so it works for both.
  const globalIdent = useIdentity();
  const ident = identity ?? globalIdent;
  const [acctOpen, setAcctOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [followed, setFollowed] = useState(() => localStorage.getItem('lf_follow_' + room.id) === '1');
  // localStorage join flag is a client cache; a future backend session/join API will reconcile it.
  const [joined, setJoined] = useState(() => localStorage.getItem('lj_join_' + room.id) === '1');
  const [agreed, setAgreed] = useState(false);
  const [sheetTab, setSheetTab] = useState<TabKey | null>(null);
  const [bidSheetOpen, setBidSheetOpen] = useState(false);
  const [giftOpen, setGiftOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [reminded, setReminded] = useState(false);
  const [feed, setFeed] = useState<DanmakuItem[]>([]);
  const [fx, setFx] = useState<FxToken | null>(null);
  const [unread, setUnread] = useState(0);
  const [soundOn, setSoundOn] = useState(() => !isMuted());
  const [flash, setFlash] = useState<{ id: number; type: 'gold' | 'red' } | null>(null);
  const [gain, setGain] = useState<{ id: number; text: string } | null>(null);
  const [shake, setShake] = useState(false);

  const feedSeq = useRef(0);
  const fxSeq = useRef(0);
  const flashSeq = useRef(0);
  const gainSeq = useRef(0);
  const sheetRef = useRef(sheetTab);
  sheetRef.current = sheetTab;
  const startedAt = useRef(0);
  const prevPrice = useRef(lot.startPrice);
  const lastTickSec = useRef(-1);
  const prevStatus = useRef<string>('');
  const unlocked = useRef(false);

  const pushFeed = useCallback((item: Omit<DanmakuItem, 'id'>) => {
    const id = feedSeq.current++;
    setFeed((f) => [...f.slice(-40), { ...item, id }]);
    if (item.kind !== 'bid' && sheetRef.current !== 'comments') setUnread((u) => u + 1);
  }, []);

  const flashFx = useCallback((type: FxToken['type'], text: string) => {
    const id = fxSeq.current++;
    setFx({ id, type, text });
    setTimeout(() => setFx((cur) => (cur && cur.id === id ? null : cur)), 1500);
  }, []);

  const screenFlash = useCallback((type: 'gold' | 'red') => {
    const id = flashSeq.current++;
    setFlash({ id, type });
    setTimeout(() => setFlash((cur) => (cur && cur.id === id ? null : cur)), 520);
  }, []);

  const triggerShake = useCallback(() => {
    setShake(true);
    setTimeout(() => setShake(false), 420);
  }, []);

  const onEvent = useCallback((e: EngineEvent) => {
    switch (e.kind) {
      case 'leading': flashFx('lead', '领先！第 1 名'); if (!isMuted()) sfx.lead(); screenFlash('gold'); break;
      case 'outbid': flashFx('outbid', '被超越！'); if (!isMuted()) sfx.outbid(); screenFlash('red'); triggerShake(); break;
      case 'extend': flashFx('extend', `倒计时延长 +${e.addSec}s`); if (!isMuted()) sfx.extend(); pushFeed({ kind: 'enter', text: `结束前有人出价，倒计时自动延长 ${e.addSec}s` }); break;
      case 'cap': pushFeed({ kind: 'enter', text: '触发封顶价，即将成交' }); break;
      case 'start': pushFeed({ kind: 'enter', text: '开拍啦，出价开始！' }); break;
      default: break;
    }
  }, [flashFx, pushFeed, screenFlash, triggerShake]);

  // Boot the engine immediately (not gated on !loading) so this room's snapshot
  // starts loading the moment it mounts — the skeleton then clears on `ready`, not
  // a blind timer, so a swipe reveals live data as soon as it lands.
  const { state, nextMinBid, placeBid, setAutoBidMax, autoBidMax, restart, livePlayUrl, ready, auctioneerText } = useAuctionEngine(lot, { seedToPrice, startDelaySec, running, onEvent, nickname: ident.nickname || undefined, seat, selfAvatar: ident.avatar || undefined });

  const revealed = useRef(false);
  const reveal = useCallback(() => {
    if (revealed.current) return;
    revealed.current = true;
    setLoading(false);
    startedAt.current = Date.now();
    prevPrice.current = lot.startPrice;
  }, [lot.startPrice]);

  // Reset on room change (runs before the ready-watcher below so a warm store still
  // reveals instantly). Fallback cap: if the snapshot never lands (offline/slow),
  // reveal anyway after 1.2s so the room is never stuck behind the skeleton.
  useEffect(() => {
    setLoading(true);
    revealed.current = false;
    lastTickSec.current = -1;
    prevStatus.current = '';
    const t = setTimeout(reveal, 1200);
    return () => clearTimeout(t);
  }, [room.id, lot.startPrice, reveal]);

  // Reveal the chrome the instant the snapshot is in the store (real price/bids,
  // no stale-price flash). The poster shows immediately behind the skeleton via
  // VideoBackground, so the swipe is never a black frame.
  useEffect(() => { if (ready) reveal(); }, [ready, reveal]);

  useEffect(() => {
    if (loading) return;
    const t = setInterval(() => {
      if (Math.random() < 0.3) pushFeed({ kind: 'enter', text: pick(ENTER_POOL) });
      else { const u = pick(BOT_USERS); pushFeed({ kind: 'comment', name: u.name, text: pick(COMMENT_POOL), color: u.color, avatar: u.avatar }); }
    }, 2600 + Math.random() * 1600);
    return () => clearInterval(t);
  }, [loading, pushFeed]);

  const lastBidId = useRef<string | null>(null);
  useEffect(() => {
    const top = state.bids[0];
    if (!top || top.id === lastBidId.current) return;
    lastBidId.current = top.id;
    pushFeed({ kind: 'bid', name: top.self ? '我' : top.userName, text: `出价 ${fmtYuan(top.amount)}`, color: top.color, avatar: top.avatar });
    if (top.ts >= startedAt.current && startedAt.current > 0) {
      const delta = Math.max(0, top.amount - prevPrice.current);
      if (delta > 0) {
        const id = gainSeq.current++;
        setGain({ id, text: `+¥${delta.toLocaleString('en-US')}` });
        setTimeout(() => setGain((cur) => (cur && cur.id === id ? null : cur)), 1050);
      }
      if (!top.self && !isMuted()) sfx.bid();
    }
    prevPrice.current = top.amount;
  }, [state.bids, pushFeed]);

  useEffect(() => {
    if (state.status !== 'ending') { lastTickSec.current = -1; return; }
    const sec = Math.ceil(state.remainingMs / 1000);
    if (sec > 0 && sec !== lastTickSec.current) {
      lastTickSec.current = sec;
      if (!isMuted()) (sec <= 5 ? sfx.tickUrgent : sfx.tick)();
    }
  }, [state.status, state.remainingMs]);

  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = state.status;
    if (loading) return;
    if ((prev === 'live' || prev === 'ending') && (state.status === 'sold' || state.status === 'unsold')) {
      if (isMuted()) return;
      if (state.status === 'unsold') sfx.lose();
      else { sfx.hammer(); if (state.myRank === 1) setTimeout(() => sfx.win(), 260); }
    }
  }, [state.status, loading, state.leader]);

  useEffect(() => { if (sheetTab === 'comments') setUnread(0); }, [sheetTab]);

  const danmaku = useMemo(() => feed.slice(-5), [feed]);
  const comments: CommentItem[] = useMemo(() => feed.filter((f) => f.kind !== 'enter').slice(-40).map((f) => ({ id: f.id, name: f.name ?? '观众', text: f.text, color: f.color, self: f.name === '我', avatar: f.avatar })), [feed]);

  const unlockOnce = useCallback(() => { if (unlocked.current) return; unlocked.current = true; unlockAudio(); }, []);
  const toggleSound = () => { setSoundOn((v) => { const nv = !v; setMuted(!nv); if (nv) { unlockAudio(); sfx.tick(); } return nv; }); };
  const toggleFollow = () => setFollowed((v) => { const nv = !v; localStorage.setItem('lf_follow_' + room.id, nv ? '1' : '0'); return nv; });
  const tapTab = (t: TabKey) => { setSheetTab((cur) => (cur === t ? null : t)); if (t === 'comments') setUnread(0); };
  const onJoin = () => { setJoined(true); try { localStorage.setItem('lj_join_' + room.id, '1'); } catch { /* ignore */ } pushFeed({ kind: 'enter', text: '我 已参与竞拍，冻结保证金成功' }); };
  const onSendGift = (g: GiftTier) => { pushFeed({ kind: 'comment', name: '我', text: `送出 ${g.emoji} ${g.name}`, color: '#ffce54', avatar: ident.avatar }); };
  const quickBid = (amount: number) => { if (!joined) { setSheetTab('join'); return; } placeBid(amount); };
  // 流拍/落槌后由 overlay 的 5s 计时器调用：多场次时自动「进入下一件」(BuyerRail.advance，
  // 等同上滑切下一间)；单场次时退回原地重新同步。onEnded 句柄稳定，overlay 计时 effect 才只触发一次。
  const onReturn = useCallback(() => {
    if (onEnded) { onEnded(); return; }
    setLoading(true);
    setTimeout(() => { restart(); setLoading(false); startedAt.current = Date.now(); prevPrice.current = lot.startPrice; }, 600);
  }, [onEnded, restart, lot.startPrice]);

  const live = state.status === 'live' || state.status === 'ending';
  const urgent = state.status === 'ending' && state.remainingMs <= 6000;
  // dynStep is always >= lot.increment (backend floor) so quick bids never reject.
  const dynStep = Math.max(lot.increment, computeIncrement(lot.capPrice > 0 ? lot.capPrice : state.currentPrice, state.participants, lot.increment));

  return (
    <div className="lm-root" onPointerDownCapture={unlockOnce}>
      <VideoBackground lot={lot} liveUrl={livePlayUrl} />
      {!loading && (
        <>
          <LiveHeader room={room} followed={followed} onToggleFollow={toggleFollow} onClose={() => {}} account={<ProfileButton onClick={() => setAcctOpen(true)} avatar={identity?.avatar} />} />
          <div className="lm-rankchip"><Icon name="trophy" size={12} fill /> {room.tagline}</div>
          <LotChip lot={lot} />
          <CountdownPill ms={state.remainingMs} ending={state.status === 'ending'} urgent={urgent} hidden={!live} />
          {auctioneerText && <div className="lm-aibubble"><span className="dot" /> AI 主播 · {auctioneerText}</div>}

          <button className={'lm-sound-btn' + (soundOn ? '' : ' off')} onClick={toggleSound} aria-label={soundOn ? '关闭音效' : '开启音效'}>
            {soundOn ? (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16 8a5 5 0 0 1 0 8" /></svg>
            ) : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M22 9l-6 6M16 9l6 6" /></svg>
            )}
          </button>

          {state.status === 'ending' && <div className="lm-vignette" />}
          {flash && <div key={flash.id} className={'lm-flash ' + flash.type} />}
          {gain && <div key={gain.id} className="lm-gainfloat">{gain.text}</div>}

          <Danmaku items={danmaku} />
          <ActionRail roomId={room.id} cartCount={lot.index} onOpenComments={() => tapTab('comments')} onOpenGift={() => setGiftOpen(true)} onShare={() => setShareOpen(true)} />

          <div className={shake ? 'lm-shake' : undefined}>
            <BidActionBar joined={joined} live={live} myRank={state.myRank} currentPrice={state.currentPrice} myMax={state.myMaxBid} nextMinBid={nextMinBid} increment={dynStep} capPrice={lot.capPrice} onJoin={() => setSheetTab('join')} onBid={quickBid} onOpenSheet={() => setBidSheetOpen(true)} />
          </div>

          <BottomTabs active={sheetTab} joined={joined} unread={unread} leadDot={joined && state.myRank === 1} onTap={tapTab} />

          <TabSheet active={sheetTab} onClose={() => setSheetTab(null)} state={state} lot={lot} joined={joined} agreed={agreed} onAgree={setAgreed} onJoin={onJoin} placeBid={placeBid} nextMinBid={nextMinBid} autoBidMax={autoBidMax} setAutoBidMax={setAutoBidMax} comments={comments} onSendComment={(t) => pushFeed({ kind: 'comment', name: '我', text: t, color: '#fe2c55', avatar: ident.avatar })} onOpenSheetBid={() => setBidSheetOpen(true)} setActive={setSheetTab} />

          <EmotionFX fx={fx} />

          {bidSheetOpen && (
            <BidSheet lot={lot} state={state} nextMinBid={nextMinBid} onClose={() => setBidSheetOpen(false)} onConfirm={(amt) => { if (!joined) { setBidSheetOpen(false); setSheetTab('join'); return; } placeBid(amt); setBidSheetOpen(false); }} />
          )}

          <StateOverlays state={state} lot={lot} room={room} onReturn={onReturn} reminded={reminded} onToggleRemind={() => setReminded((v) => !v)} />

          <GiftPanel roomId={room.id} open={giftOpen} onClose={() => setGiftOpen(false)} onSend={onSendGift} />
          <ShareModal roomId={room.id} open={shareOpen} onClose={() => setShareOpen(false)} />
          {!seat && <AccountSheet open={acctOpen} onClose={() => setAcctOpen(false)} />}
        </>
      )}
      {loading && <RoomSkeleton />}
    </div>
  );
}

function CountdownPill({ ms, ending, urgent, hidden }: { ms: number; ending: boolean; urgent: boolean; hidden: boolean }) {
  if (hidden) return null;
  const { m, s, cs } = splitClock(ms);
  return (
    <div className={'lm-cd' + (ending ? ' end' : '') + (urgent ? ' urgent' : '')}>
      <Icon name={ending ? 'flame' : 'clock'} size={13} fill={ending} />
      <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.9 }}>{ending ? '截拍中' : '距结束'}</span>
      <span key={ending ? s : undefined} className="tnum" style={{ fontWeight: 800 }}>{m}:{s}{ending && <span style={{ opacity: 0.8 }}>:{cs}</span>}</span>
    </div>
  );
}

function BidActionBar({ joined, live, myRank, currentPrice, myMax, nextMinBid, increment, capPrice, onJoin, onBid, onOpenSheet }: { joined: boolean; live: boolean; myRank: number | null; currentPrice: number; myMax: number | null; nextMinBid: number; increment: number; capPrice: number; onJoin: () => void; onBid: (amount: number) => void; onOpenSheet: () => void; }) {
  const [amt, setAmt] = useState(nextMinBid);
  const effCap = capPrice > 0 ? capPrice : Number.MAX_SAFE_INTEGER; // 封顶价 0 = 不封顶
  // #2 不随直播价「自己跳动」：别人出价时保持我设好的数字不变。价格涨过我的数字时
  // 不静默改它，只在点「出价」那一刻按最新最低价钳制提交，并提示「价已涨」。
  const bidAmt = Math.min(effCap, Math.max(amt, nextMinBid));
  const staleLow = amt < nextMinBid;

  if (!joined) {
    return (<div className="lm-bidbar"><button className="lm-bidcta join" onClick={onJoin}><span><Icon name="gavel" size={18} /> 我要参与竞拍</span><span className="sub">同意服务条款后即可出价</span></button></div>);
  }
  if (!live) {
    return (<div className="lm-bidbar"><button className="lm-bidcta" disabled>竞拍已结束</button></div>);
  }
  if (myRank === 1) {
    const rec = increment * 2;
    const recBid = Math.min(effCap, currentPrice + rec);
    return (<div className="lm-bidbar"><div className="lm-bar-gap"><Icon name="lock" size={16} style={{ color: '#ffce54' }} /><div className="l">已锁第一</div></div><button className="lm-bidcta lead" onClick={() => onBid(recBid)}><span><Icon name="crown" size={16} fill /> 加固至 {fmtYuan(recBid)}</span><span className="sub">建议 +¥{rec} 拉开差距</span></button></div>);
  }
  const behind = myRank != null && myRank >= 2;
  const gapv = myMax != null ? Math.max(0, currentPrice - myMax) : currentPrice;
  const dec = () => setAmt((a) => Math.max(nextMinBid, a - increment));
  const inc = () => setAmt((a) => Math.min(effCap, a + increment));
  return (
    <div className="lm-bidbar">
      {behind && (<div className="lm-bar-gap"><div className="v tnum">{fmtCompactYuan(gapv)}</div><div className="l">距第一名</div></div>)}
      <div className="lm-stepper"><button onClick={dec} aria-label="减"><Icon name="minus" size={18} /></button><span className="val tnum" onClick={onOpenSheet}>{fmtYuan(amt)}</span><button onClick={inc} aria-label="加"><Icon name="plus" size={18} /></button></div>
      <button className={'lm-bidcta' + (behind ? ' second' : '')} onClick={() => onBid(bidAmt)}><span>{behind ? `反超第一 · ${fmtYuan(bidAmt)}` : `立即出价 ${fmtYuan(bidAmt)}`}</span><span className="sub">{staleLow ? `价已涨 · 按最低 ¥${nextMinBid} 出价` : (behind ? `推荐反超 ¥${nextMinBid} 起` : `最低 ¥${nextMinBid} · 点价可多笔`)}</span></button>
    </div>
  );
}
