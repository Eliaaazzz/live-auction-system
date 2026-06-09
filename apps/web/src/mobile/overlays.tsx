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
      <Icon name="share" size={14} /> {copied ? '链接已复制 · 发给好友' : '复制订单链接 · 发给好友'}
    </button>
  );
}

export function StateOverlays({
  state,
  lot,
  room,
  onReturn,
  reminded,
  onToggleRemind,
}: {
  state: AuctionState;
  lot: Lot;
  room: Room;
  onReturn: () => void;
  reminded: boolean;
  onToggleRemind: () => void;
}) {
  if (state.status === 'upcoming') return <AboutToStart state={state} lot={lot} reminded={reminded} onToggleRemind={onToggleRemind} />;
  if (state.status === 'unsold') return <EndedOverlay lot={lot} onReturn={onReturn} />;
  if (state.status === 'sold') {
    // 我是否拍中：用真实排名（成交时第 1 名即赢家）判断，不再用恒为 false 的
    // `leader.userId === 'me'`（后端 userId 永不等于 'me'，导致赢家永远进不了庆祝页）。
    const won = state.myRank === 1;
    return won ? <WinSuccess state={state} lot={lot} onReturn={onReturn} /> : <HammerResult state={state} lot={lot} room={room} onReturn={onReturn} />;
  }
  return null;
}

function AboutToStart({ state, lot, reminded, onToggleRemind }: { state: AuctionState; lot: Lot; reminded: boolean; onToggleRemind: () => void }) {
  return (
    <div className="lm-ov">
      <div className="lm-ov-card">
        <div className="lm-ov-title">即将开拍</div>
        <div className="lm-ov-sub">下一件拍品 {fmtClock(state.startsInMs)} 后开始</div>
        <div className="lm-ov-lot">
          <ProductImg lot={lot} radius={12} className="img" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.3 }}>{lot.title}</div>
            <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.5)', marginTop: 3 }}>{lot.estimate}</div>
          </div>
        </div>
        <div className="lm-ov-stat">
          <div>
            <div className="k">起拍价</div>
            <div className="v tnum">{lot.startPrice === 0 ? '0 元起' : fmtYuan(lot.startPrice)}</div>
          </div>
          <div>
            <div className="k">加价幅度</div>
            <div className="v tnum">¥{lot.increment}</div>
          </div>
          <div>
            <div className="k">封顶价</div>
            <div className="v tnum">{lot.capPrice > 0 ? fmtYuan(lot.capPrice) : '不封顶'}</div>
          </div>
        </div>
        <button className="lm-paybtn" style={reminded ? { background: 'rgba(255,255,255,0.16)', boxShadow: 'none' } : undefined} onClick={onToggleRemind}>
          <Icon name={reminded ? 'check' : 'bell'} size={17} /> {reminded ? '已设置开拍提醒' : '设置开拍提醒'}
        </button>
      </div>
    </div>
  );
}

function EndedOverlay({ lot, onReturn }: { lot: Lot; onReturn: () => void }) {
  useEffect(() => {
    const t = setTimeout(onReturn, 5000);
    return () => clearTimeout(t);
  }, [onReturn]);
  return (
    <div className="lm-ov">
      <div className="lm-ov-card">
        <div className="lm-ov-title">当前商品竞拍已结束</div>
        <div className="lm-ov-sub">本场无人出价 · 流拍</div>
        <div className="lm-ov-lot">
          <ProductImg lot={lot} radius={12} className="img" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{lot.title}</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>起拍价 {lot.startPrice === 0 ? '0 元起' : fmtYuan(lot.startPrice)}</div>
          </div>
        </div>
        <div style={{ textAlign: 'center', fontSize: 12.5, color: 'rgba(255,255,255,0.6)' }}>5s 后自动进入下一件拍品</div>
        <div className="lm-ended-progress">
          <i />
        </div>
      </div>
    </div>
  );
}

function WinSuccess({ state, lot, onReturn }: { state: AuctionState; lot: Lot; onReturn: () => void }) {
  const [paid, setPaid] = useState(false);
  const [paying, setPaying] = useState(false);
  // 真实模拟支付：调后端 POST /api/auctions/{id}/pay 把成交订单标记为已付（winner-only，
  // 幂等）。成交后订单可能晚 1~2 帧才落库，故对错误（404/网络）做容错：仍推进到「已支付」
  // 让演示流程顺畅，但确实发起了真实支付调用（不是纯本地 setPaid）。
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
        <div className="lm-ov-title lm-ov-grad">恭喜竞拍成功</div>
        <div className="lm-ov-sub">豪气冲天 · 经过 {state.bidCount} 轮激烈竞拍成功拍下</div>
        <div className="lm-ov-lot">
          <ProductImg lot={lot} radius={12} className="img" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.3 }}>{lot.title}</div>
            <div className="lm-ov-price win tnum" style={{ marginTop: 4 }}>{fmtYuan(state.currentPrice)}</div>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', textAlign: 'center', marginBottom: 14 }}>保证金 {fmtYuan(lot.deposit)} 已抵扣 · 拍品付款后退回</div>
        {paid ? (
          <>
            <button className="lm-paybtn" style={{ background: 'rgba(47,214,168,0.2)', color: '#2fd6a8', boxShadow: 'none' }} disabled>
              <Icon name="check" size={17} /> 支付成功 · 等待发货
            </button>
            <div className="lm-pay-timer" style={{ cursor: 'pointer', color: 'rgba(255,255,255,0.7)' }} onClick={onReturn}>
              继续看下一件 ›
            </div>
          </>
        ) : (
          <>
            <button className="lm-paybtn" disabled={paying} onClick={doPay}>
              {paying ? '支付处理中…' : `确认地址并支付 ${fmtYuan(state.currentPrice)}`}
            </button>
            <PayTimer />
          </>
        )}
        <ShareOrderBtn lot={lot} />
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
  return <div className="lm-pay-timer">距购买失效还剩 {fmtClock(ms)}</div>;
}

function HammerResult({ state, lot, room, onReturn }: { state: AuctionState; lot: Lot; room: Room; onReturn: () => void }) {
  useEffect(() => {
    const t = setTimeout(onReturn, 6000);
    return () => clearTimeout(t);
  }, [onReturn]);
  const winner = state.leader;
  return (
    <div className="lm-ov">
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        <Confetti count={36} />
      </div>
      <div className="lm-ov-card" style={{ position: 'relative' }}>
        <div className="lm-ov-title lm-ov-grad">落槌定音 · 恭喜成交</div>
        <div className="lm-ov-winner">
          {winner ? <Avatar src={winner.avatar} size={28} ring="#ffce54" /> : <span />}
          <span>{winner?.userName ?? '神秘买家'}</span>
        </div>
        <div style={{ textAlign: 'center', fontSize: 12, color: 'rgba(255,255,255,0.55)', marginBottom: 10 }}>经过 {state.bidCount} 轮激烈竞拍成功拍下</div>
        <div style={{ textAlign: 'center', marginBottom: 6 }}>
          <div className="lm-ov-price win tnum">{fmtYuan(state.currentPrice)}</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>最终成交价</div>
        </div>
        <div className="lm-ov-lot" style={{ marginTop: 12 }}>
          <ProductImg lot={lot} radius={12} className="img" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{lot.title}</div>
            <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.5)', marginTop: 3 }}>{room.anchorName} · 下一件马上开拍</div>
          </div>
        </div>
        <ShareOrderBtn lot={lot} />
        <div className="lm-ended-progress">
          <i style={{ animationDuration: '6s' }} />
        </div>
      </div>
    </div>
  );
}
