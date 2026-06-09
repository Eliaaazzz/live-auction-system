import { useEffect, useState } from 'react';
import type { AuctionState, Lot } from '../lib/types';
import { fmtMoney, fmtYuan, fmtClock } from '../lib/format';
import { ME } from '../lib/mockData';
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
  const iAmHighest = state.leader?.userId === ME.id;

  useEffect(() => {
    setAmount((a) => (a < nextMinBid ? nextMinBid : a));
  }, [nextMinBid]);

  const dec = () => setAmount((a) => Math.max(nextMinBid, a - lot.increment));
  const inc = () => setAmount((a) => Math.min(lot.capPrice, a + lot.increment));

  const quicks = [
    { label: '+1档', value: nextMinBid },
    { label: '高于当前 ¥100', value: state.currentPrice + 100, hot: true },
    { label: '直接封顶', value: lot.capPrice },
  ].filter((q) => q.value >= nextMinBid && q.value <= lot.capPrice);

  const valid = amount >= nextMinBid && amount <= lot.capPrice;

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
          <button onClick={inc} disabled={amount >= lot.capPrice} aria-label="加">
            <Icon name="plus" size={22} />
          </button>
        </div>
        <div className="lm-incr-note">加价幅度 ¥{lot.increment} · 最低出价 {fmtYuan(nextMinBid)} · 封顶 {fmtYuan(lot.capPrice)}</div>

        <div className="lm-quickrow">
          {quicks.map((q) => (
            <div key={q.label} className={'q' + (q.hot ? ' hot' : '')} onClick={() => setAmount(q.value)}>
              {q.label}
            </div>
          ))}
        </div>

        <button className={'lm-cta' + (iAmHighest ? ' self' : '')} disabled={!valid} onClick={() => onConfirm(amount)}>
          {iAmHighest ? `继续加固 · 出价 ${fmtYuan(amount)}` : `立即出价 ${fmtYuan(amount)}`}
        </button>

        {iAmHighest && (
          <div className="lm-warn">
            <Icon name="bolt" size={13} /> 当前您已是最高价，确认继续超过自己？
          </div>
        )}
        {amount >= lot.capPrice && (
          <div className="lm-warn">
            <Icon name="gavel" size={13} /> 已达封顶价，出价即刻成交
          </div>
        )}
      </div>
    </div>
  );
}
