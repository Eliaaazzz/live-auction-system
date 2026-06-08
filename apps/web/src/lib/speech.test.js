// src/lib/speech.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { speakCue, cancelSpeech, isSpeechSupported } from './speech.js';

// jsdom has no speechSynthesis — install a controllable fake.
function installSynth({ voices = [] } = {}) {
  const calls = { speak: [], cancel: 0 };
  window.speechSynthesis = {
    speak: (u) => calls.speak.push(u),
    cancel: () => { calls.cancel += 1; },
    getVoices: () => voices,
  };
  window.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; this.lang = ''; this.rate = 1; this.pitch = 1; this.volume = 1; this.voice = null; }
  };
  return calls;
}

describe('lib/speech', () => {
  afterEach(() => {
    delete window.speechSynthesis;
    delete window.SpeechSynthesisUtterance;
    vi.restoreAllMocks();
  });

  it('isSpeechSupported reflects API presence', () => {
    expect(isSpeechSupported()).toBe(false); // not installed yet
    installSynth();
    expect(isSpeechSupported()).toBe(true);
  });

  it('speakCue speaks zh-CN utterance with the text', () => {
    const calls = installSynth();
    const ok = speakCue('拍卖开始');
    expect(ok).toBe(true);
    expect(calls.speak).toHaveLength(1);
    expect(calls.speak[0].text).toBe('拍卖开始');
    expect(calls.speak[0].lang).toBe('zh-CN');
    // cancels any in-flight cue first (newest moment wins)
    expect(calls.cancel).toBe(1);
  });

  it('speakCue picks a Chinese voice when available', () => {
    const zh = { lang: 'zh-CN', name: 'Tingting' };
    const calls = installSynth({ voices: [{ lang: 'en-US', name: 'Alex' }, zh] });
    speakCue('落槌成交');
    expect(calls.speak[0].voice).toBe(zh);
  });

  it('mute → does not speak', () => {
    const calls = installSynth();
    expect(speakCue('黑马出价', { mute: true })).toBe(false);
    expect(calls.speak).toHaveLength(0);
  });

  it('empty text → no-op', () => {
    const calls = installSynth();
    expect(speakCue('')).toBe(false);
    expect(calls.speak).toHaveLength(0);
  });

  it('unsupported environment → no throw, returns false', () => {
    // no synth installed
    expect(() => speakCue('反狙击延时')).not.toThrow();
    expect(speakCue('反狙击延时')).toBe(false);
    expect(() => cancelSpeech()).not.toThrow();
  });

  it('cancelSpeech cancels the synth', () => {
    const calls = installSynth();
    cancelSpeech();
    expect(calls.cancel).toBe(1);
  });

  it('speakCue swallows a throwing synth', () => {
    window.speechSynthesis = { speak: () => { throw new Error('boom'); }, cancel: () => {}, getVoices: () => [] };
    window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    expect(speakCue('落槌成交')).toBe(false);
  });
});
