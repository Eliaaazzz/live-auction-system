import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineEvent, Room, SocialItem } from '../lib/types';
import { useAuctionEngine } from '../lib/useAuctionEngine';
import { COMMENT_POOL, ENTER_POOL, BOT_USERS } from '../lib/mockData';
import { fmtYuan, fmtCompactYuan, fmtCompact, fmtMoney, splitClock } from '../lib/format';
import { computeIncrement } from '../lib/pricing';
import { sfx, isMuted, setMuted, unlockAudio, speak, cancelSpeak } from '../lib/sound';
import { serverNow } from '../backend/lib/clock.js';
import { VideoBackground, LiveHeader, LotChip, ActionRail, Danmaku, EmotionFX, RoomSkeleton, GiftPanel, ShareModal, ProductImg, type DanmakuItem, type FxToken, type GiftTier } from './components';
import { BottomTabs, TabSheet, type TabKey, type CommentItem } from './tabs';
import { BidSheet } from './BidSheet';
import { StateOverlays } from './overlays';
import { Icon } from './icons';
import { ProfileButton, AccountSheet } from './account';
import { useIdentity, type SeatIdentity } from '../lib/identity';
import './motion.css';

// ── #261-7 danmaku consistency across clients ────────────────────
// Ambient danmaku no longer uses an independent Math.random() per client (which made two phones
// play their own show); it is generated deterministically from a server-clock time slot, so the
// same room and the same slot produce the same line on both phones.
// Real comments/gifts/likes go through the server ROOM_SOCIAL broadcast and are consistent by nature.
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const AMBIENT_SLOT_MS = 3200;
function ambientForSlot(roomId: string, slot: number): { kind: 'enter' | 'comment'; name?: string; text: string; color?: string; avatar?: string } | null {
  const rnd = mulberry32(hashStr(roomId) ^ slot);
  if (rnd() < 0.34) return null; // quiet slot — keep the rhythm organic
  if (rnd() < 0.3) return { kind: 'enter', text: ENTER_POOL[Math.floor(rnd() * ENTER_POOL.length)] };
  const u = BOT_USERS[Math.floor(rnd() * BOT_USERS.length)];
  return { kind: 'comment', name: u.name, text: COMMENT_POOL[Math.floor(rnd() * COMMENT_POOL.length)], color: u.color, avatar: u.avatar };
}

interface Props { room: Room; seedToPrice?: number; startDelaySec?: number; running?: boolean; onEnded?: () => void; onExit?: () => void; seat?: string; identity?: SeatIdentity; }

