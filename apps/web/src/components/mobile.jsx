import React from 'react';
import { formatCentsCNY, formatCentsCNYCompact, addCentsStr, bidRejectCopy,
  PriceDisplay, Countdown, StatusBadge, ExtendBadge,
  AIBubble, QuickBidChips, HeatMeter,
  ConnectionBar, ClockDriftIndicator } from './primitives.jsx';
import { LeadingToast, OvertakenSlam, MyPositionGap,
  BidTickerStream, BidHistoryStrip, HeartbeatVignette, SpeakerToggle,
  SandHourglass, PulseWaves, LongPressBidWheel,
  BlackHorseBanner, HammerTransition } from './atmosphere.jsx';

// lumen-mobile.jsx
// Mobile H5 screens: Room (LIVE + final-10s), Hammer overlay, Evidence.
// Inside an IOSDevice (402×874). Safe-area: top 47 status, bottom 34 home.

// Demo data — 5-figure luxury watch (the brief says high-value singles)
const DEMO_LEADERS = [
  { userId: 'u1', displayName: '海风_2024',    cents: '12880000', avatarBg: 'linear-gradient(135deg,#FE2C55,#cb203f)' },
  { userId: 'u2', displayName: '听雨人',       cents: '12750000', avatarBg: 'linear-gradient(135deg,#25F4EE,#0ea5e9)' },
  { userId: 'u3', displayName: '陆_LU',        cents: '12500000', avatarBg: 'linear-gradient(135deg,#a855f7,#7c3aed)', isYou: true },
  { userId: 'u4', displayName: '盐渍生活',     cents: '12380000', avatarBg: 'linear-gradient(135deg,#f59e0b,#d97706)' },
  { userId: 'u5', displayName: 'Echo🌙',        cents: '12200000', avatarBg: 'linear-gradient(135deg,#10b981,#059669)' },
];

// LiveVideo renders the 直播画面 (spec §4, #121 火山直播). For an HLS .m3u8 it uses
// hls.js on browsers without native HLS (Chrome/Firefox/Edge); Safari/iOS play
// HLS natively, and a plain mp4/webm loop just sets src. hls.js is loaded lazily
// (dynamic import) so the no-video path never pays for it. Display-only — never
// gates bidding; on any failure the parent falls back to the sim sheen.
function LiveVideo({ url, poster, onPlayFailed }) {
  const ref = React.useRef(null);
  const reportedRef = React.useRef(false);
  const onPlayFailedRef = React.useRef(onPlayFailed);
  React.useEffect(() => {
    onPlayFailedRef.current = onPlayFailed;
  });

  const reportFailure = React.useCallback(() => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    onPlayFailedRef.current?.();
  }, []);

  React.useEffect(() => {
    reportedRef.current = false;
  }, [url]);

  React.useEffect(() => {
    const video = ref.current;
    if (!video || !url) return undefined;
    const isHls = /\.m3u8(\?|$)/i.test(url);
    const nativeHls = video.canPlayType('application/vnd.apple.mpegurl') !== '';
    if (isHls && !nativeHls) {
      let cancelled = false;
      let hls;
      import('hls.js')
        .then(({ default: Hls }) => {
          if (cancelled || !ref.current) return;
          if (Hls.isSupported()) {
            hls = new Hls({ liveDurationInfinity: true });
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data?.fatal) reportFailure();
            });
            hls.loadSource(url);
            hls.attachMedia(ref.current);
          } else {
            ref.current.src = url; // last resort
          }
        })
        .catch(() => { if (ref.current) ref.current.src = url; });
      return () => { cancelled = true; if (hls) hls.destroy(); };
    }
    video.src = url; // native HLS (Safari/iOS) or a plain loop
    return () => {
      video.removeAttribute('src');
      try { video.load(); } catch (_) { /* detach best-effort */ }
    };
  }, [url]);
  return (
    <video ref={ref} poster={poster || undefined}
      onError={reportFailure}
      autoPlay muted loop playsInline
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}/>
  );
}

function MobileRoomSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="正在加载竞拍房间"
      style={{
      position: 'relative',
      width: '100%',
      height: '100%',
      background: 'var(--douyin-ink)',
      color: 'var(--douyin-ink-text)',
      fontFamily: 'var(--font-sans)',
      overflow: 'hidden',
    }}>
      <div className="lumen-skeleton" style={{
        position: 'absolute',
        inset: 0,
        height: '46%',
        backgroundColor: 'rgba(255,255,255,.05)',
      }}/>
      <div style={{ position: 'absolute', top: 56, left: 16, right: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
        <SkeletonBlock w={128} h={34} r={17}/>
        <div style={{ flex: 1 }}/>
        <SkeletonBlock w={66} h={28} r={14}/>
        <SkeletonBlock w={32} h={32} r={16}/>
      </div>
      <div style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        top: '46%',
        padding: '18px 14px 50px',
        background: 'linear-gradient(180deg, rgba(23,26,40,.72), rgba(23,26,40,.96))',
        backdropFilter: 'blur(18px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}>
        <SkeletonBlock w={36} h={4} r={2} align="center"/>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <SkeletonBlock w={54} h={10} r={5}/>
            <SkeletonBlock w={178} h={36} r={8}/>
          </div>
          <SkeletonBlock w={92} h={44} r={8}/>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[0, 1, 2, 3, 4].map((i) => <SkeletonBlock key={i} w={52} h={30} r={8} grow/>)}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', justifyContent: 'center', minHeight: 118 }}>
          <SkeletonBlock w={72} h={94} r={8}/>
          <SkeletonBlock w={84} h={118} r={8}/>
          <SkeletonBlock w={72} h={84} r={8}/>
        </div>
        <SkeletonBlock w="100%" h={48} r={8}/>
        <div style={{ marginTop: 'auto', display: 'flex', gap: 6 }}>
          {[0, 1, 2, 3].map((i) => <SkeletonBlock key={i} w={74} h={52} r={10} grow/>)}
        </div>
      </div>
    </div>
  );
}

function SkeletonBlock({ w, h, r = 8, align, grow = false }) {
  return (
    <div className="lumen-skeleton" style={{
      width: w,
      height: h,
      borderRadius: r,
      flex: grow ? 1 : '0 0 auto',
      alignSelf: align,
      backgroundColor: 'rgba(255,255,255,.08)',
    }}/>
  );
}

