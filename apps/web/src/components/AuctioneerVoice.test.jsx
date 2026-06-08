// src/components/AuctioneerVoice.test.jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { AuctioneerVoice, VOICE_CUES } from './AuctioneerVoice.jsx';
import * as speech from '../lib/speech.js';

describe('AuctioneerVoice — 关键时刻出声', () => {
  let speakSpy;
  let cancelSpy;
  beforeEach(() => {
    speakSpy = vi.spyOn(speech, 'speakCue').mockReturnValue(true);
    cancelSpy = vi.spyOn(speech, 'cancelSpeech').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const spokenTexts = () => speakSpy.mock.calls.map((c) => c[0]);

  it('does NOT shout 开拍 when mounted already LIVE (reload/deep-link)', () => {
    render(<AuctioneerVoice enabled status="LIVE" />);
    expect(spokenTexts()).not.toContain(VOICE_CUES.open);
  });

  it('speaks 拍卖开始 on a real SCHEDULED→LIVE transition', () => {
    const { rerender } = render(<AuctioneerVoice enabled status="SCHEDULED" />);
    rerender(<AuctioneerVoice enabled status="LIVE" />);
    expect(spokenTexts()).toContain(VOICE_CUES.open);
  });

  it('speaks 落槌成交 once on LIVE→SOLD', () => {
    const { rerender } = render(<AuctioneerVoice enabled status="LIVE" />);
    rerender(<AuctioneerVoice enabled status="SOLD" />);
    rerender(<AuctioneerVoice enabled status="SOLD" />); // no re-fire on same status
    expect(spokenTexts().filter((t) => t === VOICE_CUES.sold)).toHaveLength(1);
  });

  it('speaks 本场流拍 on LIVE→NO_BID', () => {
    const { rerender } = render(<AuctioneerVoice enabled status="LIVE" />);
    rerender(<AuctioneerVoice enabled status="NO_BID" />);
    expect(spokenTexts()).toContain(VOICE_CUES.nobid);
  });

  it('speaks 黑马出价 once per banner, re-arms after it clears', () => {
    const { rerender } = render(<AuctioneerVoice enabled status="LIVE" showBlackHorse={false} />);
    rerender(<AuctioneerVoice enabled status="LIVE" showBlackHorse />);
    rerender(<AuctioneerVoice enabled status="LIVE" showBlackHorse />); // still up → no re-speak
    expect(spokenTexts().filter((t) => t === VOICE_CUES.surge)).toHaveLength(1);
    rerender(<AuctioneerVoice enabled status="LIVE" showBlackHorse={false} />); // clear → re-arm
    rerender(<AuctioneerVoice enabled status="LIVE" showBlackHorse />);
    expect(spokenTexts().filter((t) => t === VOICE_CUES.surge)).toHaveLength(2);
  });

  it('speaks 反狙击延时 once per new extendFlash seq', () => {
    const { rerender } = render(<AuctioneerVoice enabled status="LIVE" extendFlash={null} />);
    rerender(<AuctioneerVoice enabled status="LIVE" extendFlash={{ count: 1, seq: 14945, addedSec: 30 }} />);
    rerender(<AuctioneerVoice enabled status="LIVE" extendFlash={null} />); // store cleared it
    rerender(<AuctioneerVoice enabled status="LIVE" extendFlash={{ count: 2, seq: 14999, addedSec: 30 }} />);
    expect(spokenTexts().filter((t) => t === VOICE_CUES.extend)).toHaveLength(2);
  });

  it('mute (enabled=false) speaks nothing and cancels in-flight speech', () => {
    const { rerender } = render(<AuctioneerVoice enabled={false} status="LIVE" />);
    rerender(<AuctioneerVoice enabled={false} status="SOLD" showBlackHorse />);
    expect(speakSpy).not.toHaveBeenCalled();
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('renders nothing', () => {
    const { container } = render(<AuctioneerVoice enabled status="LIVE" />);
    expect(container.firstChild).toBeNull();
  });
});