export default function LiveRoom({ room, seedToPrice, startDelaySec = 0, running = true, onEnded, onExit, seat = '', identity }: Props) {
  const lot = room.lot;
  // Showcase seats (buyer A / buyer B) pass an explicit per-seat identity; real /m uses
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
  const [pendingBid, setPendingBid] = useState<number | null>(null); // #UIUX second confirmation for large bids
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
  const [introOpen, setIntroOpen] = useState(false);
  // #261-10 likes: `liked` is this client's own "have I liked it" toggle (undoable); the count comes from the server broadcast.
  const likeKey = 'll_like_' + room.id + (seat ? '_' + seat : '');
  const [liked, setLiked] = useState(() => localStorage.getItem(likeKey) === '1');
  const [likeBurst, setLikeBurst] = useState(0); // float a heart when someone else likes too
  const [giftFloats, setGiftFloats] = useState<{ id: number; emoji: string; x: number }[]>([]);
  const giftFloatSeq = useRef(0);

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

  // #261-7/8/10: render a ROOM_SOCIAL broadcast (every client gets the same
  // frame — both phones AND late joiners agree). Self rows render as "Me".
  const onSocial = useCallback((s: SocialItem) => {
    const name = s.self ? 'Me' : (s.displayName || 'Viewer');
    if (s.kind === 'comment') {
      pushFeed({ kind: 'comment', name, text: s.text || '', color: s.self ? '#fe2c55' : undefined, avatar: s.self ? ident.avatar : undefined });
    } else if (s.kind === 'gift') {
      pushFeed({ kind: 'comment', name, text: `sent ${s.giftEmoji ?? '🎁'} ${s.giftName ?? 'a gift'}`, color: '#ffce54', avatar: s.self ? ident.avatar : undefined });
      if (!s.self) {
        // Other people's gifts must be visible too (#261-8): a big floating emoji plus a sound (GiftPanel already plays your own animation instantly)
        const id = giftFloatSeq.current++;
        setGiftFloats((f) => [...f, { id, emoji: s.giftEmoji ?? '🎁', x: (Math.random() - 0.5) * 120 }]);
        setTimeout(() => setGiftFloats((f) => f.filter((x) => x.id !== id)), 1400);
        if (!isMuted()) sfx.gift();
      }
    } else if (s.kind === 'like' && !s.self) {
      setLikeBurst((n) => n + 1); // someone else liked -> float a heart here too (#261-10 broadcast)
    }
  }, [pushFeed, ident.avatar]);

  const onEvent = useCallback((e: EngineEvent) => {
    switch (e.kind) {
      // #261-6: spoken announcements for taking the lead / being outbid / a sale (Web Speech, sharing the mute switch with the sound effects)
      case 'leading': flashFx('lead', 'In the lead - 1st'); if (!isMuted()) { sfx.lead(); speak('Nice, you are in the lead'); } screenFlash('gold'); break;
      case 'outbid': flashFx('outbid', 'Outbid!'); if (!isMuted()) { sfx.outbid(); speak('You have been outbid - raise your bid to take it back'); } screenFlash('red'); triggerShake(); break;
      case 'extend': flashFx('extend', `Countdown extended +${e.addSec}s`); if (!isMuted()) sfx.extend(); pushFeed({ kind: 'enter', text: `Someone bid near the end, so the countdown extended by ${e.addSec}s` }); break;
      case 'cap': pushFeed({ kind: 'enter', text: 'Cap price hit - closing now' }); break;
      case 'start': pushFeed({ kind: 'enter', text: 'The auction is open - start bidding!' }); break;
      case 'settle': cancelSpeak(); if (!isMuted() && e.won) speak('Congratulations, you won the auction'); break;
      case 'social': onSocial(e.social); break;
      default: break;
    }
  }, [flashFx, pushFeed, screenFlash, triggerShake, onSocial]);

  // Boot the engine immediately (not gated on !loading) so this room's snapshot
  // starts loading the moment it mounts — the skeleton then clears on `ready`, not
  // a blind timer, so a swipe reveals live data as soon as it lands.
  const { state, nextMinBid, placeBid, setAutoBidMax, autoBidMax, restart, livePlayUrl, intro, ready, sendSocial, auctioneerText } = useAuctionEngine(lot, { seedToPrice, startDelaySec, running, onEvent, nickname: ident.nickname || undefined, seat, selfAvatar: ident.avatar || undefined });

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

  // #261-7: ambient danmaku is generated deterministically from a server-clock time slot, so buyer A
  // and buyer B see exactly the same stream in the same room (real comments/gifts go through the
  // server broadcast and are consistent by nature).
  useEffect(() => {
    if (loading) return;
    let lastSlot = Math.floor(serverNow() / AMBIENT_SLOT_MS); // do not replay old slots on join
    const t = setInterval(() => {
      const slot = Math.floor(serverNow() / AMBIENT_SLOT_MS);
      if (slot === lastSlot) return;
      lastSlot = slot;
      const item = ambientForSlot(room.id, slot);
      if (item) pushFeed(item);
    }, 700);
    return () => clearInterval(t);
  }, [loading, room.id, pushFeed]);

  const lastBidId = useRef<string | null>(null);
  useEffect(() => {
    const top = state.bids[0];
    if (!top || top.id === lastBidId.current) return;
    lastBidId.current = top.id;
    pushFeed({ kind: 'bid', name: top.self ? 'Me' : top.userName, text: `bid ${fmtYuan(top.amount)}`, color: top.color, avatar: top.avatar });
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
  const comments: CommentItem[] = useMemo(() => feed.filter((f) => f.kind !== 'enter').slice(-40).map((f) => ({ id: f.id, name: f.name ?? 'Viewer', text: f.text, color: f.color, self: f.name === 'Me', avatar: f.avatar })), [feed]);

  const unlockOnce = useCallback(() => { if (unlocked.current) return; unlocked.current = true; unlockAudio(); }, []);
  const toggleSound = () => { setSoundOn((v) => { const nv = !v; setMuted(!nv); if (nv) { unlockAudio(); sfx.tick(); } return nv; }); };
  const toggleFollow = () => setFollowed((v) => { const nv = !v; localStorage.setItem('lf_follow_' + room.id, nv ? '1' : '0'); return nv; });
  const tapTab = (t: TabKey) => { setSheetTab((cur) => (cur === t ? null : t)); if (t === 'comments') setUnread(0); };
  const onJoin = () => { setJoined(true); try { localStorage.setItem('lj_join_' + room.id, '1'); } catch { /* ignore */ } pushFeed({ kind: 'enter', text: 'Me joined the auction - deposit held successfully' }); };
  // #261-8: gifts go through the server broadcast - your own danmaku row renders from the echo (shown
  // as "Me"), so both phones see the same line; GiftPanel's own floating animation keeps the instant feedback.
  const onSendGift = (g: GiftTier) => { sendSocial({ kind: 'gift', giftId: g.id, giftName: g.name, giftEmoji: g.emoji }); };
  // #261-7: comments go through the server broadcast too (rendered from the echo, consistent across clients).
  const onSendComment = (t: string) => { sendSocial({ kind: 'comment', text: t }); };
  // #261-10: likes can be toggled on and off; the count is adjudicated server-side and broadcast to every client.
  const onToggleLike = () => {
    const next = !liked;
    setLiked(next);
    try { localStorage.setItem(likeKey, next ? '1' : '0'); } catch { /* ignore */ }
    sendSocial({ kind: 'like', delta: next ? 1 : -1 });
  };
  // #UIUX second confirmation for large bids: a bid of 100,000 or more is a legally binding commitment,
  // so confirm first to prevent mistaps; smaller lots (under 100,000) submit directly and stay quick.
  // Bot and exact-amount bids take their own paths and are not intercepted here.
  const quickBid = (amount: number) => {
    if (!joined) { setSheetTab('join'); return; }
    if (amount >= 100000) { setPendingBid(amount); return; }
    placeBid(amount);
  };
  // Called by the overlay's 5s timer after a no-bid or hammer: with several sessions it advances to the
  // next lot automatically (BuyerRail.advance, the same as swiping up to the next room); with a single
  // session it stays put and re-syncs. The onEnded handle is stable so the overlay timer effect fires only once.
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
          <LiveHeader room={room} viewers={state.participants} simViewers={state.simViewers} followed={followed} onToggleFollow={toggleFollow} onClose={onExit ?? (() => {})} account={<ProfileButton onClick={() => setAcctOpen(true)} avatar={identity?.avatar} />} />
          <div className="lm-rankchip"><Icon name="trophy" size={12} fill /> {room.tagline}</div>
          {/* #UIUX lighter top bar: the lot card and the countdown merge into one vertical "lot status" chip
              cluster in the top right instead of two separate floating layers, so the countdown reads as part of the card. */}
          <div className="lm-lotstack">
            <LotChip lot={lot} onOpenIntro={intro ? () => setIntroOpen(true) : undefined} />
            <CountdownPill ms={state.remainingMs} ending={state.status === 'ending'} urgent={urgent} hidden={!live} />
          </div>
          {auctioneerText && <div className="lm-aibubble"><span className="dot" /> AI host - {auctioneerText}</div>}

          <button className={'lm-sound-btn' + (soundOn ? '' : ' off')} onClick={toggleSound} aria-label={soundOn ? 'Mute sound' : 'Unmute sound'}>
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
          <ActionRail likes={state.likes} liked={liked} onToggleLike={onToggleLike} likeBurst={likeBurst} onOpenComments={() => tapTab('comments')} onOpenGift={() => setGiftOpen(true)} onShare={() => setShareOpen(true)} />

          {/* #15 animation-offset fix: shake uses transform, which creates a containing block for descendants
              and sent the bottom-anchored .lm-bidbar (position:absolute;bottom:...) flying off screen.
              It is now a full-screen inset:0 shell, so the containing block matches the viewport, the bid
              bar's bottom anchor is unchanged, and shake only translates the whole thing;
              pointer-events:none lets taps on empty space fall through to the layer below. */}
          <div className={'lm-bidbar-shell' + (shake ? ' lm-shake' : '')}>
            <BidActionBar ready={ready} joined={joined} live={live} myRank={state.myRank} currentPrice={state.currentPrice} myMax={state.myMaxBid} secondPrice={state.ranking?.[1]?.amount ?? null} nextMinBid={nextMinBid} increment={dynStep} capPrice={lot.capPrice} onJoin={() => setSheetTab('join')} onBid={quickBid} onOpenSheet={() => setBidSheetOpen(true)} />
          </div>

          <BottomTabs active={sheetTab} joined={joined} unread={unread} leadDot={joined && state.myRank === 1} onTap={tapTab} />

          <TabSheet active={sheetTab} onClose={() => setSheetTab(null)} state={state} lot={lot} joined={joined} agreed={agreed} onAgree={setAgreed} onJoin={onJoin} placeBid={placeBid} nextMinBid={nextMinBid} autoBidMax={autoBidMax} setAutoBidMax={setAutoBidMax} comments={comments} onSendComment={onSendComment} onOpenSheetBid={() => setBidSheetOpen(true)} setActive={setSheetTab} />

          <EmotionFX fx={fx} />

          {/* #260-2: gate the sheet on `ready` — opened pre-snapshot it would seed its
              amount stepper from the lot.startPrice fallback instead of the live min. */}
          {bidSheetOpen && ready && (
            <BidSheet lot={lot} state={state} nextMinBid={nextMinBid} onClose={() => setBidSheetOpen(false)} onConfirm={(amt) => { if (!joined) { setBidSheetOpen(false); setSheetTab('join'); return; } placeBid(amt); setBidSheetOpen(false); }} />
          )}

          {/* #UIUX large-bid confirmation sheet: the amount is big and a mistap is costly, so show the exact amount, the binding-commitment notice, and a confirm step. */}
          {pendingBid != null && (
            <div className="lm-confirm-mask" onClick={() => setPendingBid(null)}>
              <div className="lm-confirm" onClick={(e) => e.stopPropagation()}>
                <div className="lm-confirm-hd"><Icon name="gavel" size={18} style={{ color: '#ff8fa3' }} /> Confirm bid</div>
                <div className="lm-confirm-amt tnum">{fmtYuan(pendingBid)}</div>
                <div className="lm-confirm-sub">An auction bid is a <b>legally binding</b> commitment to buy. Once confirmed it goes straight to server-side adjudication, and the hammer closes the sale.</div>
                <div className="lm-confirm-row">
                  <button className="lm-confirm-cancel" onClick={() => setPendingBid(null)}>Cancel</button>
                  <button className="lm-confirm-ok" onClick={() => { placeBid(pendingBid); setPendingBid(null); }}>Confirm bid</button>
                </div>
              </div>
            </div>
          )}

          {/* canContinue = there are other live sessions (onEnded is only injected when there are several);
              autoAdvanceMs is injected only by the showcase seat, so the three-screen demo scrolls on
              automatically; the real /m shows a terminal screen and waits for the user to exit or browse other sessions. */}
          <StateOverlays state={state} lot={lot} room={room} onReturn={onReturn} onExit={onExit} canContinue={!!onEnded} autoAdvanceMs={seat ? 6500 : undefined} reminded={reminded} onToggleRemind={() => setReminded((v) => !v)} />

          <GiftPanel roomId={room.id} open={giftOpen} onClose={() => setGiftOpen(false)} onSend={onSendGift} />
          {/* Floating overlay for other people's gifts (#261-8 - your own is played instantly by GiftPanel) */}
          {giftFloats.map((f) => (<span key={f.id} className="lm-gift-float" style={{ marginLeft: f.x }} aria-hidden>{f.emoji}</span>))}
          <ShareModal roomId={room.id} open={shareOpen} onClose={() => setShareOpen(false)} />
          {/* #261-12b: the product description (AI-generated from the photo) - tap the lot card to open */}
          {introOpen && intro && (
            <>
              <div className="lm-sheet-backdrop" onClick={() => setIntroOpen(false)} />
              <div className="lm-introsheet">
                <div className="lm-tabsheet-head">
                  <div className="lm-tabsheet-grip" onClick={() => setIntroOpen(false)} />
                  <span className="lm-tabsheet-title">About this item</span>
                  <button className="lm-tabsheet-x" onClick={() => setIntroOpen(false)} aria-label="Collapse"><Icon name="chevronD" size={18} /></button>
                </div>
                <div className="lm-intro-body no-sb">
                  <div className="lm-intro-prod">
                    <ProductImg lot={lot} radius={10} className="lm-intro-img" />
                    <div className="lm-intro-meta">
                      <div className="t">{lot.title}</div>
                      <div className="s">Starts at zero - increment ¥{lot.increment} - {lot.capPrice > 0 ? `cap ${fmtCompactYuan(lot.capPrice)}` : 'no cap'}</div>
                    </div>
                  </div>
                  <div className="lm-intro-text">{intro}</div>
                  <div className="lm-intro-ai">✨ Generated by AI from the photo - condition and flaws are per the seller's statement</div>
                </div>
              </div>
            </>
          )}
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
      <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.9 }}>{ending ? 'Closing' : 'Ends in'}</span>
      <span key={ending ? s : undefined} className="tnum" style={{ fontWeight: 800 }}>{m}:{s}{ending && <span style={{ opacity: 0.8 }}>:{cs}</span>}</span>
    </div>
  );
}