// ─── Mobile · Room ─────────────────────────────────────────────
function MobileRoom({
  productImage = null,
  viewerCount = 0,
  remainingMs = 30000,
  status = 'LIVE',
  currentCents = '12880000',
  stepCents = '500000',
  capCents = null,
  extendCount = 2,
  extendSweep = false,
  isYouLeading = false,
  overtakeBanner = false,
  rejectShake = false,
  rejectCode = null,
  flashPrice = false,
  aiStatus = 'live',
  aiTrigger = 'open',
  aiText = '当前价 ¥128,800 · 还有 30 秒，机会留给最果断的人。',
  aiStreaming = false,
  connStatus = 'ok',
  showColorRamp = false,
  expressive = true,
  showOwnFlash = false,
  showLeadingToast = false,
  ticker = [],
  yourRank = 3,
  yourGapCents = '380000',
  screenShake = false,
  showHourglass = false,
  showPulseWaves = false,
  showBlackHorse = false,
  showLongPress = false,
  showHammerTransition = false,
  combos = {},  // userId -> streak count
  // F-new (post-Elia round-2 review):
  bidsPerSec = 0,          // for the HeatMeter
  bidsPerSecPeak = 6,      // scale ceiling — calibrate from observed peak
  leaders: leadersProp,    // optional override; falls back to DEMO_LEADERS
  onBid,                   // chip-driven bid callback; LiveRoomRoute passes placeBid
  serverClockOffsetMs = 0, // now - serverTimeMs skew (P4); drives the drift chip
  lastSeq = null,          // latest applied Stream seq; null → not yet joined
  videoUrl = null,         // 直播画面 URL (spec §4): HLS .m3u8 (火山直播 #121) or a
                           // fixed loop; absent → simulate the feed (CSS sheen)
  winnerName = '匿名买家',  // shown on the SOLD 落槌 result page
  onViewEvidence,          // SOLD result "查看证据卡" → navigate to evidence card
  onSwitchRoom,            // optional Douyin-style vertical room switching
  switchRoomAvailable = false,
}) {
  // Follow the seller — cosmetic social toggle (no backend; the relationship
  // graph is out of V9 scope). Local state so the button visibly responds.
  const [following, setFollowing] = React.useState(() => readLocalFlag('lumen:follow:lumen-auction'));
  const [soundOn, setSoundOn] = React.useState(() => readLocalFlag('lumen:sound:enabled'));
  const [videoExpanded, setVideoExpanded] = React.useState(false);
  const [videoBroken, setVideoBroken] = React.useState(false);
  const swipeRef = React.useRef(null);
  const suppressVideoClickUntilRef = React.useRef(0);
  const audioRef = React.useRef(null);
  React.useEffect(() => {
    setVideoBroken(false);
  }, [videoUrl]);
  React.useEffect(() => {
    if (status !== 'LIVE') setVideoExpanded(false);
  }, [status]);
  const effectiveVideoUrl = videoBroken ? null : videoUrl;

  const toggleFollow = React.useCallback(() => {
    setFollowing((f) => {
      const next = !f;
      writeLocalFlag('lumen:follow:lumen-auction', next);
      return next;
    });
  }, []);

  const toggleSound = React.useCallback(() => {
    setSoundOn((on) => {
      const next = !on;
      writeLocalFlag('lumen:sound:enabled', next);
      if (next) playTone(audioRef, 'toggle');
      return next;
    });
  }, []);

  // Background color-temp ramp on the last 10s — only if asked, anchored to urgency (§9.2)
  const warn = remainingMs > 0 && remainingMs <= 10000 && status === 'LIVE';
  const biddingLocked = status !== 'LIVE' || remainingMs <= 0;
  const bg = warn && showColorRamp
    ? 'radial-gradient(ellipse at top, rgba(254,44,85,.18) 0%, var(--douyin-ink) 55%)'
    : 'var(--douyin-ink)';

  const baseLeaders = (leadersProp && leadersProp.length) ? leadersProp : DEMO_LEADERS;
  const leaders = baseLeaders.map((u, i) => ({
    ...u,
    cents: i === 0 ? currentCents : u.cents,
    combo: combos[u.userId] || 0,
  }));
  const bidHistory = ticker
    .filter((it) => it?.kind !== 'projection')
    .map((it, idx) => ({
      ...it,
      id: it?.id ?? idx,
      name: it?.name || it?.displayName || it?.userId || '匿名买家',
      cents: it?.cents || currentCents,
    }));
  const minBidCents = safeAddCents(currentCents, stepCents);
  const firstLeader = leaders[0] || null;
  const secondLeader = leaders[1] || null;

  // F23 / Elia round-2 #3: screen-shake on hammer. One-shot — flips back
  // to false ~700ms after status enters SOLD so the keyframe doesn't loop.
  const [hammerShake, setHammerShake] = React.useState(false);
  const lastStatusRef = React.useRef(status);
  React.useEffect(() => {
    if (status === 'SOLD' && lastStatusRef.current !== 'SOLD') {
      setHammerShake(true);
      const t = setTimeout(() => setHammerShake(false), 700);
      lastStatusRef.current = status;
      return () => clearTimeout(t);
    }
    lastStatusRef.current = status;
  }, [status]);
  const shakeNow = screenShake || hammerShake;

  // Bid reject toast — CN copy from bidRejectCopy[code] (§4.3 wire)
  const rejectMsg = rejectCode ? (bidRejectCopy[rejectCode] || rejectCode) : null;

  React.useEffect(() => {
    if (showLeadingToast) playTone(audioRef, 'lead', soundOn);
  }, [showLeadingToast, soundOn]);

  React.useEffect(() => {
    if (overtakeBanner) playTone(audioRef, 'overtake', soundOn);
  }, [overtakeBanner, soundOn]);

  React.useEffect(() => {
    if (status === 'SOLD') playTone(audioRef, 'hammer', soundOn);
  }, [status, soundOn]);

  const handleVideoTouchStart = React.useCallback((e) => {
    const t = e.touches?.[0];
    if (!t) return;
    swipeRef.current = { x: t.clientX, y: t.clientY, at: Date.now(), moved: false };
  }, []);

  const handleVideoTouchMove = React.useCallback((e) => {
    const t = e.touches?.[0];
    if (!t || !swipeRef.current) return;
    const dy = t.clientY - swipeRef.current.y;
    const dx = t.clientX - swipeRef.current.x;
    if (Math.abs(dy) > 18 && Math.abs(dy) > Math.abs(dx)) {
      swipeRef.current.moved = true;
    }
  }, []);

  const handleVideoTouchEnd = React.useCallback((e) => {
    const t = e.changedTouches?.[0];
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!t || !start) return;
    const dy = t.clientY - start.y;
    const dx = t.clientX - start.x;
    if (start.moved || Math.abs(dy) > 18 || Math.abs(dx) > 18) {
      suppressVideoClickUntilRef.current = Date.now() + 450;
    }
    if (switchRoomAvailable && Math.abs(dy) > 110 && Math.abs(dy) > Math.abs(dx) * 1.4) {
      e.stopPropagation();
      onSwitchRoom?.(dy > 0 ? 'prev' : 'next');
    }
  }, [onSwitchRoom, switchRoomAvailable]);

  return (
    <div className={shakeNow ? 'lumen-screen-shake' : ''} style={{
      position: 'relative', width: '100%', height: '100%',
      background: bg, color: 'var(--douyin-ink-text)',
      fontFamily: 'var(--font-sans)', overflow: 'hidden',
      transition: 'background .6s ease',
    }}>
      {/* Final-10s heartbeat vignette */}
      <HeartbeatVignette active={warn && expressive}/>

      {/* Pulse waves from price card */}
      <PulseWaves active={warn && showPulseWaves && expressive}/>

      {/* Conn bar */}
      <ConnectionBar status={connStatus} />

      {/* Bid ticker stream */}
      {expressive && ticker.length > 0 && <BidTickerStream items={ticker}/>}

      {/* Black horse banner — F13 */}
      <BlackHorseBanner visible={showBlackHorse && expressive}/>

      {/* Leading celebration toast — F06 */}
      <LeadingToast visible={showLeadingToast} gainCents="500000"/>

      {/* Reject toast — CN copy from bidRejectCopy[code] */}
      {rejectMsg && (
        <div className="lumen-slam-in" style={{
          position: 'absolute', top: 100, left: '50%', transform: 'translateX(-50%)', zIndex: 65,
          padding: '8px 14px', borderRadius: 8,
          background: 'rgba(255,77,112,.95)', color: '#fff', backdropFilter: 'blur(8px)',
          fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-sans)',
          display: 'flex', alignItems: 'center', gap: 8,
          boxShadow: '0 10px 28px rgba(255,77,112,.4)',
        }}>
          <span>✗</span>
          <span>{rejectMsg}</span>
          <span className="mono" style={{ fontSize: 10, opacity: .8 }}>{rejectCode}</span>
        </div>
      )}

      {/* Long-press bid wheel — F25 */}
      <LongPressBidWheel
        visible={showLongPress}
        currentCents={currentCents}
        stepCents="500000"
        onPick={() => {}}
        onClose={() => {}}
      />

      {/* Hammer transition (A→B) overlay — covers the room during the flip */}
      <HammerTransition active={showHammerTransition} amountCents={currentCents}/>

      {/* ── Video / streamer area ── */}
      <div
        onClick={() => {
          if (Date.now() < suppressVideoClickUntilRef.current) {
            return;
          }
          setVideoExpanded((v) => !v);
        }}
        onTouchStart={handleVideoTouchStart}
        onTouchMove={handleVideoTouchMove}
        onTouchEnd={handleVideoTouchEnd}
        style={{
          position: 'absolute',
          inset: 0,
          height: videoExpanded ? '100%' : '46%',
          overflow: 'hidden',
          zIndex: videoExpanded && status === 'LIVE' ? 72 : 0,
          cursor: 'pointer',
          transition: 'height .28s ease, box-shadow .28s ease',
          boxShadow: videoExpanded ? '0 0 0 1px rgba(201,169,97,.18), 0 20px 80px rgba(0,0,0,.7)' : 'none',
        }}>
        {/* placeholder streamer surface — gradient + faux items */}
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(160deg, #2a1f2e 0%, #1a1320 30%, #0a0e1a 100%)',
        }}>
          {/* item: a watch (SVG silhouette as placeholder) */}
          <svg viewBox="0 0 200 200" style={{
            position: 'absolute', top: '20%', left: '50%', transform: 'translateX(-50%)',
            width: 150, height: 150, opacity: .55,
          }}>
            <defs>
              <radialGradient id="watchGrad" cx="50%" cy="35%" r="60%">
                <stop offset="0%" stopColor="#3a3340"/>
                <stop offset="100%" stopColor="#0a0a10"/>
              </radialGradient>
            </defs>
            {/* strap */}
            <rect x="86" y="20" width="28" height="38" rx="4" fill="#1a1a22"/>
            <rect x="86" y="142" width="28" height="40" rx="4" fill="#1a1a22"/>
            {/* case */}
            <circle cx="100" cy="100" r="48" fill="url(#watchGrad)" stroke="#C9A961" strokeWidth="1.5" opacity=".9"/>
            <circle cx="100" cy="100" r="42" fill="#0d0d14" stroke="rgba(255,255,255,.06)"/>
            {/* hands */}
            <line x1="100" y1="100" x2="100" y2="68" stroke="#C9A961" strokeWidth="2" strokeLinecap="round"/>
            <line x1="100" y1="100" x2="125" y2="100" stroke="#dcbf7f" strokeWidth="1.5" strokeLinecap="round"/>
            <circle cx="100" cy="100" r="2" fill="#C9A961"/>
            {/* hour ticks */}
            {[0,1,2,3,4,5,6,7,8,9,10,11].map(h => {
              const a = h * Math.PI / 6;
              const x1 = 100 + Math.sin(a) * 38;
              const y1 = 100 - Math.cos(a) * 38;
              const x2 = 100 + Math.sin(a) * 41;
              const y2 = 100 - Math.cos(a) * 41;
              return <line key={h} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#9aa0b4" strokeWidth="0.8"/>;
            })}
          </svg>

          {/* very-faint noise overlay */}
          <div style={{
            position: 'absolute', inset: 0, opacity: .15,
            backgroundImage: 'radial-gradient(rgba(255,255,255,.06) 1px, transparent 1.5px)',
            backgroundSize: '8px 8px',
          }}/>
          {/* 直播画面 (spec §4). A real fixed loop plays when videoUrl is set;
              otherwise we keep the product image / SVG placeholder and simulate
              a feed with a slow sheen. Non-authoritative — never gates bidding. */}
          {effectiveVideoUrl ? (
            <LiveVideo
              url={effectiveVideoUrl}
              poster={productImage}
              onPlayFailed={() => setVideoBroken(true)}
            />
          ) : productImage ? (
            <img src={productImage} alt=""
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}/>
          ) : null}
          {/* simulated-feed sheen — only when there's no real video and we're live */}
          {!effectiveVideoUrl && status === 'LIVE' && (
            <div className="lumen-livefeed" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}/>
          )}
        </div>

        {/* Top chrome over video */}
        <div style={{
          position: 'absolute', top: 56, left: 16, right: 16,
          display: 'flex', alignItems: 'center', gap: 8, zIndex: 5,
        }}>
          {/* host pill */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '4px 10px 4px 4px', borderRadius: 999,
            background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(8px)',
          }}>
            <div style={{
              width: 26, height: 26, borderRadius: 13,
              background: 'linear-gradient(135deg,#FE2C55,#a855f7)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 11, fontWeight: 600,
            }}>琉</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ fontSize: 11, fontWeight: 600 }}>琉森拍卖行</span>
              <span style={{ fontSize: 9, color: 'var(--douyin-ink-muted)' }}>{viewerCount} 在线</span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); toggleFollow(); }}
              style={{
                minHeight: 44, padding: '0 12px', borderRadius: 999, border: 'none', cursor: 'pointer',
                background: following ? 'rgba(255,255,255,.15)' : 'var(--douyin-red)',
                color: '#fff', fontSize: 10, fontWeight: 600, marginLeft: 4,
              }}>{following ? '已关注' : '+ 关注'}</button>
          </div>
          <div style={{ flex: 1 }}/>
          <StatusBadge status={status} size="sm" />
          {/* speaker (muted per §12.7.2) — breathing icon */}
          <SpeakerToggle muted={!soundOn} onToggle={(e) => { e?.stopPropagation?.(); toggleSound(); }}/>
        </div>

        {/* item meta strip */}
        <div style={{
          position: 'absolute', top: 100, left: 16, right: 16, zIndex: 5,
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', letterSpacing: 0 }}>
            拍品 2024-0142 · 二手腕表 · 已认证
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: 0 }}>
            百达翡丽 5711/1A 鹦鹉螺 · 蓝面
          </div>
        </div>

        {/* Overtake slam — F07 */}
        {overtakeBanner && (
          <OvertakenSlam visible byName="海风_2024" gapCents="130000"/>
        )}

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setVideoExpanded((v) => !v); }}
          aria-label={videoExpanded ? '收起直播画面' : '展开直播画面'}
          title={videoExpanded ? '收起直播画面' : '展开直播画面'}
          style={{
            position: 'absolute',
            right: 16,
            bottom: videoExpanded ? 18 : 14,
            zIndex: 6,
            width: 44,
            height: 44,
            borderRadius: 22,
            border: '1px solid rgba(255,255,255,.18)',
            background: 'rgba(0,0,0,.48)',
            color: '#fff',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}>
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.6">
            {videoExpanded ? (
              <>
                <path d="M6 3H3v3M9 3h3v3M6 12H3V9M9 12h3V9" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M3 3l4 4M12 3L8 7M3 12l4-4M12 12L8 8" strokeLinecap="round"/>
              </>
            ) : (
              <>
                <path d="M6 2H2v4M9 2h4v4M6 13H2V9M9 13h4V9" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 2l5 5M13 2L8 7M2 13l5-5M13 13L8 8" strokeLinecap="round"/>
              </>
            )}
          </svg>
        </button>

        {switchRoomAvailable && (
          <div style={{
            position: 'absolute',
            right: 16,
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 6,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            color: 'rgba(255,255,255,.78)',
            fontSize: 10,
            pointerEvents: 'none',
          }}>
            <span style={{ width: 1, height: 30, background: 'linear-gradient(180deg, transparent, rgba(255,255,255,.5))' }}/>
            <span style={{ writingMode: 'vertical-rl', letterSpacing: 0 }}>上下滑切换直播间</span>
            <span style={{ width: 1, height: 30, background: 'linear-gradient(180deg, rgba(255,255,255,.5), transparent)' }}/>
          </div>
        )}
      </div>

      {/* ── Detail sheet — bottom 54% ── */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, top: '46%',
        background: 'linear-gradient(180deg, rgba(23,26,40,.18) 0%, rgba(23,26,40,.84) 9%, rgba(23,26,40,.94) 100%)',
        backdropFilter: 'blur(18px) saturate(1.18)',
        display: 'flex', flexDirection: 'column',
        padding: '12px 14px 50px',
        gap: 10, overflow: 'hidden',
      }}>
        {/* Drag handle */}
        <div style={{
          alignSelf: 'center', width: 36, height: 4, borderRadius: 2,
          background: 'rgba(255,255,255,.18)', marginBottom: -4,
        }}/>

        {/* Price + countdown row */}
        <div className={showOwnFlash ? 'lumen-gold-flash' : ''} style={{
          flexShrink: 0,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
          padding: '6px 4px 0', borderRadius: 8,
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 10, color: 'var(--douyin-ink-muted)', letterSpacing: 0 }}>
              当前价
            </span>
            <PriceDisplay cents={currentCents} size={36} tone="ink" flash={flashPrice} withUnderline/>
            <span className="mono" style={{ fontSize: 10, color: 'var(--douyin-ink-dim)', letterSpacing: 0 }}>
              {formatCentsCNYCompact(currentCents)}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: 'var(--douyin-ink-muted)', letterSpacing: 0 }}>
                {warn ? '即将落槌' : '距落槌'}
              </span>
              <ClockDriftIndicator offsetMs={serverClockOffsetMs}/>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {showHourglass && warn && (
                <SandHourglass remainingMs={remainingMs} totalMs={10000}/>
              )}
              <Countdown remainingMs={remainingMs} size="lg"/>
            </div>
          </div>
        </div>

        {/* Anti-snipe badge row — F02 */}
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px' }}>
          <ExtendBadge count={extendCount} sweep={extendSweep}/>
          <span style={{ fontSize: 10, color: 'var(--douyin-ink-muted)' }}>
            末 10s 出价自动延时
          </span>
          <div style={{ flex: 1 }}/>
          <span className="mono" style={{ fontSize: 10, color: 'var(--douyin-ink-dim)' }}>
            序列 #{lastSeq ?? '—'}
          </span>
        </div>

        {/* Buyer focus — no tab switching. Price/countdown are above, bid chips
            are pinned below; this middle stays focused on leader, my position,
            recent bids, and a collapsed rules summary. */}
        <div className="no-scrollbar" style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <BuyerFocusPanel
            leaders={leaders}
            firstLeader={firstLeader}
            secondLeader={secondLeader}
            yourRank={yourRank}
            yourGapCents={yourGapCents}
            isYouLeading={isYouLeading}
            bidHistory={bidHistory}
            lastSeq={lastSeq}
            bidsPerSec={bidsPerSec}
            bidsPerSecPeak={bidsPerSecPeak}
            minBidCents={minBidCents}
            stepCents={stepCents}
            capCents={capCents}
            extendCount={extendCount}
            aiStatus={aiStatus}
            aiTrigger={aiTrigger}
            aiText={aiText}
            aiStreaming={aiStreaming}
          />
        </div>{/* end scrollable middle */}

        {/* Bid CTA — chips replacing the single number-input (Elia #49 round-2 #2).
            onBid is called with the absolute cents string the chip computed;
            LiveRoomRoute wires it to placeBid. Pinned (flex-shrink:0) so it is
            always visible at the bottom of the panel. */}
        <div style={{ flexShrink: 0, marginTop: 8 }}>
          <QuickBidChips
            currentCents={currentCents}
            stepCents={stepCents}
            capCents={capCents}
            disabled={biddingLocked}
            isLeading={isYouLeading}
            shake={rejectShake}
            onBid={(c) => { if (!biddingLocked && onBid) onBid(c); }}
          />
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            padding: '6px 4px 0', fontSize: 10, color: 'var(--douyin-ink-dim)',
          }}>
            <span>最低加价 {formatCentsCNY(stepCents)}</span>
            <span className="mono">末 10 秒出价延时 30 秒</span>
          </div>
        </div>
      </div>

      {/* SOLD result — the 落槌 celebration. The brief HammerTransition crossfade
          (zIndex 80) plays on top, then clears (~2.2s) to reveal this (zIndex 70):
          winner + 成交价 + a 查看证据卡 button → the evidence card. Previously SOLD
          only got the crossfade and snapped back to the live layout — no result,
          no path to evidence. */}
      {status === 'SOLD' && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 70 }}>
          <MobileHammer
            amountCents={currentCents}
            winnerName={winnerName}
            onViewEvidence={onViewEvidence}
            expressive={expressive}
          />
        </div>
      )}

      {/* Terminal overlay — Elia round-2 H2 (#54). NO_BID and CANCELLED
          previously had no full-screen treatment, so a buyer who's still
          looking at the room when the timer fires saw only the StatusBadge
          flip with no clear "this ended" signal. */}
      <TerminalOverlay status={status}/>
    </div>
  );
}

