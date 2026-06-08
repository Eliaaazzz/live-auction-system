import { useRef, useState } from 'react';
import LiveRoom from './LiveRoom';
import { ROOMS } from '../lib/mockData';
import { SwipeHint } from './components';
import './mobile.css';

// 每个房间的预热参数（让排行榜/历史有内容、演示「即将开拍」等不同状态）
const SEEDS = [
  { seedToPrice: 850, startDelaySec: 0 }, // 房间1：贴合参考稿（张** ¥850 领先）
  { seedToPrice: 8800, startDelaySec: 0 }, // 房间2：翡翠手镯，价格已抬高
  { seedToPrice: 0, startDelaySec: 8 }, // 房间3：腕表，演示「即将开拍」
];

export default function MobileApp() {
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<'up' | 'down'>('up');
  const cooldown = useRef(false);
  const touchY = useRef<number | null>(null);

  const go = (next: number, direction: 'up' | 'down') => {
    if (cooldown.current) return;
    const clamped = (next + ROOMS.length) % ROOMS.length;
    if (clamped === index) return;
    cooldown.current = true;
    setDir(direction);
    setIndex(clamped);
    setTimeout(() => (cooldown.current = false), 480);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaY) < 24) return;
    if (e.deltaY > 0) go(index + 1, 'up');
    else go(index - 1, 'down');
  };
  const onTouchStart = (e: React.TouchEvent) => {
    touchY.current = e.touches[0].clientY;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchY.current == null) return;
    const dy = touchY.current - e.changedTouches[0].clientY;
    if (Math.abs(dy) > 56) {
      if (dy > 0) go(index + 1, 'up');
      else go(index - 1, 'down');
    }
    touchY.current = null;
  };

  const room = ROOMS[index];
  const seed = SEEDS[index] ?? SEEDS[0];

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#000' }}
      onWheel={onWheel}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div key={room.id} className={'lm-room in-' + dir}>
        <LiveRoom room={room} seedToPrice={seed.seedToPrice} startDelaySec={seed.startDelaySec} />
      </div>

      {index === 0 && <SwipeHint />}

      <div className="lm-dots">
        {ROOMS.map((r, i) => (
          <i key={r.id} className={i === index ? 'on' : ''} />
        ))}
      </div>
    </div>
  );
}
