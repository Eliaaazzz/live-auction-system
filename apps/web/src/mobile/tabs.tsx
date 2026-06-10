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
  { key: 'overview', label: '概览', icon: 'trophy' },
  { key: 'history', label: '历史', icon: 'clock' },
  { key: 'comments', label: '评论', icon: 'comment' },
  { key: 'join', label: '我要参与', icon: 'gavel' },
  { key: 'rules', label: '规则', icon: 'shield' },
];

export function BottomTabs({ active, joined, unread, leadDot, onTap }: { active: TabKey | null; joined: boolean; unread: number; leadDot: boolean; onTap: (t: TabKey) => void; }) {
  return (
    <div className="lm-tabbar">
      {TAB_META.map((t) => {
        const label = t.key === 'join' ? (joined ? '拍卖' : '我要参与') : t.label;
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
  const title = active === 'overview' ? '实时排名' : active === 'history' ? '出价历史' : active === 'comments' ? '评论区' : active === 'join' ? (p.joined ? '出价竞拍' : '参与竞拍') : '竞拍规则';
  return (
    <>
      <div className="lm-sheet-backdrop" onClick={onClose} />
      <div className="lm-tabsheet">
        <div className="lm-tabsheet-head">
          <div className="lm-tabsheet-grip" onClick={onClose} />
          <span className="lm-tabsheet-title">{title}</span>
          <button className="lm-tabsheet-x" onClick={onClose} aria-label="收起"><Icon name="chevronD" size={18} /></button>
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
  return (
    <div>
      <div className="lm-section-t"><Icon name="trophy" size={13} /> 实时排名 · 参与 {state.participants} 人 · 出价 {state.bidCount} 次</div>
      <div className="lm-podium">
        <div className={'lm-rankcard r1' + (first?.self ? ' me' : '')}>
          <div className="lm-rank-badge"><Icon name="crown" size={12} fill /> 第一名 · 领先{first?.self ? ' · 我' : ''}</div>
          <div className="lm-rank-user">{first ? <Avatar src={first.avatar} size={22} /> : <span className="lm-rank-ph" />}<span className="lm-rank-nm">{first ? (first.self ? '我' : first.userName) : '虚位以待'}</span></div>
          <div className="lm-rank-amt tnum">{first ? fmtCompactYuan(first.amount) : fmtYuan(0)}</div>
        </div>
        <div className={'lm-rankcard r2' + (second?.self ? ' me' : '')}>
          <div className="lm-rank-badge">2 · 第二名 · 紧追{second?.self ? ' · 我' : ''}</div>
          <div className="lm-rank-user">{second ? <Avatar src={second.avatar} size={22} /> : <span className="lm-rank-ph" />}<span className="lm-rank-nm">{second ? (second.self ? '我' : second.userName) : '虚位以待'}</span></div>
          <div className="lm-rank-amt tnum">{second ? fmtCompactYuan(second.amount) : '—'}</div>
        </div>
      </div>
      {iLead ? (
        <div className="lm-lead-note"><Icon name="lock" size={14} /> 您当前锁定第 1 名！建议加固防止被反超</div>
      ) : joined && state.myRank != null ? (
        <div className="lm-myrow">
          <div className="left"><span className="lm-myrank-pill">第 {state.myRank} 名</span><div><div style={{ fontSize: 12.5, fontWeight: 700 }}>我的最高出价</div><div className="tnum" style={{ fontSize: 14, fontWeight: 800, color: '#ffce54' }}>{fmtYuan(state.myMaxBid ?? 0)}</div></div></div>
          <div className="lm-gap"><div className="v tnum">{fmtCompactYuan(gap)}</div><div className="l">与第一名差距</div></div>
        </div>
      ) : (
        <div className="lm-myrow" style={{ cursor: 'pointer' }} onClick={() => setActive('join')}>
          <div className="left"><span className="lm-myrank-pill">未上榜</span><div style={{ fontSize: 12.5 }}>点击「我要参与」加入竞拍，争夺第一名</div></div>
          <Icon name="chevronR" size={18} style={{ color: '#ff8fa3' }} />
        </div>
      )}
    </div>
  );
}

function HistoryTab({ state }: { state: AuctionState }) {
  const rows = state.bids.slice(0, 50);
  const now = Date.now();
  const ago = (ts: number) => { const s = Math.max(0, Math.round((now - ts) / 1000)); return s < 60 ? `${s}s前` : `${Math.floor(s / 60)}m前`; };
  return (
    <div>
      <div className="lm-section-t"><Icon name="clock" size={13} /> 出价历史 · 共 {state.bidCount} 次（最近 50 条）</div>
      {rows.length === 0 && <div className="lm-empty">暂无出价，快来抢第一口</div>}
      {/* #261-1 固定高度 + 内置滚动条，列表再长也不会顶开面板 */}
      <div className="lm-hist-list">
        {rows.map((b, i) => (
          <div className={'lm-hist-row' + (b.self ? ' self' : '')} key={b.id}>
            <Avatar src={b.avatar} size={26} />
            <span className="lm-hist-nm">{b.self ? '我' : b.userName}</span>
            {i === 0 && <span className="lm-hist-lead">当前领先</span>}
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
        <input className="lm-input" placeholder="说点什么…" value={text} maxLength={50} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
        <button className="lm-send" onClick={send} aria-label="发送"><Icon name="send" size={18} /></button>
      </div>
    </div>
  );
}

function ParticipateTab({ lot, agreed, onAgree, onJoin }: SheetProps) {
  return (
    <div>
      <div className="lm-join-hd">
        <Icon name="gavel" size={24} style={{ color: '#ff8fa3' }} />
        <div><div style={{ fontSize: 15, fontWeight: 800 }}>参与本场竞拍</div><div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.55)' }}>完成以下步骤即可出价</div></div>
      </div>
      <div className="lm-req"><Icon name="check" size={15} style={{ color: '#2fd6a8' }} /> 实名认证已完成</div>
      <div className="lm-req"><Icon name="check" size={15} style={{ color: '#2fd6a8' }} /> 已绑定支付方式与收货地址</div>
      <div className="lm-req"><Icon name="shield" size={15} style={{ color: '#ffce54' }} /> 缴纳保证金 <b style={{ color: '#ffce54' }}>{fmtYuan(lot.deposit)}</b>（付款后退回 / 未成交解冻）</div>
      <div className="lm-terms">
        <div className={'lm-checkbox' + (agreed ? ' on' : '')} onClick={() => onAgree(!agreed)}>{agreed && <Icon name="check" size={12} stroke={3} />}</div>
        <div>我已阅读并同意 <a>《直播竞拍服务条款》</a> 与 <a>《保证金与履约规则》</a>。竞拍出价为<b style={{ color: '#ff8fa3' }}>具有法律约束力</b>的购买承诺，弃标将扣除保证金。</div>
      </div>
      <button className="lm-cta" disabled={!agreed} style={!agreed ? { opacity: 0.5, boxShadow: 'none' } : undefined} onClick={onJoin}>同意条款并参与 · 冻结保证金 {fmtYuan(lot.deposit)}</button>
    </div>
  );
}

function AuctionTab(p: SheetProps) {
  const { lot, state, nextMinBid, placeBid, autoBidMax, setAutoBidMax, onOpenSheetBid } = p;
  const dynStep = Math.max(lot.increment, computeIncrement(lot.capPrice > 0 ? lot.capPrice : state.currentPrice, state.participants, lot.increment));
  const effCap = lot.capPrice > 0 ? lot.capPrice : Number.MAX_SAFE_INTEGER; // 封顶价 0 = 不封顶
  const [custom, setCustom] = useState('');
  const [autoOn, setAutoOn] = useState(autoBidMax != null);
  const [autoVal, setAutoVal] = useState(String(autoBidMax ?? state.currentPrice + lot.increment * 6));
  const [msg, setMsg] = useState<string | null>(null);
  const ratios = [{ label: '+1档', value: nextMinBid }, { label: '+3档', value: state.currentPrice + dynStep * 3 }, { label: '+5档', value: state.currentPrice + dynStep * 5 }];
  const tryBid = (v: number) => { const r = placeBid(v); setMsg(r.ok ? `已提交出价 ${fmtYuan(v)} · 等待服务端裁决` : r.reason ?? '出价失败'); setTimeout(() => setMsg(null), 1800); };
  const bidCustom = () => { const v = parseInt(custom, 10); if (!Number.isFinite(v)) { setMsg('请输入有效金额'); return; } tryBid(v); setCustom(''); };
  const toggleAuto = () => { const next = !autoOn; setAutoOn(next); setAutoBidMax(next ? parseInt(autoVal, 10) || null : null); };
  return (
    <div>
      <div className="lm-section-t"><Icon name="bolt" size={13} /> 快捷出价 · 当前 <b className="tnum" style={{ color: '#fff' }}>{fmtYuan(state.currentPrice)}</b> · 加价幅度 ¥{dynStep} <span style={{ color: '#ff8fa3' }}>随热度动态</span></div>
      <div className="lm-quickbids">{ratios.map((r) => (<div className="lm-chip" key={r.label} onClick={() => tryBid(Math.min(r.value, effCap))}><div className="x">{r.label}</div><div className="v tnum">{fmtYuan(Math.min(r.value, effCap))}</div></div>))}</div>
      <div className="lm-field">
        <label>自定义出价</label>
        <input className="lm-num tnum" inputMode="numeric" placeholder={`≥ ${nextMinBid}`} value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, ''))} />
        <button className="lm-mini-cta" onClick={bidCustom}>出价</button>
      </div>
      <div className="lm-field">
        <label>自动出价上限</label>
        <input className="lm-num tnum" inputMode="numeric" disabled={!autoOn} value={autoVal} onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, ''); setAutoVal(v); if (autoOn) setAutoBidMax(parseInt(v, 10) || null); }} style={!autoOn ? { opacity: 0.4 } : undefined} />
        <div className={'lm-switch' + (autoOn ? ' on' : '')} onClick={toggleAuto}><i /></div>
      </div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 8 }}>设定你愿意出到的最高价（上限）。出价不会超过此金额，帮你守住预算、理性竞拍。</div>
      <button className="lm-cta ghost" onClick={onOpenSheetBid}>精确出价 / 一次加多笔</button>
      {msg && <div className="lm-warn">{msg}</div>}
    </div>
  );
}