// One-shot full-screen overlay for NO_BID + CANCELLED terminal states.
// Renders nothing for LIVE / SCHEDULED / DRAFT / SOLD / ORDER_CREATED.
// SOLD has its own A→B HammerTransition crossfade so we explicitly skip it.
function TerminalOverlay({ status }) {
  if (status !== 'NO_BID' && status !== 'CANCELLED') return null;
  const isNoBid = status === 'NO_BID';
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 80,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      // semi-transparent so the room hash + final price stay visible underneath
      background: isNoBid
        ? 'radial-gradient(ellipse at center, rgba(20,20,30,.92) 0%, rgba(10,10,18,.96) 70%)'
        : 'radial-gradient(ellipse at center, rgba(40,8,18,.92) 0%, rgba(10,10,18,.96) 70%)',
      backdropFilter: 'blur(2px)',
      fontFamily: 'var(--font-sans)',
      animation: 'lumen-veil-bridge-fade .4s ease-in 1 both',
    }}>
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
        padding: '28px 36px', borderRadius: 18,
        background: 'rgba(0,0,0,.35)',
        border: isNoBid
          ? '1px solid rgba(154,160,180,.25)'
          : '1px solid rgba(254,44,85,.4)',
        textAlign: 'center', maxWidth: 280,
      }}>
        <div style={{
          width: 52, height: 52, borderRadius: 26,
          background: 'rgba(0,0,0,.4)',
          border: `2px solid ${isNoBid ? 'var(--state-no-bid)' : 'var(--state-rejected)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22,
          color: isNoBid ? 'var(--state-no-bid)' : 'var(--state-rejected)',
        }}>
          {isNoBid ? '∅' : '×'}
        </div>
        <div className="serif" style={{
          fontSize: 22, fontWeight: 600,
          color: isNoBid ? 'var(--douyin-ink-text)' : 'var(--state-rejected)',
          letterSpacing: '.02em',
        }}>
          {isNoBid ? '本场无人出价' : '本场已取消'}
        </div>
        <div style={{
          fontSize: 11, color: 'var(--douyin-ink-muted)', lineHeight: 1.5,
        }}>
          {isNoBid
            ? '流拍 · 序列号已写入证据链 · 可查看证据卡'
            : '卖家终止 · 序列号已写入证据链 · 出价记录保留'}
        </div>
      </div>
    </div>
  );
}

function PanelHeader({ title, meta, right }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      padding: '0 4px 2px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        <span style={{
          fontSize: 12,
          fontWeight: 700,
          color: 'var(--douyin-ink-text)',
          letterSpacing: 0,
        }}>
          {title}
        </span>
        {meta && (
          <span style={{ fontSize: 10, color: 'var(--douyin-ink-muted)', letterSpacing: 0 }}>
            {meta}
          </span>
        )}
      </div>
      {right}
    </div>
  );
}

function BuyerFocusPanel({
  leaders,
  firstLeader,
  secondLeader,
  yourRank,
  yourGapCents,
  isYouLeading,
  bidHistory,
  lastSeq,
  bidsPerSec,
  bidsPerSecPeak,
  minBidCents,
  stepCents,
  capCents,
  extendCount,
  aiStatus,
  aiTrigger,
  aiText,
  aiStreaming,
}) {
  return (
    <>
      <PanelHeader title="当前领先" meta="前三名与我的位置" right={<HeatMeter bidsPerSec={bidsPerSec} peak={bidsPerSecPeak}/>}/>
      <CompactLeaderCard
        firstLeader={firstLeader}
        secondLeader={secondLeader}
        leaders={leaders}
        yourRank={yourRank}
        yourGapCents={yourGapCents}
        isYouLeading={isYouLeading}
      />

      <PanelHeader
        title="最近出价"
        meta={`序列 #${lastSeq ?? '—'}`}
      />
      <BidHistoryStrip items={bidHistory}/>

      <AIBubble status={aiStatus} trigger={aiTrigger} text={aiText} streaming={aiStreaming}/>

      <RulesSummary
        minBidCents={minBidCents}
        stepCents={stepCents}
        capCents={capCents}
        extendCount={extendCount}
      />
    </>
  );
}

