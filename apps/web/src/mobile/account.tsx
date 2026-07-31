// Account UI for the buyer H5 — the visible half of the unified identity (#3/#4).
//
//  · LoginGate    full-screen "pick a name" gate shown on first visit (and as the
//                 editor when switching or editing). "Just browse" is a one-tap guest, so deep-links stay
//                 friction-free. The chosen nickname + avatar drive EVERYTHING:
//                 bids, gifts, comments, win screen — no more split identity.
//  · AccountSheet bottom sheet: shows who you are, plus switch account / sign out.
//  · ProfileButton compact avatar chip in the room header that opens AccountSheet.

import { useState } from 'react';
import { useIdentity, AVATAR_CHOICES, defaultAvatarFor } from '../lib/identity';
import { Avatar } from './components';
import { Icon } from './icons';

function randomNick(): string {
  // Stable-ish suggestion; the user can overwrite it.
  const pool = ['BargainHunter', 'OldCollector', 'WinningItToday', 'StayCalm', 'FinalPayment', 'JustWatching'];
  return pool[Math.floor((Date.now() / 1000) % pool.length)];
}

export function LoginGate() {
  const ident = useIdentity();
  const login = useIdentity((s) => s.login);
  const guest = useIdentity((s) => s.continueAsGuest);
  const editing = !!ident.nickname; // re-opened from switch/edit -> prefill current values
  const [nick, setNick] = useState(ident.nickname);
  const [av, setAv] = useState(ident.avatar || AVATAR_CHOICES[0]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    await login(nick.trim(), av);
  };
  const skip = async () => {
    if (busy) return;
    setBusy(true);
    await guest();
  };

  return (
    <div className="lm-login">
      <div className="lm-login-card">
        <div className="lm-login-brand"><span className="mk">🔨</span> Real-Time Auction Master</div>
        <div className="lm-login-title">{editing ? 'Edit my profile' : 'Enter the live auction'}</div>
        <div className="lm-login-sub">Pick a name and an avatar - bidding, gifts, and winning all use the same identity</div>

        <div className="lm-login-avs">
          {AVATAR_CHOICES.map((src) => (
            <button key={src} className={'lm-login-av' + (src === av ? ' on' : '')} onClick={() => setAv(src)} aria-label="Choose an avatar">
              <Avatar src={src} size={48} ring={src === av ? '#fe2c55' : undefined} />
              {src === av && <span className="tick"><Icon name="check" size={12} stroke={3} /></span>}
            </button>
          ))}
        </div>

        <input
          className="lm-login-input"
          value={nick}
          maxLength={16}
          placeholder={`Nickname (e.g. "${randomNick()}")`}
          onChange={(e) => setNick(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />

        <button className="lm-login-cta" disabled={busy} onClick={submit}>
          <Icon name="gavel" size={18} /> {editing ? 'Save and continue' : 'Enter the room'}
        </button>
        <button className="lm-login-skip" disabled={busy} onClick={skip}>Just browse - continue as a guest</button>
      </div>
    </div>
  );
}

export function ProfileButton({ onClick, avatar: avatarOverride }: { onClick: () => void; avatar?: string }) {
  // Showcase seats pass their own face (buyer A / buyer B); real /m falls back to the
  // logged-in identity. Hook is always called (no conditional) to keep order stable.
  const globalAvatar = useIdentity((s) => s.avatar);
  const avatar = avatarOverride ?? globalAvatar;
  if (!avatar) return null;
  return (
    <button className="lm-profile-btn" onClick={onClick} aria-label="My account">
      <Avatar src={avatar} size={28} ring="rgba(255,255,255,0.9)" />
    </button>
  );
}

export function AccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ident = useIdentity();
  if (!open) return null;
  const switchAccount = () => { onClose(); useIdentity.getState().openLogin(); };
  const logout = () => { onClose(); useIdentity.getState().logout(); };
  return (
    <>
      <div className="lm-sheet-backdrop" onClick={onClose} />
      <div className="lm-acct">
        <div className="lm-tabsheet-head">
          <div className="lm-tabsheet-grip" onClick={onClose} />
          <span className="lm-tabsheet-title">My account</span>
          <button className="lm-tabsheet-x" onClick={onClose} aria-label="Collapse"><Icon name="chevronD" size={18} /></button>
        </div>
        <div className="lm-acct-id">
          <Avatar src={ident.avatar || defaultAvatarFor(ident.nickname)} size={52} ring="#fe2c55" />
          <div className="meta">
            <div className="nm">{ident.nickname || 'Guest'}</div>
            <div className={'badge' + (ident.loggedIn ? ' on' : '')}>{ident.loggedIn ? 'Signed in' : 'Guest'}</div>
          </div>
        </div>
        <button className="lm-acct-row" onClick={switchAccount}>
          <Icon name="user" size={17} /> <span>Switch account / edit profile</span> <Icon name="chevronR" size={16} style={{ marginLeft: 'auto', opacity: 0.6 }} />
        </button>
        <button className="lm-acct-row danger" onClick={logout}>
          <Icon name="close" size={17} /> <span>Sign out</span>
        </button>
        <div className="lm-acct-note">One identity runs through bidding, gifts, comments, and settlement; switching re-enters the room as the new identity.</div>
      </div>
    </>
  );
}