function RulesTab({ lot, online }: { lot: Lot; online: number }) {
  const dynStep = Math.max(lot.increment, computeIncrement(lot.capPrice > 0 ? lot.capPrice : lot.startPrice, online, lot.increment));
  const rules: { ic: IconName; t: string; d: string }[] = [
    { ic: 'tag', t: lot.startPrice === 0 ? '0 元起拍' : `起拍价 ${fmtYuan(lot.startPrice)}`, d: '所有通过认证的用户均可参与出价。' },
    { ic: 'bolt', t: `加价幅度 ¥${dynStep}`, d: `按商品价值与在线人数动态计算，最低 ¥${lot.minIncrement}。` },
    { ic: 'gavel', t: lot.capPrice > 0 ? `封顶价 ${fmtYuan(lot.capPrice)}` : '不封顶（无限加价）', d: lot.capPrice > 0 ? '出价达到封顶价立即成交，竞拍结束。' : '本场不设封顶价，价高者得。' },
    { ic: 'clock', t: `自动延时 ${lot.extendSec}s`, d: `结束前 10 秒内有人出价，倒计时自动延长 ${lot.extendSec} 秒。` },
    { ic: 'shield', t: `保证金 ${fmtYuan(lot.deposit)}`, d: '参与即冻结，成交付款后退回；弃标扣除。' },
    { ic: 'bell', t: '异常取消', d: '主播 / 平台可对异常竞拍随时取消，保证金即时解冻。' },
  ];
  return (
    <div>
      <div className="lm-section-t"><Icon name="shield" size={13} /> 竞拍规则 · {lot.category}</div>
      {rules.map((r, i) => (<div className="lm-rule" key={i}><span className="ic"><Icon name={r.ic} size={17} /></span><div><div className="t">{r.t}</div><div className="d">{r.d}</div></div></div>))}
    </div>
  );
}

export { ME };
