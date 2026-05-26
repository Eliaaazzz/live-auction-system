/* global React, ReactDOM,
   RoomLive, RoomLast10s, RoomBidWheel, RoomRejected, RoomLeading,
   HammerSOLD, EvidenceVerified, EvidenceBroken, Reconnect, CurtainWipe */
const { useState, useEffect, useRef } = React;

const STEPS = [
  { id: "live",        n: "01", label: "LIVE · 30s steady",     sub: "heartbeat · leaderboard",  comp: RoomLive,        b: false },
  { id: "last10",      n: "02", label: "LAST 10s · anti-snipe", sub: "ripple · color shift",     comp: RoomLast10s,     b: false },
  { id: "wheel",       n: "03", label: "BID WHEEL · long-press",sub: "+1× / +2× / +5× / +10×",   comp: RoomBidWheel,    b: false },
  { id: "rej",         n: "04", label: "BID REJECTED",          sub: "ERR_TOO_LOW · shake",      comp: RoomRejected,    b: false },
  { id: "lead",        n: "05", label: "YOU LEAD",              sub: "gold halo · keep to win",  comp: RoomLeading,     b: false },
  { id: "hammer",      n: "06", label: "HAMMER · SOLD",         sub: "0.55s A→B curtain",        comp: HammerSOLD,      b: true,  curtain: true },
  { id: "ev_ok",       n: "07", label: "EVIDENCE · verified",   sub: "chain head · 42 events",   comp: EvidenceVerified,b: true },
  { id: "ev_bad",      n: "08", label: "EVIDENCE · broken",     sub: "hash mismatch · quarantine", comp: EvidenceBroken,b: true },
  { id: "reconnect",   n: "09", label: "CONNECTION · catchup",  sub: "reconnect → sync → schema",comp: Reconnect,       b: false },
];

function App() {
  const [idx, setIdx] = useState(0);
  const [curtain, setCurtain] = useState(false);
  const [reconnectState, setReconnectState] = useState("syncing");

  const cur = STEPS[idx];
  const Comp = cur.comp;

  function go(i) {
    if (i === idx) return;
    if (STEPS[i].curtain) {
      setCurtain(true);
      setTimeout(() => setIdx(i), 320);
      setTimeout(() => setCurtain(false), 700);
    } else {
      setIdx(i);
    }
  }

  // For the reconnect step, cycle through states automatically
  useEffect(() => {
    if (cur.id !== "reconnect") return;
    const seq = ["reconnecting", "syncing", "schema", "mini"];
    let i = 0;
    setReconnectState(seq[0]);
    const t = setInterval(() => {
      i = (i + 1) % seq.length;
      setReconnectState(seq[i]);
    }, 2200);
    return () => clearInterval(t);
  }, [cur.id]);

  return (
    <div className="kit-stage">
      <div>
        <div style={{ marginBottom: 16 }}>
          <h1 className="kit-title">Mobile H5 · Bidder Room</h1>
          <div className="kit-sub">9 states · click the stepper →</div>
        </div>
        <div className="phone">
          <div className="phone-notch"></div>
          <div className={"phone-screen" + (cur.b ? " b-mode" : "")} data-screen-label={cur.n + " " + cur.label}>
            <Comp state={reconnectState}/>
            <CurtainWipe active={curtain}/>
          </div>
        </div>
      </div>

      <div className="stepper">
        <div className="kicker">Lumen Auction · mobile flow</div>
        <h2 style={{ marginTop: 4 }}>9 anchor states</h2>
        <p>Each card matches a state in the live-auction PDF reference. The hammer step triggers a 0.55s A→B curtain.</p>
        <div className="steps">
          {STEPS.map((s, i) => (
            <div key={s.id} className={"step" + (i === idx ? " active" : "")} onClick={() => go(i)}>
              <div className="n">{s.n}</div>
              <div className="label">{s.label}<small>{s.sub}</small></div>
            </div>
          ))}
        </div>
        <div className="nav">
          <button onClick={() => go(Math.max(0, idx - 1))}>← Prev</button>
          <button onClick={() => go(Math.min(STEPS.length - 1, idx + 1))}>Next →</button>
        </div>
        <div className="hint">Backend is the only authority for price / winner / timing. AI auctioneer and video copy are read-only aids. Every visible number that comes from the server (price, seq, Δ, hash) is set in <code style={{ color: "#FE2C55" }}>JetBrains&nbsp;Mono</code>.</div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
