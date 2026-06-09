import { useState, useRef, useEffect } from 'react';
import type { Lot, Room } from '../lib/types';
import { fmtCount } from '../lib/format';
import { sfx, isMuted } from '../lib/sound';
import { Icon, type IconName } from './icons';

export function ProductImg({ lot, radius = 0, className }: { lot: Lot; radius?: number; className?: string }) {
  const [err, setErr] = useState(false);
  if (err) return <div className={className} style={{ background: `linear-gradient(135deg, ${lot.tone2}, ${lot.tone})`, borderRadius: radius }} />;
  return <img className={className} src={lot.image} alt={lot.title} loading="lazy" onError={() => setErr(true)} style={{ borderRadius: radius, objectFit: 'cover' }} />;
}

export function Avatar({ src, size = 28, ring, color }: { src: string; size?: number; ring?: string; color?: string }) {
  const [err, setErr] = useState(false);
  const common: React.CSSProperties = { width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: ring ? `1.5px solid ${ring}` : undefined };
  if (err) return <div style={{ ...common, background: color ?? '#3a3a48' }} />;
  return <img src={src} alt="" loading="lazy" onError={() => setErr(true)} style={common} />;
}

// Real live video: plays lot.live (HLS .m3u8 via hls.js / native, or mp4/webm
// directly) muted+looping as the room backdrop; the SFX layer carries audio.
// Falls back to the still product photo, then a gradient, if no stream / on error.
export function VideoBackground({ lot, liveUrl }: { lot: Lot; liveUrl?: string }) {
  const [vidErr, setVidErr] = useState(false);
  const [imgErr, setImgErr] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const live = liveUrl || lot.live; // real HLS (livePlayUrl) wins over the bundled fallback
  const isHls = !!live && /\.m3u8(\?|$)/i.test(live);
  const useVideo = !!live && !vidErr;
  const bgImg = lot.image.replace(/w=\d+/, 'w=900');

  useEffect(() => {
    setVidErr(false);
    const video = videoRef.current;
    if (!live || !video) return undefined;
    const Hls = (window as unknown as { Hls?: any }).Hls;
    let hls: any;
    if (isHls) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = live; // Safari / iOS native HLS
      } else if (Hls && Hls.isSupported()) {
        hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 3, backBufferLength: 30 });
        hls.loadSource(live);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_e: any, d: any) => { if (d?.fatal) setVidErr(true); });
      } else {
        setVidErr(true); // no MSE/HLS support → still image
        return undefined;
      }
    } else {
      video.src = live; // mp4 / webm
    }
    video.play().catch(() => { /* autoplay blocked until gesture; muted should pass */ });
    return () => { try { hls?.destroy(); } catch { /* noop */ } };
  }, [live, isHls]);

  return (
    <div className="lm-video" aria-hidden>
      {useVideo ? (
        <video ref={videoRef} className="lm-video-base" autoPlay muted loop playsInline poster={bgImg} onError={() => setVidErr(true)} />
      ) : !imgErr ? (
        <img className="lm-video-base" src={bgImg} alt="" onError={() => setImgErr(true)} />
      ) : (
        <div className="lm-video-base" style={{ background: `linear-gradient(165deg, ${lot.tone} 0%, #0a0a10 80%)` }} />
      )}
      {/* 去掉彩色蒙层「背景」，只显示商品本身；仅保留顶/底 scrim 以保证叠加文字可读。 */}
      <div className="lm-scrim-top" /><div className="lm-scrim-bottom" />
    </div>
  );
}

export function LiveHeader({ room, followed, onToggleFollow, onClose }: { room: Room; followed: boolean; onToggleFollow: () => void; onClose: () => void }) {
  return (
    <div className="lm-header">
      <div className="lm-anchor">
        <Avatar src={room.anchorAvatar} size={32} ring="rgba(255,255,255,0.9)" />
        <div className="lm-anchor-meta"><div className="lm-anchor-name">{room.anchorName}</div><div className="lm-anchor-fans">{room.fans}粉丝</div></div>
        <button className={'lm-follow' + (followed ? ' is-followed' : '')} onClick={onToggleFollow}>{followed ? (<><Icon name="check" size={13} stroke={2.6} /> 已关注</>) : ('关注')}</button>
      </div>
      <div className="lm-header-right">
        <div className="lm-viewers">
          <div className="lm-viewer-avs">
            <Avatar src={'https://i.pravatar.cc/40?img=11'} size={20} ring="rgba(0,0,0,0.35)" />
            <Avatar src={'https://i.pravatar.cc/40?img=24'} size={20} ring="rgba(0,0,0,0.35)" />
            <Avatar src={'https://i.pravatar.cc/40?img=36'} size={20} ring="rgba(0,0,0,0.35)" />
          </div>
          <Icon name="eye" size={13} />{fmtCount(room.viewers)}
        </div>
        <button className="lm-close" onClick={onClose} aria-label="关闭"><Icon name="close" size={16} /></button>
      </div>
    </div>
  );
}