function CompactLeaderCard({ firstLeader, secondLeader, leaders, yourRank, yourGapCents, isYouLeading }) {
  return (
    <InfoSurface accent="gold">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
        <CompactLeaderRow rank={1} leader={firstLeader} lead/>
        {secondLeader && <CompactLeaderRow rank={2} leader={secondLeader}/>}
      </div>
      <div style={{
        display: 'flex',
        gap: 8,
        overflowX: 'auto',
        paddingTop: 2,
      }} className="no-scrollbar">
        {leaders.slice(2, 5).map((leader, idx) => (
          <CompactLeaderPill key={leader.userId || idx} rank={idx + 3} leader={leader}/>
        ))}
      </div>
      <MyPositionGap
        rank={yourRank}
        gapCents={yourGapCents}
        isLeading={isYouLeading}
      />
    </InfoSurface>
  );
}

function CompactLeaderRow({ rank, leader, lead = false }) {
  const name = leader?.displayName || leader?.userId || '暂无出价';
  const cents = leader?.cents ? formatCentsCNY(leader.cents) : '—';
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '30px minmax(0, 1fr) auto',
      alignItems: 'center',
      gap: 8,
      padding: lead ? '9px 10px' : '7px 10px',
      borderRadius: 8,
      background: lead ? 'rgba(201,169,97,.13)' : 'rgba(255,255,255,.045)',
      border: lead ? '1px solid rgba(201,169,97,.34)' : '1px solid rgba(255,255,255,.08)',
    }}>
      <span className="mono" style={{
        width: 24,
        height: 24,
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: lead ? 'var(--solemn-gold)' : 'rgba(255,255,255,.10)',
        color: lead ? 'var(--solemn-ink)' : 'var(--douyin-ink-muted)',
        fontSize: 11,
        fontWeight: 800,
      }}>
        {rank}
      </span>
      <span style={{
        minWidth: 0,
        color: 'var(--douyin-ink-text)',
        fontSize: lead ? 14 : 12,
        fontWeight: lead ? 800 : 650,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {name}
      </span>
      <span className="mono" style={{
        color: lead ? 'var(--solemn-gold)' : 'var(--douyin-ink-text)',
        fontSize: lead ? 14 : 12,
        fontWeight: 800,
        whiteSpace: 'nowrap',
      }}>
        {cents}
      </span>
    </div>
  );
}

