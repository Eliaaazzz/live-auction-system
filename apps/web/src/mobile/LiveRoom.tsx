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

// ── #261-7 弹幕跨端一致 ──────────────────────────────────────────
// 氛围弹幕不再各端独立 Math.random()（两台手机各演各的），改为按「服务器时钟
// 时间槽」确定性生成：同一个房间、同一个时间槽 → 两台手机算出同一条弹幕。
// 真人评论/礼物/点赞则走服务端 ROOM_SOCIAL 广播，天然一致。
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
  const [pendingBid, setPendingBid] = useState<number | null>(null); // #UIUX 高额出价二次确认
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
  // #261-10 点赞：liked 是本端「我点过没」的开关（可取消），计数走服务端广播。
  const likeKey = 'll_like_' + room.id + (seat ? '_' + seat : '');
  const [liked, setLiked] = useState(() => localStorage.getItem(likeKey) === '1');
  const [likeBurst, setLikeBurst] = useState(0); // 别人点赞时也飘心
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
  // frame — both phones AND late joiners agree). Self rows render as 「我」.
  const onSocial = useCallback((s: SocialItem) => {
    const name = s.self ? '我' : (s.displayName || '观众');
    if (s.kind === 'comment') {
      pushFeed({ kind: 'comment', name, text: s.text || '', color: s.self ? '#fe2c55' : undefined, avatar: s.self ? ident.avatar : undefined });
    } else if (s.kind === 'gift') {
      pushFeed({ kind: 'comment', name, text: `送出 ${s.giftEmoji ?? '🎁'} ${s.giftName ?? '礼物'}`, color: '#ffce54', avatar: s.self ? ident.avatar : undefined });
      if (!s.self) {
        // 对方的礼物也要看得见 (#261-8)：飘大表情 + 音效（自己的那份动画由 GiftPanel 已即时播放）
        const id = giftFloatSeq.current++;
        setGiftFloats((f) => [...f, { id, emoji: s.giftEmoji ?? '🎁', x: (Math.random() - 0.5) * 120 }]);
        setTimeout(() => setGiftFloats((f) => f.filter((x) => x.id !== id)), 1400);
        if (!isMuted()) sfx.gift();
      }
    } else if (s.kind === 'like' && !s.self) {
      setLikeBurst((n) => n + 1); // 对方点赞 → 本端也飘心 (#261-10 广播)
    }
  }, [pushFeed, ident.avatar]);

  const onEvent = useCallback((e: EngineEvent) => {
    switch (e.kind) {
      // #261-6: 领先/被反超/成交配中文语音播报（Web Speech，与音效同一静音开关）
      case 'leading': flashFx('lead', '领先！第 1 名'); if (!isMuted()) { sfx.lead(); speak('恭喜，您已领先'); } screenFlash('gold'); break;
      case 'outbid': flashFx('outbid', '被超越！'); if (!isMuted()) { sfx.outbid(); speak('您已被反超，快加价夺回'); } screenFlash('red'); triggerShake(); break;
      case 'extend': flashFx('extend', `倒计时延长 +${e.addSec}s`); if (!isMuted()) sfx.extend(); pushFeed({ kind: 'enter', text: `结束前有人出价，倒计时自动延长 ${e.addSec}s` }); break;
      case 'cap': pushFeed({ kind: 'enter', text: '触发封顶价，即将成交' }); break;
      case 'start': pushFeed({ kind: 'enter', text: '开拍啦，出价开始！' }); break;
      case 'settle': cancelSpeak(); if (!isMuted() && e.won) speak('恭喜您，竞拍成功'); break;
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

  // #261-7: 氛围弹幕按服务器时钟时间槽确定性生成 — 买家A/买家B 两台设备同一
  // 房间看到完全一致的弹幕流（真人评论/礼物另走服务端广播，天然一致）。
  useEffect(() => {
    if (loading) return;
    let lastSlot = Math.floor(serverNow() / AMBIENT_SLOT_MS); // 进房不补播旧槽
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
  // #261-8: 礼物经服务端广播 — 自己的弹幕行从 echo 渲染（名字显示「我」），
  // 两台手机看到同一条；GiftPanel 自带的飘屏动画保持即时反馈。
  const onSendGift = (g: GiftTier) => { sendSocial({ kind: 'gift', giftId: g.id, giftName: g.name, giftEmoji: g.emoji }); };
  // #261-7: 评论也走服务端广播（echo 渲染，跨端一致）。
  const onSendComment = (t: string) => { sendSocial({ kind: 'comment', text: t }); };
  // #261-10: 点赞可点可取消，计数服务端裁决并广播给所有端。
  const onToggleLike = () => {
    const next = !liked;
    setLiked(next);
    try { localStorage.setItem(likeKey, next ? '1' : '0'); } catch { /* ignore */ }
    sendSocial({ kind: 'like', delta: next ? 1 : -1 });
  };
  // #UIUX 高额二次确认：大额(≥¥10万)出价是有法律约束力的承诺，先弹确认防误触；
  // 低价位拍品(<¥10万)直接提交保持快捷。机器人/精确出价走各自路径，不经此拦截。
  const quickBid = (amount: number) => {
    if (!joined) { setSheetTab('join'); return; }
    if (amount >= 100000) { setPendingBid(amount); return; }
    placeBid(amount);
  };
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
          <LiveHeader room={room} viewers={state.participants} simViewers={state.simViewers} followed={followed} onToggleFollow={toggleFollow} onClose={() => {}} account={<ProfileButton onClick={() => setAcctOpen(true)} avatar={identity?.avatar} />} />
          <div className="lm-rankchip"><Icon name="trophy" size={12} fill /> {room.tagline}</div>
          {/* #UIUX 顶部减负：商品卡 + 倒计时合并成一个右上「拍品状态」竖向 chip 簇，
              不再是两个分散的浮层；倒计时紧贴商品卡读作一体。 */}
          <div className="lm-lotstack">
            <LotChip lot={lot} onOpenIntro={intro ? () => setIntroOpen(true) : undefined} />
            <CountdownPill ms={state.remainingMs} ending={state.status === 'ending'} urgent={urgent} hidden={!live} />
          </div>
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
          <ActionRail likes={state.likes} liked={liked} onToggleLike={onToggleLike} likeBurst={likeBurst} onOpenComments={() => tapTab('comments')} onOpenGift={() => setGiftOpen(true)} onShare={() => setShareOpen(true)} />

          {/* #15 动画位移修复：shake 用 transform，会给后代建立 containing block，
              让底部锚定的 .lm-bidbar(position:absolute;bottom:…) 整条飞出屏幕。改成
              全屏 inset:0 的 shell —— containing block 与视口同尺寸，出价条 bottom 锚点
              不变，shake 只整体平移；pointer-events:none 让空白处点击穿透到下层。 */}
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

          {/* #UIUX 高额出价二次确认弹层：金额大、误触成本高 → 明确金额 + 法律约束力提示 + 确认。 */}
          {pendingBid != null && (
            <div className="lm-confirm-mask" onClick={() => setPendingBid(null)}>
              <div className="lm-confirm" onClick={(e) => e.stopPropagation()}>
                <div className="lm-confirm-hd"><Icon name="gavel" size={18} style={{ color: '#ff8fa3' }} /> 确认出价</div>
                <div className="lm-confirm-amt tnum">{fmtYuan(pendingBid)}</div>
                <div className="lm-confirm-sub">竞拍出价为<b>具有法律约束力</b>的购买承诺，确认后立即提交服务端裁决，落槌即成交。</div>
                <div className="lm-confirm-row">
                  <button className="lm-confirm-cancel" onClick={() => setPendingBid(null)}>取消</button>
                  <button className="lm-confirm-ok" onClick={() => { placeBid(pendingBid); setPendingBid(null); }}>确认出价</button>
                </div>
              </div>
            </div>
          )}

          <StateOverlays state={state} lot={lot} room={room} onReturn={onReturn} reminded={reminded} onToggleRemind={() => setReminded((v) => !v)} />

          <GiftPanel roomId={room.id} open={giftOpen} onClose={() => setGiftOpen(false)} onSend={onSendGift} />
          {/* 对方礼物的飘屏（#261-8 — 自己的那份由 GiftPanel 即时播放） */}
          {giftFloats.map((f) => (<span key={f.id} className="lm-gift-float" style={{ marginLeft: f.x }} aria-hidden>{f.emoji}</span>))}
          <ShareModal roomId={room.id} open={shareOpen} onClose={() => setShareOpen(false)} />
          {/* #261-12b: 商品介绍（AI 识图生成）— 点商品卡打开 */}
          {introOpen && intro && (
            <>
              <div className="lm-sheet-backdrop" onClick={() => setIntroOpen(false)} />
              <div className="lm-introsheet">
                <div className="lm-tabsheet-head">
                  <div className="lm-tabsheet-grip" onClick={() => setIntroOpen(false)} />
                  <span className="lm-tabsheet-title">宝贝介绍</span>
                  <button className="lm-tabsheet-x" onClick={() => setIntroOpen(false)} aria-label="收起"><Icon name="chevronD" size={18} /></button>
                </div>
                <div className="lm-intro-body no-sb">
                  <div className="lm-intro-prod">
                    <ProductImg lot={lot} radius={10} className="lm-intro-img" />
                    <div className="lm-intro-meta">
                      <div className="t">{lot.title}</div>
                      <div className="s">0 元起拍 · 加价 ¥{lot.increment} · {lot.capPrice > 0 ? `封顶 ${fmtCompactYuan(lot.capPrice)}` : '不封顶'}</div>
                    </div>
                  </div>
                  <div className="lm-intro-text">{intro}</div>
                  <div className="lm-intro-ai">✨ AI 识图生成 · 成色与瑕疵以卖家声明为准</div>
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
      <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.9 }}>{ending ? '截拍中' : '距结束'}</span>
      <span key={ending ? s : undefined} className="tnum" style={{ fontWeight: 800 }}>{m}:{s}{ending && <span style={{ opacity: 0.8 }}>:{cs}</span>}</span>
    </div>
  );
}

// #261-3 移动端展示全貌：巨额出价（≥100万）用中文简写（¥2万亿），否则全量数字。
// 反超第一/立即出价 CTA 不再被超长数字撑出手机框。
const fmtBid = (n: number) => (n >= 1_000_000 ? fmtCompactYuan(n) : fmtYuan(n));
const fmtBidNum = (n: number) => (n >= 1_000_000 ? fmtCompact(n) : fmtMoney(n));

function BidActionBar({ ready, joined, live, myRank, currentPrice, myMax, secondPrice, nextMinBid, increment, capPrice, onJoin, onBid, onOpenSheet }: { ready: boolean; joined: boolean; live: boolean; myRank: number | null; currentPrice: number; myMax: number | null; secondPrice: number | null; nextMinBid: number; increment: number; capPrice: number; onJoin: () => void; onBid: (amount: number) => void; onOpenSheet: () => void; }) {
  const [amt, setAmt] = useState(nextMinBid);
  const effCap = capPrice > 0 ? capPrice : Number.MAX_SAFE_INTEGER; // 封顶价 0 = 不封顶
  // #2 不随直播价「自己跳动」：别人出价时保持我设好的数字不变。价格涨过我的数字时
  // 不静默改它，只在点「出价」那一刻按最新最低价钳制提交，并提示「价已涨」。
  // #260-2 例外：用户还没碰过步进器时跟随最新最低价 —— 该 bar 在骨架屏后面就挂载了，
  // 初始 seed 可能是快照未到时的 lot.startPrice 回退值（会偏高，如 ¥5000 vs 真实最低
  // ¥3200），不跟随就会按虚高价提交。「我设好的数字」从第一次点 +/- 才算数。
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setAmt(nextMinBid); }, [nextMinBid]);
  const bidAmt = Math.min(effCap, Math.max(amt, nextMinBid));
  const staleLow = touched.current && amt < nextMinBid;

  // 快照未到位时不给出价入口：此刻的 nextMinBid 只是回退猜测（#260-2 禁用 CTA）。
  if (!ready) {
    return (<div className="lm-bidbar"><button className="lm-bidcta" disabled>正在同步竞拍价…</button></div>);
  }
  if (!joined) {
    return (<div className="lm-bidbar"><button className="lm-bidcta join" onClick={onJoin}><span><Icon name="gavel" size={18} /> 我要参与竞拍</span><span className="sub">同意服务条款后即可出价</span></button></div>);
  }
  if (!live) {
    return (<div className="lm-bidbar"><button className="lm-bidcta" disabled>竞拍已结束</button></div>);
  }
  if (myRank === 1) {
    const rec = increment * 2;
    const recBid = Math.min(effCap, currentPrice + rec);
    // #UIUX 领先态：状态用金色「领先优势 ¥X」（真实领先差额），CTA 改透明交易语言
    // 「加价至 ¥X 保持领先」（不用游戏化的「加固」）。
    const leadMargin = secondPrice != null ? Math.max(0, currentPrice - secondPrice) : 0;
    return (<div className="lm-bidbar"><div className="lm-bar-gap"><div className="v tnum" style={{ color: '#ffce54' }}>{leadMargin > 0 ? fmtBid(leadMargin) : '第 1'}</div><div className="l">{leadMargin > 0 ? '领先优势' : '已锁第一'}</div></div><button className="lm-bidcta lead" onClick={() => onBid(recBid)}><span><Icon name="crown" size={16} fill /> 加价至 {fmtBid(recBid)} 保持领先</span><span className="sub">建议 +¥{fmtBidNum(rec)} 拉开差距</span></button></div>);
  }
  const behind = myRank != null && myRank >= 2;
  const gapv = myMax != null ? Math.max(0, currentPrice - myMax) : currentPrice;
  const dec = () => { touched.current = true; setAmt((a) => Math.max(nextMinBid, a - increment)); };
  const inc = () => { touched.current = true; setAmt((a) => Math.min(effCap, a + increment)); };
  return (
    <div className="lm-bidbar">
      {/* #UIUX 差价用完整数字「¥12,800」（避免与顶部在线「1.28万」混淆），标签「落后第一名」清晰。 */}
      {behind && (<div className="lm-bar-gap"><div className="v tnum">{fmtBid(gapv)}</div><div className="l">落后第一名</div></div>)}
      <div className="lm-stepper"><button onClick={dec} aria-label="减"><Icon name="minus" size={18} /></button><span className="val tnum" onClick={onOpenSheet}>{fmtBid(amt)}</span><button onClick={inc} aria-label="加"><Icon name="plus" size={18} /></button></div>
      {/* #UIUX CTA 是动作、左侧步进器是金额——不再把金额重复进 CTA（消冗余 + 永不溢出）。
          被反超「反超第一名」、首次「立即出价」；金额始终在紧邻步进器里可见可调。 */}
      <button className={'lm-bidcta' + (behind ? ' second' : '')} onClick={() => onBid(bidAmt)}><span>{behind ? '反超第一名' : '立即出价'}</span><span className="sub">{staleLow ? `价已涨 · 最低 ¥${fmtBidNum(nextMinBid)}` : (behind ? '提交即反超当前第一' : '点价可一次加多笔')}</span></button>
    </div>
  );
}
