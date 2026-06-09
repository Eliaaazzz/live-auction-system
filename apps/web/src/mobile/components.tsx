import { useState, useRef } from 'react';
import type { Lot, Room } from '../lib/types';
import { fmtCount } from '../lib/format';
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

export function VideoBackground({ lot }: { lot: Lot }) {
  const [err, setErr] = useState(false);
  return (
    <div className="lm-video" aria-hidden>
      {!err ? (<img className="lm-video-base" src={lot.image.replace(/w=\d+/, 'w=900')} alt="" onError={() => setErr(true)} />) : (<div className="lm-video-base" style={{ background: `linear-gradient(165deg, ${lot.tone} 0%, #0a0a10 80%)` }} />)}
      <div className="lm-video-tint" style={{ background: `radial-gradient(120% 80% at 50% 12%, ${lot.tone2}22, transparent 55%)` }} />
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
export function ActionRail(_props: { cartCount?: number; onOpenComments?: () => void } = {}) {
  const [likes, setLikes] = useState(1284);
  const [liked, setLiked] = useState(false);
  const [floats, setFloats] = useState<Float[]>([]);
  const seq = useRef(0);
  const colors = ['#fe2c55', '#ff8fa3', '#ffce54', '#7fd6ff', '#9bd24e'];
  const burst = (icon: IconName) => {
    const id = seq.current++;
    setFloats((f) => [...f, { id, x: (Math.random() - 0.5) * 26, color: colors[id % colors.length], icon }]);
    setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1000);
  };
  const like = () => { setLikes((n) => n + 1); setLiked(true); burst('heart'); };
  return (
    <div className="lm-rail">
      <button className="lm-rail-btn" onClick={like}>
        <div className="lm-rail-ic" style={{ color: liked ? '#fe2c55' : '#fff', position: 'relative' }}>
          <Icon name="heart" size={23} fill={liked} />
          {floats.map((f) => (<span key={f.id} className="lm-heart-float" style={{ marginLeft: f.x, color: f.color }}><Icon name={f.icon} size={18} fill /></span>))}
        </div>
        <span className="lm-rail-num">{fmtCount(likes)}</span>
      </button>
      <button className="lm-rail-btn" onClick={() => burst('gift')}>
        <div className="lm-rail-ic" style={{ color: '#ffce54' }}><Icon name="gift" size={22} /></div>
        <span className="lm-rail-num">礼物</span>
      </button>
      <button className="lm-rail-btn">
        <div className="lm-rail-ic"><Icon name="share" size={22} /></div>
        <span className="lm-rail-num">分享</span>
      </button>
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
