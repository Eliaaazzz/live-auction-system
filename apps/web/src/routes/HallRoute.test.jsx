// src/routes/HallRoute.test.jsx
//
// P0-2 (judges-stage review): the first screen is a 拍卖剧场, not a list.
// HallHero is pure (auction in, CTA out) so it tests without the API layer.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HallHero } from './HallRoute.jsx';

const LIVE_AUCTION = {
  auctionId: 'auc_hero',
  status: 'LIVE',
  productName: '百达翡丽 5711/1A',
  currentPriceCents: '12880000',
  imageUrl: '/demo/watch-explorer.jpg',
  endAtMs: Date.now() + 28_000,
};

describe('HallHero (P0-2)', () => {
  it('LIVE hero: name, current price, anti-snipe rule, 进入竞拍现场 CTA', () => {
    render(<HallHero a={LIVE_AUCTION} onEnter={() => {}}/>);
    expect(screen.getByText('百达翡丽 5711/1A')).toBeTruthy();
    expect(screen.getByText('当前价')).toBeTruthy();
    expect(screen.getByText('¥128,800')).toBeTruthy();
    expect(screen.getByText('末 10 秒出价自动延时')).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入竞拍现场 →' })).toBeTruthy();
    // trust footer names the engineering on screen one
    expect(screen.getByText(/WebSocket 实时同步 · seq 可追溯 · 证据链落槌生成/)).toBeTruthy();
  });

  it('SCHEDULED hero reads 起拍价 + 提前进场', () => {
    render(<HallHero a={{ ...LIVE_AUCTION, status: 'SCHEDULED', currentPriceCents: '0' }} onEnter={() => {}}/>);
    expect(screen.getByText('起拍价')).toBeTruthy();
    expect(screen.getByText('待开拍')).toBeTruthy();
    expect(screen.getByRole('button', { name: '提前进场 →' })).toBeTruthy();
  });

  it('CTA enters the hero room', () => {
    const onEnter = vi.fn();
    render(<HallHero a={LIVE_AUCTION} onEnter={onEnter}/>);
    fireEvent.click(screen.getByRole('button', { name: '进入竞拍现场 →' }));
    expect(onEnter).toHaveBeenCalledWith('auc_hero');
  });
});
