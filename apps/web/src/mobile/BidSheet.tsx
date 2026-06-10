import { useState } from 'react';
import type { AuctionState, Lot } from '../lib/types';
import { fmtMoney, fmtYuan, fmtClock } from '../lib/format';
import { computeIncrement } from '../lib/pricing';
import { Icon } from './icons';
import { ProductImg } from './components';

/**
 * 立即出价面板 — 复刻参考稿三态：普通出价 / 一次加多笔 / 自己超过自己。
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
  // 我是否已是最高价：用真实排名（myRank===1）判断，不再用 mock ME（其 id 永不等于后端 userId）。
  const iAmHighest = state.myRank === 1;
  // 动态加价幅度：按商品价值与在线人数算法计算，且不低于后端最小步进。
  const dynStep = Math.max(lot.increment, computeIncrement(lot.capPrice > 0 ? lot.capPrice : state.currentPrice, state.participants, lot.increment));
  // 封顶价为 0 表示「不封顶」（无限加价）；用 effCap 做钳制/校验，避免被当成 ¥0 封顶而禁用出价。
  const effCap = lot.capPrice > 0 ? lot.capPrice : Number.MAX_SAFE_INTEGER;

  // #2 不随直播价「自己跳动」：保持用户设定的 amount 不变；价格涨过它时不静默改它，
  // 只在点「出价」那一刻按最新最低价钳制提交（bidAmt），并提示「价已涨」。
  const dec = () => setAmount((a) => Math.max(nextMinBid, a - dynStep));
  const inc = () => setAmount((a) => Math.min(effCap, a + dynStep));
  const bidAmt = Math.min(effCap, Math.max(amount, nextMinBid));
  const staleLow = amount < nextMinBid;

  const quicks = [
    { label: '+1档', value: nextMinBid },
    { label: '高于当前 ¥100', value: state.currentPrice + 100, hot: true },
    ...(lot.capPrice > 0 ? [{ label: '直接封顶', value: lot.capPrice }] : []),
  ].filter((q) => q.value >= nextMinBid && q.value <= effCap);

  const valid = nextMinBid <= effCap; // 始终可按最新最低价出价（bidAmt 已钳制到 [nextMinBid, effCap]）

  return (
    <div className="lm-mask" onClick={onClose}>
      <div className="lm-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="lm-sheet-grip" />
        <div className="lm-sheet-cd">
          距竞拍结束仅剩 <b className="tnum">{fmtClock(state.remainingMs)}</b>
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
            <div className="k">当前价 · {state.leader ? state.leader.userName + ' 领先' : '0 元起拍'}</div>
            <div className="v tnum">{fmtYuan(state.currentPrice)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="k">我的出价</div>
            <div className="v tnum" style={{ color: state.myMaxBid ? '#ffce54' : 'rgba(255,255,255,0.4)' }}>
              {state.myMaxBid ? fmtYuan(state.myMaxBid) : '暂无出价'}
            </div>
          </div>
        </div>

        <div className="lm-bigstep">
          <button onClick={dec} disabled={amount <= nextMinBid} aria-label="减">
            <Icon name="minus" size={22} />
          </button>
          <div className="amt tnum">
            <small>¥</small>
            {fmtMoney(amount)}
          </div>
          <button onClick={inc} disabled={amount >= effCap} aria-label="加">
            <Icon name="plus" size={22} />
          </button>
        </div>
        <div className="lm-incr-note">加价幅度 ¥{dynStep}（随热度动态） · 最低出价 {fmtYuan(nextMinBid)} · 封顶 {lot.capPrice > 0 ? fmtYuan(lot.capPrice) : '不封顶'}</div>

        <div className="lm-quickrow">
          {quicks.map((q) => (
            <div key={q.label} className={'q' + (q.hot ? ' hot' : '')} onClick={() => setAmount(q.value)}>
              {q.label}
            </div>
          ))}
        </div>

        <button className={'lm-cta' + (iAmHighest ? ' self' : '')} disabled={!valid} onClick={() => onConfirm(bidAmt)}>
          {iAmHighest ? `继续加固 · 出价 ${fmtYuan(bidAmt)}` : `立即出价 ${fmtYuan(bidAmt)}`}
        </button>

        {staleLow && (
          <div className="lm-warn">
            <Icon name="bolt" size={13} /> 竞拍价已上涨，将按最新最低价 {fmtYuan(nextMinBid)} 出价
          </div>
        )}
        {iAmHighest && (
          <div className="lm-warn">
            <Icon name="bolt" size={13} /> 当前您已是最高价，确认继续超过自己？
          </div>
        )}
        {lot.capPrice > 0 && amount >= lot.capPrice && (
          <div className="lm-warn">
            <Icon name="gavel" size={13} /> 已达封顶价，出价即刻成交
          </div>
        )}
      </div>
    </div>
  );
}
