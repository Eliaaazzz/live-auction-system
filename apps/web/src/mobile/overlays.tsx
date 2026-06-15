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
  // 退出直播间。真实 /m 由 BuyerRail 注入（→ 退出终态屏）；showcase seat 不传（保留自动跳场）。
  onExit?: () => void;
  // 是否还有「其他场」可看（多场直播时为 true）。决定是否显示「继续看其他场」。
  canContinue?: boolean;
  // 仅 showcase：结束后自动进入下一场的毫秒数（让三屏 demo 持续滚动）。真实 /m 不传 → 终态等用户操作。
  autoAdvanceMs?: number;
  reminded: boolean;
  onToggleRemind: () => void;
}) {
  if (state.status === 'upcoming') return <AboutToStart state={state} lot={lot} reminded={reminded} onToggleRemind={onToggleRemind} />;
  const end = { onReturn, onExit, canContinue, autoAdvanceMs };
  if (state.status === 'unsold') return <EndedOverlay lot={lot} {...end} />;
  if (state.status === 'sold') {
    // 我是否拍中：用真实排名（成交时第 1 名即赢家）判断，不再用恒为 false 的
    // `leader.userId === 'me'`（后端 userId 永不等于 'me'，导致赢家永远进不了庆祝页）。
    const won = state.myRank === 1;
    return won ? <WinSuccess state={state} lot={lot} {...end} /> : <HammerResult state={state} lot={lot} room={room} {...end} />;
  }
  return null;
}

// 结束浮层底部统一的「退出 / 继续」操作区。退出是 V8 要求的「推出界面」入口；
// 「继续看其他场」仅多场直播时出现（onReturn → 上滑切下一间）。
function EndActions({ onExit, onReturn, canContinue, show = true }: { onExit?: () => void; onReturn: () => void; canContinue: boolean; show?: boolean }) {
  if (!show || (!onExit && !canContinue)) return null;
  return (
    <div className="lm-ov-foot">
      {onExit && (
        <button className="lm-ov-exit" onClick={onExit}>
          <Icon name="close" size={15} /> 退出直播间
        </button>
      )}
      {canContinue && (
        <button className="lm-ov-continue" onClick={onReturn}>
          继续看其他场 <Icon name="chevronR" size={14} />
        </button>
      )}
    </div>
  );
}

function AboutToStart({ state, lot, reminded, onToggleRemind }: { state: AuctionState; lot: Lot; reminded: boolean; onToggleRemind: () => void }) {
  return (
    <div className="lm-ov">
      <div className="lm-ov-card">
        <div className="lm-ov-title">即将开拍</div>
        {/* startsInMs 目前后端快照不下发(恒 0) → 别显示假的「00:00 后开始」；
            有真实倒计时才显示，否则给诚实文案并引导下方「设置开拍提醒」。 */}
        <div className="lm-ov-sub">{state.startsInMs > 0 ? `下一件拍品 ${fmtClock(state.startsInMs)} 后开始` : '主播正在准备 · 设置提醒不错过开拍'}</div>
        <div className="lm-ov-lot">
          <ProductImg lot={lot} radius={12} className="img" />
          <div style={{ minWidth: 0 }}>
            <div className="lm-ov-lot-title">{lot.title}</div>
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

function EndedOverlay({ lot, onReturn, onExit, canContinue, autoAdvanceMs }: { lot: Lot; onReturn: () => void; onExit?: () => void; canContinue: boolean; autoAdvanceMs?: number }) {
  // 仅 showcase（autoAdvanceMs 注入时）自动跳下一场；真实 /m 终态等用户「退出 / 继续看其他场」。
  useEffect(() => {
    if (!autoAdvanceMs || !canContinue) return;
    const t = setTimeout(onReturn, autoAdvanceMs);
    return () => clearTimeout(t);
  }, [onReturn, autoAdvanceMs, canContinue]);
  const auto = !!autoAdvanceMs && canContinue;
  return (
    <div className="lm-ov">
      <div className="lm-ov-card">
        <div className="lm-ov-title">本场竞拍已结束</div>
        <div className="lm-ov-sub">本场无人出价 · 流拍</div>
        <div className="lm-ov-lot">
          <ProductImg lot={lot} radius={12} className="img" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{lot.title}</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>起拍价 {lot.startPrice === 0 ? '0 元起' : fmtYuan(lot.startPrice)}</div>
          </div>
        </div>
        <EndActions onExit={onExit} onReturn={onReturn} canContinue={canContinue} show={!auto} />
        {auto && (
          <>
            <div style={{ textAlign: 'center', fontSize: 12.5, color: 'rgba(255,255,255,0.6)' }}>即将自动进入下一场</div>
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
            <div className="lm-ov-lot-title">{lot.title}</div>
            <div className="lm-ov-price win tnum" style={{ marginTop: 4 }}>{fmtYuan(state.currentPrice)}</div>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', textAlign: 'center', marginBottom: 14 }}>保证金 {fmtYuan(lot.deposit)} 已抵扣 · 拍品付款后退回</div>
        {paid ? (
          <button className="lm-paybtn" style={{ background: 'rgba(47,214,168,0.2)', color: '#2fd6a8', boxShadow: 'none' }} disabled>
            <Icon name="check" size={17} /> 支付成功 · 等待发货
          </button>
        ) : (
          <>
            <button className="lm-paybtn" disabled={paying} onClick={doPay}>
              {paying ? '支付处理中…' : `确认地址并支付 ${fmtYuan(state.currentPrice)}`}
            </button>
            <PayTimer />
          </>
        )}
        <ShareOrderBtn lot={lot} />
        {/* 退出直播间随时可用（赢家不被困在结算页）；「继续看其他场」付款后再出现，不抢支付主动作。 */}
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
  return <div className="lm-pay-timer">距购买失效还剩 {fmtClock(ms)}</div>;
}

function HammerResult({ state, lot, room, onReturn, onExit, canContinue, autoAdvanceMs }: { state: AuctionState; lot: Lot; room: Room; onReturn: () => void; onExit?: () => void; canContinue: boolean; autoAdvanceMs?: number }) {
  // 仅 showcase 自动跳下一场；真实 /m 终态等用户操作。
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
            <div className="lm-ov-lot-title">{lot.title}</div>
            <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.5)', marginTop: 3 }}>{room.anchorName} · 本场竞拍已结束</div>
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
