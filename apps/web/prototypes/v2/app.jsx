// app.jsx — Lumen auction room app (state + composition)
const { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } = React;
// Pulled from components.jsx + effects.jsx + tweaks-panel.jsx (loaded earlier)
const {
  RULES, fmtYen, fmtYenSmall, BOTS, ME, userById, nextAmount, QUICK_LABELS,
  VideoStage, FactChip, PriceCore, TopThree, LiveFeed, FeedRow, BidButtons, HammerHint,
  BidChip, SellerControls, btnGhost, ExtendPill, TerminalOverlay, CustomDrawer, ParticleLayer,
  useRollingNumber, CountdownRing, HeatMeter, ConfettiBurst,
  useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakToggle, TweakSelect, TweakButton,
} = window;

// ─────────────────── EDIT-MODE DEFAULTS ───────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "quickBidMode": "percent",
  "topN": "podium3",
  "particles": "full",
  "audience": "buyer",
  "demoState": "live",
  "showVideo": true
}/*EDITMODE-END*/;

// ─────────────────── APP ───────────────────
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // ───── auction state ─────
  const [priceCents, setPriceCents] = useState(RULES.startCents);
  const [prevCents, setPrevCents] = useState(RULES.startCents);
  const [seq, setSeq] = useState(0);
  const [endAtMs, setEndAtMs] = useState(() => Date.now() + RULES.durationMs);
  const [extendCount, setExtendCount] = useState(0);
  const [bids, setBids] = useState([]); // {id, userId, amountCents, seq, ts}
  const [events, setEvents] = useState([]); // feed
  const [terminal, setTerminal] = useState(null); // 'SOLD'|'NO_BID'|'CANCELLED'|null
  const [winner, setWinner] = useState(null);
  const [extendTrigger, setExtendTrigger] = useState(0);
  const [lastBidId, setLastBidId] = useState(0);
  const [showCustom, setShowCustom] = useState(false);
  const [particles, setParticles] = useState([]);
  const [shake, setShake] = useState(false);
  const [snipeRipple, setSnipeRipple] = useState(0);
  const [hotBeat, setHotBeat] = useState(false);
  const [now, setNow] = useState(Date.now());

  const buttonRefs = useRef({});
  const ringRef = useRef(null);

  const registerRef = useCallback((key, el) => { buttonRefs.current[key] = el; }, []);

  // Apply tweak-driven demo state on mount/change
  useEffect(() => {
    if (t.demoState === 'live') {
      reset();
    } else if (t.demoState === 'sold') {
      reset();
      setTimeout(() => endAuction('SOLD'), 50);
    } else if (t.demoState === 'no-bid') {
      reset(true);
      setTimeout(() => endAuction('NO_BID'), 50);
    } else if (t.demoState === 'cancelled') {
      reset();
      setTimeout(() => endAuction('CANCELLED'), 50);
    } else if (t.demoState === 'extending') {
      reset();
      // jump time forward to last 6s
      setEndAtMs(Date.now() + 6000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.demoState]);

  function reset(noBids = false) {
    seqRef.current = 0;
    setPriceCents(RULES.startCents);
    priceCentsRef.current = RULES.startCents;
    setPrevCents(RULES.startCents);
    setSeq(0);
    setEndAtMs(Date.now() + RULES.durationMs);
    setExtendCount(0);
    setBids([]);
    setEvents([]);
    setTerminal(null);
    setWinner(null);
    setLastBidId(0);
  }

  // ───── clock tick ─────
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  // ───── bot scheduler ─────
  useEffect(() => {
    if (terminal || t.demoState !== 'live' && t.demoState !== 'extending') return;
    let timer;
    const sched = () => {
      const remain = endAtMs - Date.now();
      if (remain <= 0) return;
      // bots bid more aggressively near the end
      const heat = remain < 8000 ? 0.5 : remain < 20000 ? 1.0 : 1.6;
      const delay = heat * 1000 + Math.random() * heat * 1200;
      timer = setTimeout(() => {
        const bot = BOTS[Math.floor(Math.random() * BOTS.length)];
        // bot bid amount: current + 1-3% (rounded to inc)
        const mult = 1 + (0.01 + Math.random() * 0.025);
        let amt = Math.ceil((priceCentsRef.current * mult) / RULES.incrementCents) * RULES.incrementCents;
        if (amt <= priceCentsRef.current) amt = priceCentsRef.current + RULES.incrementCents;
        if (amt > RULES.capCents) amt = RULES.capCents;
        placeBid(bot.id, amt, null);
        sched();
      }, delay);
    };
    sched();
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endAtMs, terminal, t.demoState]);

  // mutable ref so the scheduler always sees the latest price + monotonic seq
  const priceCentsRef = useRef(priceCents);
  useEffect(() => { priceCentsRef.current = priceCents; }, [priceCents]);
  const seqRef = useRef(0);

  // ───── countdown → terminal ─────
  useEffect(() => {
    if (terminal) return;
    if (now >= endAtMs) {
      endAuction(bids.length > 0 ? 'SOLD' : 'NO_BID');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, endAtMs, terminal]);

  function endAuction(kind) {
    setTerminal(kind);
    setEndAtMs(Date.now());
    if (kind === 'SOLD') {
      const ranked = rankBidders(bids.length > 0 ? bids : [{ userId: 'usr_yuu', amountCents: priceCents, seq: 1 }]);
      const top = ranked[0];
      setWinner(top.userId);
      setShake(true); setTimeout(() => setShake(false), 600);
      const newSeq = ++seqRef.current;
      setSeq(newSeq);
      pushEvent({ kind:'sold', userId: top.userId, amount: top.amountCents, seq: newSeq });
    }
  }

  // ───── place bid (shared) ─────
  function placeBid(userId, amount, fromRect) {
    if (terminal) return;
    const remain = endAtMs - Date.now();
    if (remain <= 0) return;

    const newSeq = ++seqRef.current;
    setPrevCents(priceCentsRef.current);
    setPriceCents(amount);
    priceCentsRef.current = amount;
    setSeq(newSeq);

    const bidId = Date.now() + Math.random();
    setLastBidId(bidId);
    const bid = { id: bidId, userId, amountCents: amount, seq: newSeq, ts: Date.now() };
    setBids((prev) => [...prev, bid]);
    pushEvent({ kind:'bid', userId, amount, seq: newSeq });

    // extend?
    if (remain < RULES.extendWindowMs && extendCount < RULES.maxExtensions) {
      setEndAtMs(Date.now() + RULES.extendMs);
      setExtendCount((n) => n + 1);
      setExtendTrigger((n) => n + 1);
      pushEvent({ kind:'extend', sec: RULES.extendMs/1000, seq: newSeq });
      setSnipeRipple((n) => n + 1);
    }

    setHotBeat(true);
    setTimeout(() => setHotBeat(false), 700);

    // particle: from button to price (user bid)
    if (userId === 'me' && fromRect && t.particles !== 'off' && ringRef.current) {
      const toR = ringRef.current.getBoundingClientRect();
      const toRect = { x: toR.left, y: toR.top + 30, w: toR.width, h: 60 };
      const delta = amount - priceCentsRef.current;
      addParticle(fromRect, toRect, `+${fmtYenSmall(Math.max(delta, amount - prevCents))}`, 'oklch(0.78 0.21 40)');
    }
    // bot bids: small particle origin near podium
    if (userId !== 'me' && t.particles === 'full' && ringRef.current) {
      const ring = ringRef.current.getBoundingClientRect();
      const fr = { x: ring.left + ring.width/2 + (Math.random()-.5)*200, y: ring.top + 200 + Math.random()*60, w: 0, h: 0 };
      const toRect = { x: ring.left, y: ring.top + 30, w: ring.width, h: 60 };
      const u = userById(userId);
      addParticle(fr, toRect, `+${fmtYenSmall(amount - prevCents)}`, u.color);
    }
  }
  function addParticle(from, to, label, color) {
    const id = Math.random();
    setParticles((p) => [...p, { id, from, to, label, color }]);
  }

  function pushEvent(e) {
    setEvents((prev) => [{ ...e, id: Math.random() }, ...prev].slice(0, 20));
  }

  // ───── user bid ─────
  function userBid(amount, sourceKey) {
    const fromEl = buttonRefs.current[sourceKey];
    const r = fromEl ? fromEl.getBoundingClientRect() : null;
    const fromRect = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
    placeBid('me', amount, fromRect);
  }

  // ───── derived ─────
  const remainMs = Math.max(0, endAtMs - now);
  const totalMs = RULES.durationMs; // base for ring; doesn't fully reflect extends, but reads cleanly
  const ranked = useMemo(() => rankBidders(bids), [bids]);
  const leaderId = ranked[0]?.userId || null;
  const inLast10 = remainMs < 10_000 && !terminal;

  // bids per second (heat)
  const bps = useMemo(() => {
    const tnow = now;
    const recent = bids.filter(b => tnow - b.ts < 5000).length;
    return recent / 5;
  }, [bids, now]);

  return (
    <div style={{
      transform: shake ? 'translate(0,0)' : 'translate(0,0)',
      animation: shake ? 'shakeit .6s' : 'none',
    }}>
      <div className="room" style={{
        // sniper ripple shows as a brief inner red ring
      }}>
        <VideoStage show={t.showVideo} productName="Patek Vintage 1995 · ref 3940G" terminal={terminal} />
        {/* Sniper ripple */}
        {snipeRipple > 0 && (
          <div key={snipeRipple} style={{
            position:'absolute', inset:0, pointerEvents:'none',
            boxShadow:'inset 0 0 0 0 var(--hot)',
            animation:'snipeFlash .9s ease-out',
            zIndex: 30,
          }}>
            <style>{`
              @keyframes snipeFlash {
                0%{box-shadow: inset 0 0 0 0 oklch(0.74 0.19 36 / .6)}
                40%{box-shadow: inset 0 0 80px 6px oklch(0.74 0.19 36 / .35)}
                100%{box-shadow: inset 0 0 0 0 transparent}
              }
            `}</style>
          </div>
        )}
        <ExtendPill trigger={extendTrigger} />
        <PriceCore
          priceCents={priceCents}
          prevCents={prevCents}
          leaderId={leaderId}
          remainMs={remainMs}
          totalMs={totalMs}
          extendCount={extendCount}
          lastBidId={lastBidId}
          hot={inLast10}
          ringRef={ringRef}
        />
        {/* heat row */}
        <div style={{
          padding:'10px 20px', borderBottom:'1px solid var(--line)',
          display:'flex', alignItems:'center', justifyContent:'space-between',
        }}>
          <HeatMeter bps={bps} />
          <span style={{
            fontFamily:'var(--mono)', fontSize:10, color:'var(--ink-3)', letterSpacing:'.1em',
          }}>seq · {String(seq).padStart(3,'0')}</span>
        </div>
        {/* podium or list */}
        {t.topN === 'leader' ? (
          <LeaderOnly ranked={ranked} />
        ) : t.topN === 'list5' ? (
          <TopList ranked={ranked} n={5} />
        ) : (
          <TopThree ranked={ranked} leaderId={leaderId} />
        )}
        <LiveFeed events={events} />
        <BidButtons
          onBid={userBid}
          current={priceCents}
          mode={t.quickBidMode}
          disabled={!!terminal}
          registerRef={registerRef}
          audience={t.audience}
          openCustom={() => setShowCustom(true)}
          hotBeat={hotBeat}
        />
        <TerminalOverlay terminal={terminal} winner={winner} amount={priceCents} />
        {terminal === 'SOLD' && t.particles !== 'off' && <ConfettiBurst on={true} />}
        <CustomDrawer
          open={showCustom}
          current={priceCents}
          onClose={() => setShowCustom(false)}
          onSubmit={(amt) => { setShowCustom(false); userBid(amt, 'custom'); }}
        />
      </div>
      <ParticleLayer particles={particles} onRetire={(id) => setParticles((p) => p.filter(x => x.id !== id))} />

      <TweaksPanel>
        <TweakSection label="Quick-bid set" />
        <TweakRadio label="模式 Mode" value={t.quickBidMode}
                    options={['percent','absolute','increment']}
                    onChange={(v) => setTweak('quickBidMode', v)} />
        <TweakSection label="Bidders panel" />
        <TweakRadio label="Top-N display" value={t.topN}
                    options={['podium3','list5','leader']}
                    onChange={(v) => setTweak('topN', v)} />
        <TweakSection label="Vibe" />
        <TweakRadio label="Particles" value={t.particles}
                    options={['off','subtle','full']}
                    onChange={(v) => setTweak('particles', v)} />
        <TweakToggle label="Video feed (auctioneer)" value={t.showVideo}
                     onChange={(v) => setTweak('showVideo', v)} />
        <TweakSection label="Role" />
        <TweakRadio label="Audience" value={t.audience}
                    options={['buyer','seller']}
                    onChange={(v) => setTweak('audience', v)} />
        <TweakSection label="Demo state" />
        <TweakSelect label="Auction state" value={t.demoState}
                     options={['live','extending','sold','no-bid','cancelled']}
                     onChange={(v) => setTweak('demoState', v)} />
        <TweakButton label="Restart" onClick={() => setTweak('demoState', 'live')} />
      </TweaksPanel>
      <style>{`
        @keyframes shakeit {
          0%,100%{transform:translate(0,0)}
          15%{transform:translate(-6px,-2px)}
          30%{transform:translate(5px,3px)}
          45%{transform:translate(-4px,2px)}
          60%{transform:translate(3px,-3px)}
          75%{transform:translate(-2px,1px)}
          90%{transform:translate(1px,-1px)}
        }
      `}</style>
    </div>
  );
}

// ─────────────────── HELPERS ───────────────────
function rankBidders(bids) {
  const byUser = new Map();
  for (const b of bids) {
    const cur = byUser.get(b.userId);
    if (!cur || b.amountCents > cur.amountCents) byUser.set(b.userId, b);
  }
  return [...byUser.values()].sort((a, b) => b.amountCents - a.amountCents);
}

function LeaderOnly({ ranked }) {
  const leader = ranked[0];
  return (
    <div style={{padding:'18px 20px 16px', borderBottom:'1px solid var(--line)'}}>
      <div style={{fontFamily:'var(--mono)', fontSize:10, letterSpacing:'.18em', color:'var(--ink-3)', textTransform:'uppercase', marginBottom:10}}>
        领先者 · CURRENT LEADER
      </div>
      {leader ? (
        <div style={{display:'flex', alignItems:'center', gap:12}}>
          <div style={{
            width:48, height:48, borderRadius:'50%',
            background: userById(leader.userId).color,
            boxShadow:'0 0 0 3px var(--gold), 0 0 24px var(--gold)',
            display:'grid', placeItems:'center',
            fontFamily:'var(--display)', fontWeight:700, fontSize:18, color:'#0c0a14',
          }}>{userById(leader.userId).name[0]}</div>
          <div>
            <div style={{fontFamily:'var(--display)', fontWeight:600, fontSize:16}}>
              {leader.userId === 'me' ? '你 (YOU)' : userById(leader.userId).name}
            </div>
            <div style={{fontFamily:'var(--mono)', fontSize:11, color:'var(--ink-3)'}}>
              @ {fmtYen(leader.amountCents)} · seq {leader.seq}
            </div>
          </div>
          <div style={{marginLeft:'auto'}}>
            <div style={{
              fontFamily:'var(--display)', fontWeight:700, fontSize:24, color:'var(--gold)',
            }}>#1</div>
          </div>
        </div>
      ) : (
        <div style={{color:'var(--ink-3)', fontSize:12}}>无出价</div>
      )}
    </div>
  );
}
function TopList({ ranked, n }) {
  const list = ranked.slice(0, n);
  return (
    <div style={{padding:'14px 20px 12px', borderBottom:'1px solid var(--line)'}}>
      <div style={{fontFamily:'var(--mono)', fontSize:10, letterSpacing:'.18em', color:'var(--ink-3)', textTransform:'uppercase', marginBottom:8}}>
        TOP {n} · 排行
      </div>
      <div style={{display:'flex', flexDirection:'column'}}>
        {list.map((entry, i) => {
          const u = userById(entry.userId);
          const me = entry.userId === 'me';
          return (
            <div key={entry.userId} style={{
              display:'flex', alignItems:'center', gap:10,
              padding:'6px 0', borderBottom: i === list.length-1 ? 'none' : '1px solid var(--line)',
            }}>
              <span style={{
                width:18, fontFamily:'var(--mono)', fontSize:11,
                color: i < 3 ? ['var(--gold)','var(--silver)','var(--bronze)'][i] : 'var(--ink-4)',
                fontWeight:600,
              }}>{i+1}</span>
              <span style={{
                width:22, height:22, borderRadius:'50%', background:u.color,
                display:'grid', placeItems:'center', fontFamily:'var(--display)', fontWeight:700, fontSize:10, color:'#0c0a14',
              }}>{u.name[0]}</span>
              <span style={{flex:1, fontSize:12, color: me ? 'var(--jade)' : 'var(--ink-1)', fontWeight: me ? 600 : 500}}>
                {me ? '你' : u.name}
              </span>
              <span style={{fontFamily:'var(--mono)', fontSize:12, color:'var(--ink-1)'}}>{fmtYen(entry.amountCents)}</span>
            </div>
          );
        })}
        {list.length === 0 && <div style={{fontSize:12, color:'var(--ink-3)'}}>等待首个出价…</div>}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