export function LotChip({ lot }: { lot: Lot }) {
  return (
    <div className="lm-lotchip">
      <ProductImg lot={lot} radius={8} className="lm-lotchip-img" />
      <div className="lm-lotchip-meta"><div className="lm-lotchip-no">第 {lot.index} 件 · 竞拍中</div><div className="lm-lotchip-title">{lot.title}</div></div>
    </div>
  );
}

interface Float { id: number; x: number; color: string; icon: IconName; }
// NOTE: ll_like_<roomId> (and the lj_join_ / lf_follow_ keys elsewhere) are a
// client-side cache. A future backend likes/follows API will reconcile these —
// the local flag just keeps the optimistic UI sticky across refreshes.
export function ActionRail({ roomId, cartCount: _cartCount, onOpenComments: _onOpenComments, onOpenGift, onShare }: { roomId: string; cartCount?: number; onOpenComments?: () => void; onOpenGift?: () => void; onShare?: () => void } = { roomId: '' }) {
  const likeKey = 'll_like_' + roomId;
  const [liked, setLiked] = useState(() => localStorage.getItem(likeKey) === '1');
  const [likes, setLikes] = useState(() => (localStorage.getItem(likeKey) === '1' ? 1285 : 1284));
  const [floats, setFloats] = useState<Float[]>([]);
  const seq = useRef(0);
  const colors = ['#fe2c55', '#ff8fa3', '#ffce54', '#7fd6ff', '#9bd24e'];
  const burst = (icon: IconName) => {
    const id = seq.current++;
    setFloats((f) => [...f, { id, x: (Math.random() - 0.5) * 26, color: colors[id % colors.length], icon }]);
    setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1000);
  };
  const like = () => {
    if (liked) return; // once per room
    setLikes((n) => n + 1);
    setLiked(true);
    try { localStorage.setItem(likeKey, '1'); } catch { /* ignore */ }
    burst('heart');
  };
  return (
    <div className="lm-rail">
      <button className="lm-rail-btn" onClick={like}>
        <div className="lm-rail-ic" style={{ color: liked ? '#fe2c55' : '#fff', position: 'relative' }}>
          <Icon name="heart" size={23} fill={liked} />
          {floats.map((f) => (<span key={f.id} className="lm-heart-float" style={{ marginLeft: f.x, color: f.color }}><Icon name={f.icon} size={18} fill /></span>))}
        </div>
        <span className="lm-rail-num">{fmtCount(likes)}</span>
      </button>
      <button className="lm-rail-btn" onClick={onOpenGift}>
        <div className="lm-rail-ic" style={{ color: '#ffce54' }}><Icon name="gift" size={22} /></div>
        <span className="lm-rail-num">礼物</span>
      </button>
      <button className="lm-rail-btn" onClick={onShare}>
        <div className="lm-rail-ic"><Icon name="share" size={22} /></div>
        <span className="lm-rail-num">分享</span>
      </button>
    </div>
  );
}

// ---------- Gift panel (Douyin style) ----------
export interface GiftTier { id: string; name: string; emoji: string; coins: number; }
const GIFT_TIERS: GiftTier[] = [
  { id: 'rose', name: '玫瑰', emoji: '🌹', coins: 1 },
  { id: 'like', name: '点赞', emoji: '👍', coins: 5 },
  { id: 'beer', name: '啤酒', emoji: '🍺', coins: 10 },
  { id: 'mic', name: '麦克风', emoji: '🎤', coins: 33 },
  { id: 'star', name: '星空', emoji: '🌌', coins: 66 },
  { id: 'car', name: '跑车', emoji: '🏎️', coins: 520 },
  { id: 'rocket', name: '火箭', emoji: '🚀', coins: 1314 },
  { id: 'crown', name: '皇冠', emoji: '👑', coins: 3344 },
  { id: 'diamond', name: '守护钻', emoji: '💎', coins: 6666 },
];

