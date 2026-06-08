// src/components/VoiceBidButton.test.jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { VoiceBidButton } from './VoiceBidButton.jsx';

// Fake SpeechRecognition: captures the instance so the test can drive onresult.
let lastRec;
class FakeSR {
  constructor() { this.lang = ''; lastRec = this; }
  start() { this.started = true; }
  abort() {}
  emit(transcript) {
    this.onresult?.({ results: [[{ transcript }]] });
    this.onend?.();
  }
  fail() { this.onerror?.({ error: 'no-speech' }); this.onend?.(); }
}

const ctx = { currentCents: '12880000', stepCents: '500000' };

describe('VoiceBidButton', () => {
  beforeEach(() => { lastRec = undefined; window.SpeechRecognition = FakeSR; });
  afterEach(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; vi.restoreAllMocks(); });

  it('transcribes 加价五千 → confirm row → onBid with the target amount', () => {
    const onBid = vi.fn();
    render(<VoiceBidButton {...ctx} onBid={onBid} />);
    fireEvent.click(screen.getByRole('button', { name: '语音出价' }));
    act(() => lastRec.emit('加价五千'));

    expect(screen.getByText(/听到「加价五千」/)).toBeTruthy();
    expect(screen.getByText(/出价 ¥133,800/)).toBeTruthy();
    expect(onBid).not.toHaveBeenCalled(); // not until confirm

    fireEvent.click(screen.getByRole('button', { name: '确认出价' }));
    expect(onBid).toHaveBeenCalledWith('13380000');
  });

  it('absolute 出价十三万八 → ¥138,000 target', () => {
    const onBid = vi.fn();
    render(<VoiceBidButton {...ctx} onBid={onBid} />);
    fireEvent.click(screen.getByRole('button', { name: '语音出价' }));
    act(() => lastRec.emit('出价十三万八'));
    fireEvent.click(screen.getByRole('button', { name: '确认出价' }));
    expect(onBid).toHaveBeenCalledWith('13800000');
  });

  it('cancel discards the pending bid (no onBid)', () => {
    const onBid = vi.fn();
    render(<VoiceBidButton {...ctx} onBid={onBid} />);
    fireEvent.click(screen.getByRole('button', { name: '语音出价' }));
    act(() => lastRec.emit('加价五千'));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onBid).not.toHaveBeenCalled();
    expect(screen.queryByText(/听到/)).toBeNull();
  });

  it('gibberish shows a helpful note, no confirm row', () => {
    render(<VoiceBidButton {...ctx} onBid={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '语音出价' }));
    act(() => lastRec.emit('今天天气不错'));
    expect(screen.getByText(/没听懂/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认出价' })).toBeNull();
  });

  it('recognition error surfaces a retry note', () => {
    render(<VoiceBidButton {...ctx} onBid={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '语音出价' }));
    act(() => lastRec.fail());
    expect(screen.getByText(/没听清/)).toBeTruthy();
  });

  it('unsupported browser → note, no crash', () => {
    delete window.SpeechRecognition;
    render(<VoiceBidButton {...ctx} onBid={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '语音出价' }));
    expect(screen.getByText(/不支持语音/)).toBeTruthy();
  });

  it('disabled hides interaction (biddingLocked)', () => {
    const onBid = vi.fn();
    render(<VoiceBidButton {...ctx} disabled onBid={onBid} />);
    const btn = screen.getByRole('button', { name: '语音出价' });
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(lastRec).toBeUndefined(); // never started recognition
  });
});