function CompactLeaderPill({ rank, leader }) {
  const name = leader?.displayName || leader?.userId || '暂无';
  const cents = leader?.cents ? formatCentsCNYCompact(leader.cents) : '—';
  return (
    <div style={{
      flex: '0 0 auto',
      minWidth: 104,
      padding: '7px 9px',
      borderRadius: 8,
      background: 'rgba(255,255,255,.04)',
      border: '1px solid rgba(255,255,255,.08)',
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
    }}>
      <span style={{ fontSize: 10, color: 'var(--douyin-ink-muted)' }}>第 {rank} 名</span>
      <span style={{
        fontSize: 11,
        color: 'var(--douyin-ink-text)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {name}
      </span>
      <span className="mono" style={{ fontSize: 11, color: 'var(--solemn-gold)', fontWeight: 700 }}>
        {cents}
      </span>
    </div>
  );
}

function RulesSummary({ minBidCents, stepCents, capCents, extendCount }) {
  return (
    <details style={{
      borderRadius: 8,
      border: '1px solid rgba(255,255,255,.08)',
      background: 'rgba(255,255,255,.035)',
      padding: '0 10px',
    }}>
      <summary style={{
        minHeight: 44,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        cursor: 'pointer',
        color: 'var(--douyin-ink-muted)',
        fontSize: 12,
        fontWeight: 700,
      }}>
        <span>规则</span>
        <span className="mono" style={{ fontSize: 10, fontWeight: 500 }}>
          最低 {formatCentsCNYCompact(minBidCents)}
        </span>
      </summary>
      <div style={{ padding: '0 0 10px', display: 'flex', flexDirection: 'column', gap: 7 }}>
        <InfoLine label="最低加价" value={formatCentsCNY(stepCents)}/>
        <InfoLine label="封顶价" value={capCents ? formatCentsCNY(capCents) : '未设置'}/>
        <InfoLine label="延时" value={`末 10 秒出价自动延时，已触发 ${extendCount || 0} 次`}/>
        <InfoLine label="判定" value="只认服务端事件，视频不参与判定"/>
      </div>
    </details>
  );
}

function InfoSurface({ children, accent = 'default' }) {
  const border = accent === 'gold'
    ? 'rgba(201,169,97,.28)'
    : accent === 'cyan'
      ? 'rgba(37,244,238,.26)'
      : 'rgba(255,255,255,.09)';
  return (
    <div style={{
      padding: '10px 11px',
      borderRadius: 8,
      background: 'rgba(255,255,255,.045)',
      border: `1px solid ${border}`,
      backdropFilter: 'blur(12px)',
      display: 'flex',
      flexDirection: 'column',
      gap: 7,
    }}>
      {children}
    </div>
  );
}

function InfoLine({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
      <span style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', flexShrink: 0 }}>{label}</span>
      <span style={{
        fontSize: 12,
        color: 'var(--douyin-ink-text)',
        textAlign: 'right',
        overflowWrap: 'anywhere',
        lineHeight: 1.35,
      }}>
        {value}
      </span>
    </div>
  );
}

// ─── Mobile · Hammer overlay (A→B accent flip) ─────────────────
function MobileHammer({ amountCents = '12880000', winnerName = '海风_2024', expressive = true, onViewEvidence }) {
  return (
    <div style={{
      position: 'relative', width: '100%', height: '100%',
      background: 'radial-gradient(ellipse at center 35%, var(--solemn-deep-card) 0%, var(--solemn-deep) 60%)',
      color: 'var(--solemn-cream)', overflow: 'hidden',
      fontFamily: 'var(--font-serif)',
    }}>
      {/* Subtle gold dust */}
      {expressive && Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="lumen-dust" style={{
          position: 'absolute', left: `${(i * 73 + 15) % 90}%`, bottom: -20,
          width: 4, height: 4, borderRadius: 2,
          background: i % 3 === 0 ? 'var(--solemn-gold-soft)' : 'var(--solemn-gold)',
          boxShadow: '0 0 8px rgba(201,169,97,.6)',
          animationDelay: `${(i * 0.23) % 2.8}s`,
        }}/>
      ))}

      {/* Top: status flip */}
      <div style={{
        position: 'absolute', top: 60, left: 0, right: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
      }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '6px 14px', borderRadius: 999,
          background: 'rgba(201,169,97,.12)', border: '1px solid rgba(201,169,97,.4)',
        }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 6l2.5 2.5L9 4" stroke="var(--solemn-gold)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className="sans" style={{
            fontSize: 11, fontWeight: 600, color: 'var(--solemn-gold)',
            letterSpacing: '.08em',
          }}>已成交</span>
        </div>
        <div className="sans" style={{ fontSize: 11, color: 'var(--solemn-cream-dim)', letterSpacing: 0 }}>
          拍品 2024-0142 · 百达翡丽 5711/1A
        </div>
      </div>

      {/* Centerpiece: serif gold price */}
      <div style={{
        position: 'absolute', top: '34%', left: 0, right: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      }}>
        <div className="sans" style={{
          fontSize: 11, color: 'var(--solemn-cream-dim)', letterSpacing: '.16em',
        }}>落槌价</div>
        <div className="mono" style={{
          fontSize: 56, fontWeight: 700, color: 'var(--solemn-gold)',
          letterSpacing: 0, lineHeight: 1,
          textShadow: '0 4px 30px rgba(201,169,97,.35)',
        }}>
          {formatCentsCNY(amountCents)}
        </div>
        <div style={{
          width: 80, height: 1, marginTop: 14,
          background: 'linear-gradient(90deg, transparent, var(--solemn-gold), transparent)',
        }}/>
        <div className="serif" style={{
          marginTop: 16, fontSize: 22, fontWeight: 500, color: 'var(--solemn-cream)',
          letterSpacing: '.02em',
        }}>{winnerName}</div>
        <div className="sans" style={{ fontSize: 11, color: 'var(--solemn-cream-dim)' }}>
          最终竞得人
        </div>
      </div>

      {/* Bottom: evidence CTA + meta */}
      <div style={{
        position: 'absolute', left: 16, right: 16, bottom: 50,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          padding: '10px 14px', borderRadius: 10,
          background: 'rgba(245,237,221,.04)', border: '1px solid rgba(201,169,97,.18)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="sans" style={{ fontSize: 9, color: 'var(--solemn-cream-dim)', letterSpacing: 0 }}>证据状态</span>
            <span style={{ fontSize: 12, color: 'var(--solemn-cream)' }}>待证据卡确认</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
            <span className="sans" style={{ fontSize: 9, color: 'var(--solemn-cream-dim)', letterSpacing: 0 }}>链头哈希</span>
            <span style={{ fontSize: 12, color: 'var(--solemn-gold)' }}>打开证据卡查看</span>
          </div>
        </div>

        <button onClick={onViewEvidence} style={{
          width: '100%', padding: '14px', borderRadius: 12,
          background: 'linear-gradient(135deg, var(--solemn-gold) 0%, var(--solemn-gold-soft) 100%)',
          color: 'var(--solemn-ink)', border: 'none',
          fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 600,
          letterSpacing: '.02em', cursor: 'pointer',
          boxShadow: '0 8px 28px rgba(201,169,97,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          查看证据卡
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 7h8M8 3l4 4-4 4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        <div className="sans" style={{
          fontSize: 10, color: 'var(--solemn-cream-dim)', textAlign: 'center',
          letterSpacing: '.04em',
        }}>
          成交结果已返回 · 服务器时序与链头哈希请以证据卡为准
        </div>
      </div>
    </div>
  );
}

// ─── Mobile · Evidence ─────────────────────────────────────────
const EVIDENCE_EVENTS = [
  { type: 'AUCTION_SCHEDULED', seq: 14002, time: '21:30:00.012', amount: null,
    prev: '0000000000000000', hash: '7e2a4c91d83b15f0' },
  { type: 'AUCTION_STARTED',   seq: 14003, time: '21:30:00.483', amount: '12000000',
    prev: '7e2a4c91d83b15f0', hash: 'a14b2f87e3091ccd' },
  { type: 'BID_ACCEPTED',      seq: 14201, time: '21:35:12.144', amount: '12200000',
    prev: 'a14b2f87e3091ccd', hash: 'c3f8d12a4b9e5601' },
  { type: 'BID_ACCEPTED',      seq: 14592, time: '21:46:08.802', amount: '12500000',
    prev: 'c3f8d12a4b9e5601', hash: '5b9e017dc4a23f88' },
  { type: 'AUCTION_EXTENDED',  seq: 14834, time: '21:47:51.601', amount: null,
    prev: '5b9e017dc4a23f88', hash: '8d24a7c91e5b0394', extendCount: 1 },
  { type: 'BID_ACCEPTED',      seq: 14912, time: '21:48:14.221', amount: '12750000',
    prev: '8d24a7c91e5b0394', hash: 'f019b4c7283d6e5a' },
  { type: 'AUCTION_EXTENDED',  seq: 14945, time: '21:48:24.110', amount: null,
    prev: 'f019b4c7283d6e5a', hash: '2c87e91a4f5b0d34', extendCount: 2 },
  { type: 'BID_ACCEPTED',      seq: 14991, time: '21:48:31.418', amount: '12880000',
    prev: '2c87e91a4f5b0d34', hash: 'b419f37c80512aed' },
  { type: 'AUCTION_SOLD',      seq: 14998, time: '21:48:33.002', amount: '12880000',
    prev: 'b419f37c80512aed', hash: '9c4f8a1027bd5b18', winner: '海风_2024' },
];

const TYPE_META = {
  AUCTION_SCHEDULED: { label: '排期已生成', color: 'var(--solemn-cream-dim)', icon: '◷' },
  AUCTION_STARTED:   { label: '开拍',         color: 'var(--state-live)',     icon: '▶' },
  BID_ACCEPTED:      { label: '出价采纳',     color: 'var(--solemn-cream)',   icon: '↑' },
  AUCTION_EXTENDED:  { label: '反狙击延时',   color: 'var(--state-extended)', icon: '⟳' },
  AUCTION_SOLD:      { label: '落槌成交',     color: 'var(--solemn-gold)',    icon: '✦' },
  AUCTION_NO_BID:    { label: '本场无人出价', color: 'var(--state-no-bid)',   icon: '·' },
  AUCTION_CANCELLED: { label: '已取消',       color: 'var(--state-cancelled)', icon: '×' },
};

// MobileEvidence — props mode-aware:
//
//  • No `evidence` prop given: renders the inline demo data (used by
//    /preview/evidence and /preview/evidence/broken). `chainBreak` and
//    `breakAtSeq` switch the demo to the broken-chain variant.
//
//  • `evidence` prop provided: renders the real evidence card from
//    GET /api/auctions/:id/evidence (see EvidenceRoute.jsx). The
//    component maps backend's timeline event shape to its own row shape
//    inside the render below — no external mapping required.
function MobileEvidence({ chainBreak = false, breakAtSeq = null, evidence = null }) {
  const isWired = evidence != null;
  const [actionHint, setActionHint] = React.useState('');
  const actionHintTimerRef = React.useRef(null);

  // Map backend timeline → component event rows. Each row needs the same
  // fields the demo array provides: { type, seq, time, amount, prev, hash,
  // extendCount?, winner? }. Backend ships { seq, eventType, payload (JSON
  // string), eventHash, prevHash }. We parse payload lazily for the per-row
  // amount / time / winner / extendCount.
  const events = isWired
    ? (evidence.timeline || []).map((e) => {
        let p = {};
        try { p = typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload || {}); } catch {}
        const ts = typeof p.serverTimeMs === 'number' ? p.serverTimeMs : null;
        return {
          type: e.eventType,
          seq: e.seq,
          time: ts ? formatHMS(ts) : '',
          amount: p.amountCents ?? null,
          prev: e.prevHash || '0000000000000000',
          hash: e.eventHash || '',
          extendCount: p.extendCount ?? undefined,
          winner: p.displayName ?? undefined,
        };
      })
    : EVIDENCE_EVENTS;

  // M5 (Elia review on #51): explicit `=== false` check, NOT `!chainVerified`.
  // The latter false-positives a CHAIN BROKEN visual when the response is
  // missing the field entirely (old backend / fetch error / schema drift /
  // partial degradation) — `!undefined === true`. We only want the red
  // alarm UI when the backend has actively reported a broken chain;
  // missing field stays neutral (no badge either way).
  const chainBroken = isWired ? (evidence.chainVerified === false) : chainBreak;
  const effectiveBreakAtSeq = chainBroken ? (isWired ? (evidence.hashBreakAtSeq ?? null) : breakAtSeq) : null;
  const breakIdx = chainBroken
    ? events.findIndex((e) => e.seq === effectiveBreakAtSeq)
    : -1;

  const headerPrice = isWired
    ? (evidence.currentPriceCents ?? '0')
    : '12880000';
  const chainHead = isWired ? (evidence.eventsHash || '') : '0x9c4f8a1027bd5b189c4f8a1027bd5b189c4f8a1027bd5b18';
  const settlement = isWired ? (evidence.settlement || null) : null;
  // Top-level winner display is currently not shown in the evidence card;
  // per-row winner comes from the AUCTION_SOLD event's payload.displayName.
  // Keeping the prop computed so future variants can use it.
  const lotTitle = isWired ? (evidence.auctionId || '—') : '百达翡丽 5711/1A · 蓝面';
  const lotId = isWired ? `拍卖ID ${(evidence.auctionId || '').slice(0, 12)}` : '拍品 2024-0142';

  const showHint = (msg) => {
    if (actionHintTimerRef.current) clearTimeout(actionHintTimerRef.current);
    setActionHint(msg);
    actionHintTimerRef.current = setTimeout(() => setActionHint(''), 1800);
  };

  const copyEvidenceJson = async () => {
    if (!isWired || !evidence) return;
    try {
      const payload = {
        auctionId: evidence.auctionId,
        chainVerified: evidence.chainVerified,
        eventsHash: evidence.eventsHash,
        hashBreakAtSeq: evidence.hashBreakAtSeq ?? null,
        settlement: evidence.settlement ?? null,
        timeline: evidence.timeline,
      };
      const text = JSON.stringify(payload, null, 2);
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showHint('证据数据已复制');
      } else {
        showHint('当前环境不支持剪贴板复制');
      }
    } catch {
      showHint('复制失败，请手动长按选择内容');
    }
  };

  React.useEffect(() => {
    return () => {
      if (actionHintTimerRef.current) {
        clearTimeout(actionHintTimerRef.current);
      }
    };
  }, []);

  const shareEvidence = async () => {
    if (!isWired) return;
    const shareUrl = typeof location !== 'undefined' ? location.href : '';
    const sharePayload = {
      title: `拍卖证据卡 · ${lotTitle}`,
      text: `拍卖 ${lotTitle} 的链式证据卡 · 最新链头 ${chainHead.slice(0, 18)}…`,
      url: shareUrl,
    };
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share(sharePayload);
        return;
      } catch {
        // user canceled or share unsupported -> fallback to copy URL
      }
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(shareUrl);
      showHint('证据链接已复制');
      return;
    }
    showHint('当前环境不支持一键分享');
  };

  // helper for mono time string from epoch-ms
  function formatHMS(ms) {
    const d = new Date(ms);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const ms3 = String(d.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms3}`;
  }

  // chainHead / lotTitle / lotId / headerPrice / events are wired below:
  // hardcoded literals in the JSX were replaced with these refs so
  // /preview/evidence still renders demo data, while EvidenceRoute
  // injects real backend data.
  return (
    <div style={{
      position: 'relative', width: '100%', height: '100%',
      background: 'var(--solemn-deep)', color: 'var(--solemn-cream)',
      fontFamily: 'var(--font-sans)', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '52px 18px 14px',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <button style={{
          width: 30, height: 30, borderRadius: 15, border: 'none',
          background: 'rgba(245,237,221,.06)', color: 'var(--solemn-cream)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M9 3L4 7l5 4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="serif" style={{ fontSize: 18, fontWeight: 500 }}>证据卡</span>
          <span style={{ fontSize: 10, color: 'var(--solemn-cream-dim)', letterSpacing: '.04em' }}>
            证据链可验证
          </span>
        </div>
        <div style={{ flex: 1 }}/>
        {/* Chain verified — or BREAK flag */}
        {chainBroken ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 999,
            background: 'rgba(254,44,85,.12)', border: '1px solid var(--state-rejected)',
          }}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M5.5 1L9 3v3c0 2-1.6 3.6-3.5 4C3.6 9.6 2 8 2 6V3l3.5-2z" stroke="var(--state-rejected)" strokeWidth="1.2" fill="rgba(254,44,85,.15)"/>
              <path d="M4 4.5L7 7.5M7 4.5L4 7.5" stroke="var(--state-rejected)" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--state-rejected)', letterSpacing: '.04em' }}>
              链已断裂
            </span>
          </div>
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 999,
            background: 'rgba(201,169,97,.12)', border: '1px solid rgba(201,169,97,.4)',
          }}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M5.5 1L9 3v3c0 2-1.6 3.6-3.5 4C3.6 9.6 2 8 2 6V3l3.5-2z" stroke="var(--solemn-gold)" strokeWidth="1.2" fill="rgba(201,169,97,.15)"/>
              <path d="M4 5.5l1.2 1.2L7.5 4.5" stroke="var(--solemn-gold)" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--solemn-gold)', letterSpacing: '.04em' }}>
              链已验证
            </span>
          </div>
        )}
      </div>

      {chainBroken && (
        <div style={{
          margin: '0 16px 12px', padding: '10px 12px', borderRadius: 8,
          background: 'rgba(254,44,85,.08)', border: '1px solid rgba(254,44,85,.35)',
          display: 'flex', gap: 10, alignItems: 'flex-start',
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, marginTop: 2 }}>
            <path d="M7 1l6 11H1L7 1zM7 5v4M7 11v.5" stroke="var(--state-rejected)" strokeWidth="1.3" strokeLinejoin="round"/>
          </svg>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--state-rejected)' }}>
              检测到哈希链断裂 · 序列 #{effectiveBreakAtSeq}
            </div>
            <div style={{ fontSize: 11, color: 'var(--solemn-cream-dim)', lineHeight: 1.5, marginTop: 4 }}>
              prev_hash 与上一条 event_hash 不匹配。该记录及之后所有事件不可信，需 Replay Verifier 复核。
            </div>
          </div>
        </div>
      )}

      {/* Summary card */}
      <div style={{
        margin: '0 16px 14px',
        padding: '14px 16px', borderRadius: 12,
        background: 'rgba(245,237,221,.04)', border: '1px solid rgba(201,169,97,.18)',
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        }}>
          <div>
            <div className="serif" style={{ fontSize: 13, color: 'var(--solemn-cream)', marginBottom: 2 }}>
              {lotTitle}
            </div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--solemn-cream-dim)' }}>
              {lotId}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="mono" style={{
              fontSize: 22, fontWeight: 700, color: 'var(--solemn-gold)',
              lineHeight: 1, letterSpacing: '-.02em',
            }}>
              {formatCentsCNY(headerPrice)}
            </div>
            <div style={{ fontSize: 10, color: 'var(--solemn-cream-dim)', marginTop: 2 }}>
              落槌价
            </div>
          </div>
        </div>
        {settlement === 'VIRTUAL_COINS_ONLY' && (
          <div style={{
            marginTop: 12,
            padding: '8px 10px',
            borderRadius: 8,
            background: 'rgba(37,244,238,.08)',
            border: '1px solid rgba(37,244,238,.28)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}>
            <span style={{
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--douyin-cyan)',
              letterSpacing: 0,
              lineHeight: 1.35,
            }}>
              虚拟币 · 非真实支付 · 非赌博
            </span>
            <span style={{
              fontSize: 10,
              color: 'var(--solemn-cream-dim)',
              lineHeight: 1.35,
              overflowWrap: 'anywhere',
            }}>
              虚拟币演示 · 无真实支付 · 非博彩
            </span>
          </div>
        )}
      </div>

      {/* Timeline / ledger */}
      <div style={{
        margin: '0 16px', padding: '6px 0',
        flex: 1, overflowY: 'auto',
      }} className="no-scrollbar">
        <div style={{
          fontSize: 10, color: 'var(--solemn-cream-dim)', letterSpacing: '.08em',
          padding: '0 4px 8px',
        }}>
          时间线 · {events.length} 条记录
        </div>
        <div style={{ position: 'relative' }}>
          {/* vertical chain line */}
          <div style={{
            position: 'absolute', left: 9, top: 14, bottom: 14, width: 1,
            background: 'linear-gradient(180deg, rgba(201,169,97,.6), rgba(201,169,97,.18))',
          }}/>
          {events.map((ev, i) => {
            const meta = TYPE_META[ev.type];
            const isBreakRow = i === breakIdx;
            const afterBreak = breakIdx >= 0 && i > breakIdx;
            return (
              <div key={ev.seq} style={{
                display: 'flex', gap: 10, position: 'relative',
                opacity: afterBreak ? 0.4 : 1,
                background: isBreakRow ? 'rgba(254,44,85,.06)' : 'transparent',
                borderRadius: isBreakRow ? 6 : 0,
                margin: isBreakRow ? '0 -8px' : 0,
                padding: isBreakRow ? '8px 8px' : '8px 0',
                border: isBreakRow ? '1px solid rgba(254,44,85,.3)' : 'none',
              }}>
                {/* node */}
                <div style={{
                  flexShrink: 0, width: 19, height: 19, borderRadius: 10,
                  background: 'var(--solemn-deep)',
                  border: `1.5px solid ${meta.color}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 9, color: meta.color, marginTop: 1,
                }}>
                  {meta.icon}
                </div>
                {/* details */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    alignItems: 'baseline', gap: 8,
                  }}>
                    <span style={{
                      fontSize: 12, fontWeight: 600, color: meta.color, letterSpacing: '.02em',
                    }}>
                      {meta.label}
                      {ev.extendCount && (
                        <span className="mono" style={{ marginLeft: 6, fontSize: 10, opacity: .8 }}>
                          ×{ev.extendCount}
                        </span>
                      )}
                    </span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--solemn-cream-dim)' }}>
                      序列 #{ev.seq}
                    </span>
                  </div>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--solemn-cream-dim)', marginTop: 1 }}>
                    {ev.time}
                    {ev.amount && <span style={{ marginLeft: 8, color: 'var(--solemn-cream)' }}>
                      {formatCentsCNY(ev.amount)}
                    </span>}
                    {ev.winner && <span style={{ marginLeft: 8, color: 'var(--solemn-cream)' }}>
                      → {ev.winner}
                    </span>}
                  </div>
                  <div style={{
                    marginTop: 4, padding: '5px 8px', borderRadius: 4,
                    background: 'rgba(0,0,0,.25)', display: 'flex',
                    alignItems: 'center', gap: 6, flexWrap: 'wrap',
                  }}>
                    <span className="mono" style={{ fontSize: 9, color: 'var(--solemn-cream-dim)' }}>上个哈希</span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--solemn-cream-dim)' }}>0x{ev.prev.slice(0,8)}</span>
                    <span style={{ color: 'var(--solemn-gold)', fontSize: 10 }}>→</span>
                    <span className="mono" style={{ fontSize: 9, color: 'var(--solemn-cream-dim)' }}>本条哈希</span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--solemn-gold)' }}>0x{ev.hash.slice(0,8)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Chain head footer */}
        <div style={{
          margin: '12px 0 50px', padding: '12px',
          borderRadius: 10, background: 'rgba(201,169,97,.06)',
          border: '1px solid rgba(201,169,97,.3)',
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 6,
          }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--solemn-gold)', letterSpacing: '.06em' }}>
              证据链头
            </span>
            <span style={{ fontSize: 9, color: 'var(--solemn-cream-dim)' }}>哈希算法</span>
          </div>
          <div className="mono" style={{
            fontSize: 11, color: 'var(--solemn-cream)', wordBreak: 'break-all',
            lineHeight: 1.5,
          }}>
            {chainHead || '—'}
          </div>
          <div style={{
            fontSize: 10, color: 'var(--solemn-cream-dim)', marginTop: 4,
            display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
          }}>
            <button
              onClick={copyEvidenceJson}
              disabled={!isWired}
              style={{
                border: '1px solid rgba(201,169,97,.35)',
                background: 'transparent',
                color: 'var(--solemn-cream)',
                padding: '3px 8px',
                borderRadius: 7,
                fontSize: 10,
              }}
            >
              复制证据数据
            </button>
            <button
              onClick={shareEvidence}
              disabled={!isWired}
              style={{
                border: '1px solid rgba(201,169,97,.35)',
                background: 'transparent',
                color: 'var(--solemn-cream)',
                padding: '3px 8px',
                borderRadius: 7,
                fontSize: 10,
              }}
            >
              分享证据链接
            </button>
            <span style={{ opacity: actionHint ? 1 : 0.75 }}>
              {actionHint || '点击复制 · 长按导出数据'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function readLocalFlag(key) {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeLocalFlag(key, value) {
  if (typeof window === 'undefined') return;
  try {
    if (value) window.localStorage.setItem(key, '1');
    else window.localStorage.removeItem(key);
  } catch {}
}

function safeAddCents(a, b) {
  try {
    return (BigInt(a) + BigInt(b)).toString();
  } catch {
    return String(a || '0');
  }
}

function playTone(audioRef, kind, enabled = true) {
  if (!enabled || typeof window === 'undefined') return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  try {
    const ctx = audioRef.current || new AudioCtx();
    audioRef.current = ctx;
    if (ctx.state === 'suspended') void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const freq = kind === 'hammer' ? 660 : kind === 'overtake' ? 220 : kind === 'lead' ? 520 : 440;
    const duration = kind === 'hammer' ? 0.18 : 0.11;
    osc.type = kind === 'overtake' ? 'sawtooth' : 'sine';
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.055, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  } catch {}
}

export {
  MobileRoom,
  MobileRoomSkeleton,
  MobileHammer,
  MobileEvidence,
  DEMO_LEADERS,
  EVIDENCE_EVENTS
};
