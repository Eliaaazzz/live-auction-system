// identity — ONE source of truth for "who am I" on the buyer H5.
//
// Before this, the room had THREE conflicting identities: the backend session
// (yourUserId / nickname "买家XXXX", used for bids + leaderboard), a hardcoded
// mock `ME` (id:'me', avatar(15), used for gifts/comments), and a broken
// `=== 'me'` win check. So the same "我" showed a different face on a gift than
// on a bid, and the winner never got the win screen. (#3 送礼账号矛盾)
//
// This store unifies them: the logged-in nickname + avatar drive bids, gifts,
// comments AND win detection. It reuses the existing backend /api/login
// (nickname → stable userId) via backend/lib/auth.js — no new backend needed
// (#4 轻量昵称登录). Lightweight on purpose: a nickname + an avatar, switchable,
// with a "先逛逛" guest path so deep-links / quick demos stay one tap away.

import { create } from 'zustand';
import { avatar } from './assets';
import {
  ensureSession,
  setNickname as authSetNickname,
  deviceNickname,
  clearSession,
} from '../backend/lib/auth.js';

const AV_KEY = 'lumen.avatar';
const READY_KEY = 'lumen.identReady'; // '1' once the user has logged in OR chosen guest
const LOGGEDIN_KEY = 'lumen.loggedIn'; // '1' real login, absent/0 = guest

/** Avatar palette shown in the login picker (real photo faces via pravatar). */
export const AVATAR_CHOICES: string[] = [15, 5, 20, 33, 26, 45, 51, 8].map((n) => avatar(n));

/** Stable per-identity avatar so a guest's face matches their bid rows. */
function hashNum(s: string): number {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 70) + 1;
}
export function defaultAvatarFor(seed: string): string {
  return avatar(hashNum(seed || 'me'));
}

/** A lightweight, fixed buyer identity — nickname + face — with no store/login. */
export type SeatIdentity = { nickname: string; avatar: string };

// Showcase seats: deterministic, visibly-DISTINCT buyers so the triptych shows
// 买家A and 买家B as two genuinely separate accounts (their own nickname, face,
// and — via auth.js seats — their own backend userId/token). Stable across
// reloads so a returning viewer keeps the same two faces. Real /m never calls
// this; it uses the full useIdentity login store above.
const SEAT_IDENTITIES: Record<string, SeatIdentity> = {
  A: { nickname: '买家A', avatar: avatar(15) },
  B: { nickname: '买家B', avatar: avatar(33) },
};
export function seatIdentity(seat: string): SeatIdentity {
  return SEAT_IDENTITIES[seat] ?? { nickname: '买家' + seat, avatar: defaultAvatarFor('seat-' + seat) };
}

function ls(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, val: string) {
  try { localStorage.setItem(key, val); } catch { /* ignore */ }
}
function lsDel(key: string) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// Hydrate synchronously from localStorage at store-creation so a returning user
// never sees a login flash: nickname + avatar render instantly; the backend
// userId resolves in the background via resolve().
function boot() {
  const ready = ls(READY_KEY) === '1';
  const nickname = ls('lumen.nick') || '';
  const av = ls(AV_KEY) || (nickname ? defaultAvatarFor(nickname) : '');
  const loggedIn = ls(LOGGEDIN_KEY) === '1';
  return { ready, nickname, avatar: av, loggedIn };
}

interface IdentityState {
  userId: string | null;
  nickname: string;
  avatar: string;
  ready: boolean;    // identity resolved (logged in or guest) — gate the buyer rail on this
  loggedIn: boolean; // true = real nickname login; false = guest ("先逛逛")
  busy: boolean;
  /** Resolve/refresh the backend session (userId) for the current identity. */
  resolve: () => Promise<void>;
  /** Real login: persist nickname + avatar, mint a backend session. */
  login: (nickname: string, avatarUrl: string) => Promise<void>;
  /** Continue without naming yourself — a stable per-device guest identity. */
  continueAsGuest: () => Promise<void>;
  /** Re-open the login gate (prefilled) without dropping the session — 切换/编辑. */
  openLogin: () => void;
  /** Drop the identity entirely → login gate shows empty. */
  logout: () => void;
}

export const useIdentity = create<IdentityState>((set, get) => ({
  userId: null,
  ...boot(),
  busy: false,

  resolve: async () => {
    if (get().busy) return;
    const nick = get().nickname || deviceNickname();
    set({ busy: true });
    try {
      const s = await ensureSession(nick);
      set({ userId: s.userId, nickname: s.nickname || nick, busy: false });
    } catch {
      set({ busy: false }); // backend unreachable — keep optimistic local identity
    }
  },

  login: async (nickname, avatarUrl) => {
    const nick = (nickname || '').trim().slice(0, 16) || deviceNickname();
    const av = avatarUrl || defaultAvatarFor(nick);
    authSetNickname(nick); // writes lumen.nick + drops the old-nickname token
    lsSet(AV_KEY, av); lsSet(READY_KEY, '1'); lsSet(LOGGEDIN_KEY, '1');
    set({ nickname: nick, avatar: av, ready: true, loggedIn: true, busy: true });
    try {
      const s = await ensureSession(nick);
      set({ userId: s.userId, nickname: s.nickname || nick, busy: false });
    } catch {
      set({ busy: false });
    }
  },

  continueAsGuest: async () => {
    const nick = deviceNickname();
    const av = ls(AV_KEY) || defaultAvatarFor(nick);
    lsSet(AV_KEY, av); lsSet(READY_KEY, '1'); lsDel(LOGGEDIN_KEY);
    set({ nickname: nick, avatar: av, ready: true, loggedIn: false, busy: true });
    try {
      const s = await ensureSession(nick);
      set({ userId: s.userId, nickname: s.nickname || nick, busy: false });
    } catch {
      set({ busy: false });
    }
  },

  openLogin: () => set({ ready: false }),

  logout: () => {
    lsDel(AV_KEY); lsDel(READY_KEY); lsDel(LOGGEDIN_KEY);
    clearSession();
    set({ userId: null, nickname: '', avatar: '', ready: false, loggedIn: false });
  },
}));