// #261-3 mobile shows the whole picture: huge bids (1,000,000 and up) use a compact form, otherwise the
// full number. The retake-the-lead / bid-now CTA no longer gets pushed off screen by an over-long number.
const fmtBid = (n: number) => (n >= 1_000_000 ? fmtCompactYuan(n) : fmtYuan(n));
const fmtBidNum = (n: number) => (n >= 1_000_000 ? fmtCompact(n) : fmtMoney(n));

function BidActionBar({ ready, joined, live, myRank, currentPrice, myMax, secondPrice, nextMinBid, increment, capPrice, onJoin, onBid, onOpenSheet }: { ready: boolean; joined: boolean; live: boolean; myRank: number | null; currentPrice: number; myMax: number | null; secondPrice: number | null; nextMinBid: number; increment: number; capPrice: number; onJoin: () => void; onBid: (amount: number) => void; onOpenSheet: () => void; }) {
  const [amt, setAmt] = useState(nextMinBid);
  const effCap = capPrice > 0 ? capPrice : Number.MAX_SAFE_INTEGER; // a cap price of 0 means no cap
  // #2 do not jump around with the live price: while others bid, the number I set stays put. When the
  // price passes my number we do not silently change it - we clamp to the latest minimum only at the
  // moment "bid" is tapped, and show a "the price went up" hint.
  // #260-2 exception: before the user has touched the stepper we do follow the latest minimum. The bar
  // mounts behind the skeleton screen, so the initial seed may be the pre-snapshot lot.startPrice
  // fallback (which runs high, e.g. 5000 vs a real minimum of 3200); without following it we would
  // submit at an inflated price. "The number I set" only counts from the first +/- tap.
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setAmt(nextMinBid); }, [nextMinBid]);
  const bidAmt = Math.min(effCap, Math.max(amt, nextMinBid));
  const staleLow = touched.current && amt < nextMinBid;

  // No bid entry until the snapshot arrives: nextMinBid is only a fallback guess right now (#260-2 disables the CTA).
  if (!ready) {
    return (<div className="lm-bidbar"><button className="lm-bidcta" disabled>Syncing the auction price...</button></div>);
  }
  if (!joined) {
    return (<div className="lm-bidbar"><button className="lm-bidcta join" onClick={onJoin}><span><Icon name="gavel" size={18} /> Join this auction</span><span className="sub">Accept the terms of service to start bidding</span></button></div>);
  }
  if (!live) {
    return (<div className="lm-bidbar"><button className="lm-bidcta" disabled>Auction ended</button></div>);
  }
  if (myRank === 1) {
    const rec = increment * 2;
    const recBid = Math.min(effCap, currentPrice + rec);
    // #UIUX leading state: the status shows a gold "lead margin ¥X" (the real gap), and the CTA uses
    // plain transactional wording, "raise to ¥X to stay ahead", rather than gamified language.
    const leadMargin = secondPrice != null ? Math.max(0, currentPrice - secondPrice) : 0;
    return (<div className="lm-bidbar"><div className="lm-bar-gap"><div className="v tnum" style={{ color: '#ffce54' }}>{leadMargin > 0 ? fmtBid(leadMargin) : '1st'}</div><div className="l">{leadMargin > 0 ? 'Lead margin' : 'Holding 1st'}</div></div><button className="lm-bidcta lead" onClick={() => onBid(recBid)}><span><Icon name="crown" size={16} fill /> Raise to {fmtBid(recBid)} to stay ahead</span><span className="sub">Suggested +¥{fmtBidNum(rec)} to widen the gap</span></button></div>);
  }
  const behind = myRank != null && myRank >= 2;
  const gapv = myMax != null ? Math.max(0, currentPrice - myMax) : currentPrice;
  const dec = () => { touched.current = true; setAmt((a) => Math.max(nextMinBid, a - increment)); };
  const inc = () => { touched.current = true; setAmt((a) => Math.min(effCap, a + increment)); };
  return (
    <div className="lm-bidbar">
      {/* #UIUX the gap uses the full number (e.g. ¥12,800) so it is not confused with the compact viewer count at the top, and the label "behind 1st" is unambiguous. */}
      {behind && (<div className="lm-bar-gap"><div className="v tnum">{fmtBid(gapv)}</div><div className="l">Behind 1st</div></div>)}
      <div className="lm-stepper"><button onClick={dec} aria-label="Decrease"><Icon name="minus" size={18} /></button><span className="val tnum" onClick={onOpenSheet}>{fmtBid(amt)}</span><button onClick={inc} aria-label="Increase"><Icon name="plus" size={18} /></button></div>
      {/* #UIUX the CTA is the action and the stepper on the left is the amount - the amount is no longer
          repeated in the CTA (less redundancy, never overflows). When outbid it reads "retake 1st", and on
          the first bid "bid now"; the amount stays visible and adjustable in the adjacent stepper. */}
      <button className={'lm-bidcta' + (behind ? ' second' : '')} onClick={() => onBid(bidAmt)}><span>{behind ? 'Retake 1st' : 'Bid now'}</span><span className="sub">{staleLow ? `Price went up - minimum ¥${fmtBidNum(nextMinBid)}` : (behind ? 'Submitting takes the lead' : 'Tap the amount to raise several steps at once')}</span></button>
    </div>
  );
}