interface GiftFloat { id: number; emoji: string; x: number; }
export function GiftPanel({ roomId, open, onClose, onSend }: { roomId: string; open: boolean; onClose: () => void; onSend: (g: GiftTier) => void }) {
  const storeKey = 'lg_gift_' + roomId;
  const [selId, setSelId] = useState<string>(() => localStorage.getItem(storeKey) || GIFT_TIERS[0].id);
  const [floats, setFloats] = useState<GiftFloat[]>([]);
  const seq = useRef(0);
  // restore highlight whenever the panel re-opens
  useEffect(() => { if (open) setSelId(localStorage.getItem(storeKey) || GIFT_TIERS[0].id); }, [open, storeKey]);
  if (!open) return null;
  const selected = GIFT_TIERS.find((g) => g.id === selId) ?? GIFT_TIERS[0];
  const select = (g: GiftTier) => { setSelId(g.id); try { localStorage.setItem(storeKey, g.id); } catch { /* ignore */ } };
  const send = () => {
    const id = seq.current++;
    setFloats((f) => [...f, { id, emoji: selected.emoji, x: (Math.random() - 0.5) * 120 }]);
    setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1400);
    if (!isMuted()) sfx.gift();
    onSend(selected); // keep open for combos
  };
  return (
    <>
      <div className="lm-sheet-backdrop" onClick={onClose} />
      <div className="lm-giftsheet">
        <div className="lm-tabsheet-head">
          <div className="lm-tabsheet-grip" onClick={onClose} />
          <span className="lm-tabsheet-title">送礼物</span>
          <button className="lm-tabsheet-x" onClick={onClose} aria-label="收起"><Icon name="chevronD" size={18} /></button>
        </div>
        <div className="lm-gift-grid">
          {GIFT_TIERS.map((g) => (
            <button key={g.id} className={'lm-gift-card' + (g.id === selId ? ' on' : '')} onClick={() => select(g)}>
              <span className="em" aria-hidden>{g.emoji}</span>
              <span className="nm">{g.name}</span>
              <span className="co">🪙 {g.coins}</span>
            </button>
          ))}
        </div>
        <button className="lm-gift-send" onClick={send}>
          赠送 {selected.emoji} {selected.name} · 🪙 {selected.coins}
        </button>
      </div>
      {floats.map((f) => (<span key={f.id} className="lm-gift-float" style={{ marginLeft: f.x }} aria-hidden>{f.emoji}</span>))}
    </>
  );
}

// ---------- Share modal (copy link) ----------
export function ShareModal({ roomId, open, onClose }: { roomId: string; open: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  if (!open) return null;
  const url = location.origin + location.pathname + '#/m?room=' + roomId;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      const el = inputRef.current;
      if (el) { el.select(); try { document.execCommand('copy'); setCopied(true); } catch { /* ignore */ } }
    }
    setTimeout(() => setCopied(false), 2200);
  };
  return (
    <div className="lm-share-mask" onClick={onClose}>
      <div className="lm-share-card" onClick={(e) => e.stopPropagation()}>
        <div className="lm-share-hd"><Icon name="share" size={18} style={{ color: '#ff8fa3' }} /> 分享直播间</div>
        <input ref={inputRef} className="lm-share-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button className="lm-share-copy" onClick={copy}>{copied ? '已复制，可粘贴发给好友' : '复制链接'}</button>
        <div className="lm-share-hint">朋友打开链接即可免登录观看 / 出价 / 查看订单</div>
      </div>
    </div>
  );
}

export interface DanmakuItem { id: number; kind: 'comment' | 'enter' | 'bid'; name?: string; text: string; color?: string; avatar?: string; }
export function Danmaku({ items }: { items: DanmakuItem[] }) {
  return (
    <div className="lm-danmaku no-sb">
      {items.map((it) => (
        <div key={it.id} className={'lm-dm ' + it.kind}>
          {it.kind === 'enter' ? (<span>{it.text}</span>) : (<>{it.avatar && <Avatar src={it.avatar} size={18} />}{it.name && <span className="nm" style={it.color ? { color: it.color } : undefined}>{it.name}</span>}{it.text}</>)}
        </div>
      ))}
    </div>
  );
}

export interface FxToken { id: number; type: 'lead' | 'outbid' | 'extend'; text: string; }
export function EmotionFX({ fx }: { fx: FxToken | null }) {
  if (!fx) return null;
  const icon: IconName = fx.type === 'lead' ? 'crown' : fx.type === 'outbid' ? 'bolt' : 'clock';
  return (<div key={fx.id} className={'lm-fx ' + fx.type}><Icon name={icon} size={18} fill={fx.type === 'lead'} /> {fx.text}</div>);
}

export function SwipeHint() { return (<div className="lm-swipe-hint"><Icon name="chevronD" size={18} /><span>上滑切换下一个直播间</span></div>); }

export function Confetti({ count = 40 }: { count?: number }) {
  const colors = ['#fe2c55', '#ffce54', '#7fd6ff', '#9bd24e', '#ff8fa3', '#fff'];
  return (<>{Array.from({ length: count }).map((_, i) => (<span key={i} className="lm-confetti" style={{ left: `${Math.random() * 100}%`, background: colors[i % colors.length], animationDuration: `${1.4 + Math.random() * 1.4}s`, animationDelay: `${Math.random() * 0.5}s` }} />))}</>);
}

export function RoomSkeleton() {
  return (
    <div className="lm-skel">
      <div className="la-skeleton" style={{ width: 150, height: 38, borderRadius: 999, marginBottom: 18 }} />
      <div className="la-skeleton bar" style={{ width: '70%' }} />
      <div className="la-skeleton bar" style={{ width: '52%' }} />
      <div style={{ position: 'absolute', right: 14, top: 200, display: 'flex', flexDirection: 'column', gap: 16 }}>{[0, 1, 2, 3].map((i) => (<div key={i} className="la-skeleton" style={{ width: 44, height: 44, borderRadius: 999 }} />))}</div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 64, padding: 14 }}><div className="la-skeleton" style={{ height: 52, borderRadius: 14, marginBottom: 10 }} /><div className="la-skeleton" style={{ height: 46, borderRadius: 12 }} /></div>
    </div>
  );
}
