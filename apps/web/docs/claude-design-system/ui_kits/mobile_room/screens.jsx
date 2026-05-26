/* global React, PhoneStatusBar, LeaderRow, Toast, ConnectionStrip, BidWheel, CurtainWipe, HammerIcon */
const { useState } = React;

/* ---------- Shared room chrome (palette A) ---------- */

function RoomChrome({ countdown = "00:42", urgent = false, children, status = "LIVE" }) {
  return (
    <>
      <PhoneStatusBar dark />
      <div className="room-top">
        <div>
          <span className="badge-live">{status} · 30s</span>
          <div className="item-title" style={{ marginTop: 6 }}>青花瓷碗 · 清雍正</div>
          <div className="item-meta">LOT 2026-01-088 · seq #14998</div>
        </div>
        <div className={"countdown" + (urgent ? " urgent" : "")} style={{ position: "relative" }}>
          {countdown}
          {urgent && <div className="ripple-ring"></div>}
        </div>
      </div>
      <div className="stream">
        <span className="ai-tag">AI · 非实时仲裁 · 仅辅助解说</span>
        <div className="product-icon">
          <svg width="120" height="120" viewBox="0 0 120 120" fill="none" opacity="0.6">
            <circle cx="60" cy="60" r="42" stroke="#C9A961" strokeWidth="1.2" opacity="0.7"/>
            <circle cx="60" cy="60" r="30" stroke="#C9A961" strokeWidth="1.2"/>
            <path d="M40 78 Q60 92 80 78" stroke="#dcbf7f" strokeWidth="1.2" fill="none"/>
          </svg>
        </div>
        <div className="ai-copy">
          "清雍正青花，胎质细腻，发色沉稳…"
          <small>AI · 仅供参考 · 不作为成交依据</small>
        </div>
      </div>
      {children}
    </>
  );
}

/* ---------- 1. LIVE 30s steady ---------- */
function RoomLive() {
  return (
    <RoomChrome countdown="00:42" status="LIVE">
      <div className="leaderboard">
        <div className="section-tag"><span>实时出价 · LIVE BIDS</span><b>1,287 · 8,442 users</b></div>
        <LeaderRow rank="01" name="u_4221 · 领先" sub="HK · IOS" av="U2" bid={12800} variant="lead"/>
        <LeaderRow rank="02" name="YOU · 你" sub="距离领先 -¥320" av="YU" bid={12480} variant="self"/>
        <LeaderRow rank="03" name="u_7811" sub="BJ" av="U7" bid={12200}/>
        <LeaderRow rank="04" name="u_3142" sub="SH" av="U3" bid={11800}/>
        <LeaderRow rank="05" name="u_9001" sub="CD" av="U9" bid={11500}/>
        <LeaderRow rank="06" name="u_5520" sub="GZ" av="U5" bid={11200}/>
      </div>
      <div className="bid-bar">
        <div className="step"><b>STEP</b>+1×</div>
        <button className="place">
          <span>PLACE BID</span>
          <small>¥12,900 · long-press for step</small>
        </button>
      </div>
    </RoomChrome>
  );
}

/* ---------- 2. Last 10s anti-snipe ---------- */
function RoomLast10s() {
  return (
    <RoomChrome countdown="00:09" urgent>
      <div className="leaderboard">
        <div className="section-tag"><span style={{ color: "var(--sem-extended)" }}>⚠ LAST 10s · ANTI-SNIPE</span><b style={{ color: "var(--sem-extended)" }}>EXTENDED ×2 · +5s</b></div>
        <LeaderRow rank="01" name="u_8842 · +10× story bid" sub="black-horse · 0.4s ago" av="U8" bid={12800} variant="lead"/>
        <LeaderRow rank="02" name="u_4221" sub="prev leader" av="U2" bid={11800}/>
        <LeaderRow rank="03" name="YOU · 你" sub="距离领先 -¥1,320" av="YU" bid={11480} variant="self"/>
        <LeaderRow rank="04" name="u_7811" sub="BJ" av="U7" bid={11200}/>
      </div>
      <Toast kind="ext" code="EXTENDED +5s">最后 10 秒新出价 · 倒计时延长</Toast>
      <div className="bid-bar">
        <div className="step"><b>STEP</b>+10×</div>
        <button className="place" style={{ animation: "heartbeat 1.4s infinite var(--ease-pulse)" }}>
          <span>PLACE BID NOW</span>
          <small>¥13,800 · catch the lead</small>
        </button>
      </div>
    </RoomChrome>
  );
}

/* ---------- 3. Bid wheel (long-press) ---------- */
function RoomBidWheel() {
  return (
    <RoomChrome countdown="00:09" urgent>
      <div className="leaderboard">
        <div className="section-tag"><span>实时出价 · LIVE BIDS</span><b>1,287 · 8,442</b></div>
        <LeaderRow rank="01" name="u_8842" sub="just bid" av="U8" bid={12800} variant="lead"/>
        <LeaderRow rank="02" name="YOU" sub="-¥320" av="YU" bid={12480} variant="self"/>
      </div>
      <div className="bid-bar">
        <div className="step"><b>STEP</b>+10×</div>
        <button className="place"><span>HOLD…</span><small>release to bid</small></button>
      </div>
      <BidWheel selected="x10"/>
    </RoomChrome>
  );
}

/* ---------- 4. Bid rejected (ERR_TOO_LOW) ---------- */
function RoomRejected() {
  return (
    <RoomChrome countdown="00:09" urgent>
      <div className="leaderboard">
        <div className="section-tag"><span>实时出价 · LIVE BIDS</span><b>1,287 · 8,442</b></div>
        <LeaderRow rank="01" name="u_8842" sub="just bid" av="U8" bid={12800} variant="lead"/>
        <LeaderRow rank="—" name="YOU · ERR_TOO_LOW" sub="tried ¥12,400 against ¥12,800" av="YU" bid={12400} variant="rej"/>
        <LeaderRow rank="02" name="u_4221" sub="prev leader" av="U2" bid={11800}/>
      </div>
      <Toast kind="rej" code="ERR_TOO_LOW">出价低于当前价 ¥12,800 · 请提高出价</Toast>
      <div className="bid-bar">
        <div className="step"><b>STEP</b>+5×</div>
        <button className="place"><span>PLACE BID</span><small>¥13,300</small></button>
      </div>
    </RoomChrome>
  );
}

/* ---------- 5. YOU LEAD (gold halo) ---------- */
function RoomLeading() {
  return (
    <RoomChrome countdown="00:18" status="LIVE">
      <div className="leaderboard">
        <div className="section-tag"><span style={{ color: "var(--solemn-gold)" }}>👑 YOU LEAD · 你正在领先</span><b>1,289 · 8,447</b></div>
        <LeaderRow rank="01" name="YOU · 你 · 领先" sub="保持到落槌即得标" av="YU" bid={13800} variant="lead"/>
        <LeaderRow rank="02" name="u_8842" sub="-¥1,000" av="U8" bid={12800}/>
        <LeaderRow rank="03" name="u_4221" sub="HK" av="U2" bid={11800}/>
        <LeaderRow rank="04" name="u_7811" sub="BJ" av="U7" bid={11200}/>
      </div>
      <Toast kind="lead" code="YOU LEAD">你正在领先 · 出价 ¥13,800 · 保持到落槌</Toast>
      <div className="bid-bar">
        <div className="step"><b>STEP</b>+1×</div>
        <button className="place" style={{ background: "var(--solemn-gold)", color: "var(--solemn-deep)", boxShadow: "0 0 32px rgba(201,169,97,0.45)" }}>
          <span>RAISE TO ¥13,900</span>
          <small>(optional)</small>
        </button>
      </div>
    </RoomChrome>
  );
}

/* ---------- 6. Hammer / SOLD (palette B) ---------- */
function HammerSOLD() {
  return (
    <div className="hammer-screen">
      <PhoneStatusBar dark={false} />
      <img src="../../assets/icon-seal-verified.svg" className="seal" alt=""/>
      <div className="tag">HAMMER · SOLD · 落槌</div>
      <div className="item">青花瓷碗 · 清雍正</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--solemn-gold-soft)", marginTop: 4, letterSpacing: "0.04em" }}>LOT 2026-01-088</div>
      <div className="rule"></div>
      <div className="price">¥12,800.00</div>
      <div className="seq">
        <div><b>WINNER</b><span style={{ color: "var(--solemn-cream)" }}>u_8842 · Hong Kong</span></div>
        <div><b>SEQ</b>#14998</div>
        <div><b>Δ</b>42ms · server-time confirmed</div>
        <div><b>HASH</b>0xb2f1…01dd</div>
      </div>
      <div className="winner-row">
        <div className="av">U8</div>
        <div className="nm">u_8842<small>HK · IOS · won by +10× story bid</small></div>
      </div>
      <div className="cta">
        <button className="ghost">分享</button>
        <button className="primary">查看证据 · Evidence →</button>
      </div>
    </div>
  );
}

/* ---------- 7. Evidence verified ---------- */
function EvidenceVerified() {
  return (
    <div className="evidence">
      <PhoneStatusBar dark={false}/>
      <div className="e-head">
        <img src="../../assets/icon-seal-verified.svg" className="seal" alt="" style={{ filter: "drop-shadow(0 0 16px rgba(201,169,97,0.5))" }}/>
        <h2>证据链 · Evidence</h2>
      </div>
      <div className="tag-row">
        <span className="chip ok">CHAIN VERIFIED</span>
        <span className="chip meta">REPLAY VERIFIER · PASS</span>
        <span className="chip meta">42 EVENTS</span>
      </div>
      <div className="doc">
        <div className="ev"><span className="seq">#14990</span><span className="ts">20:48:18.022</span><span className="nm">BID_ACCEPTED<small>u_4221 · ¥11,200 · 0x0a..→0x1a..</small></span></div>
        <div className="ev"><span className="seq">#14994</span><span className="ts">20:48:21.142</span><span className="nm">BID_ACCEPTED<small>u_7811 · ¥11,800 · 0x1a..→0x4f..</small></span></div>
        <div className="ev"><span className="seq">#14996</span><span className="ts">20:48:22.310</span><span className="nm">ANTI_SNIPE_EXT +5s<small>last-10s · extended ×2 · 0x4f..→0x71..</small></span></div>
        <div className="ev"><span className="seq">#14997</span><span className="ts">20:48:25.430</span><span className="nm">BID_ACCEPTED<small>u_8842 · +10× ¥12,800 · 0x71..→0x9c..</small></span></div>
        <div className="ev"><span className="seq">#14998</span><span className="ts">20:48:28.901</span><span className="nm">HAMMER_SOLD ¥12,800.00<small>winner u_8842 · 0x9c..→0xb2..</small></span></div>
      </div>
      <div className="footer">all events Redis-Lua adjudicated · hash chain head 0xb2f1…01dd</div>
    </div>
  );
}

/* ---------- 8. Evidence broken ---------- */
function EvidenceBroken() {
  return (
    <div className="evidence">
      <PhoneStatusBar dark={false}/>
      <div className="e-head">
        <img src="../../assets/icon-seal-broken.svg" className="seal" alt=""/>
        <h2 style={{ color: "var(--douyin-red-deep)" }}>证据链 · CHAIN BROKEN</h2>
      </div>
      <div className="tag-row">
        <span className="chip broke">ERR_HASH_MISMATCH</span>
        <span className="chip broke">UNTRUSTED AFTER #14999</span>
        <span className="chip meta">REPLAY VERIFIER · INVESTIGATING</span>
      </div>
      <div className="doc">
        <div className="ev"><span className="seq">#14996</span><span className="ts">20:48:22.310</span><span className="nm">ANTI_SNIPE_EXT +5s<small>0x4f..→0x71..</small></span></div>
        <div className="ev"><span className="seq">#14997</span><span className="ts">20:48:25.430</span><span className="nm">BID_ACCEPTED<small>u_8842 · ¥12,800 · 0x71..→0x9c..</small></span></div>
        <div className="ev"><span className="seq">#14998</span><span className="ts">20:48:28.901</span><span className="nm">HAMMER_SOLD ¥12,800.00<small>0x9c..→0xb2..</small></span></div>
        <div className="ev bad"><span className="seq">#14999</span><span className="ts">20:48:29.011</span><span className="nm">ERR_HASH_MISMATCH<small>expected 0xb2.. got 0xc7..</small></span></div>
        <div className="ev bad"><span className="seq">#15000</span><span className="ts">20:48:29.110</span><span className="nm">UNTRUSTED · QUARANTINED<small>later events held for verifier review</small></span></div>
      </div>
      <div className="footer" style={{ color: "var(--douyin-red-deep)" }}>later events untrusted until Replay Verifier review · order not yet created</div>
    </div>
  );
}

/* ---------- 9. Reconnect / catchup ---------- */
function Reconnect({ state = "syncing" }) {
  return (
    <>
      <PhoneStatusBar dark/>
      <div className="room-top">
        <div>
          <span className="badge-live" style={{ background: "rgba(255,176,32,0.16)", color: "var(--sem-extended)" }}>NETWORK</span>
          <div className="item-title" style={{ marginTop: 6 }}>青花瓷碗 · 清雍正</div>
          <div className="item-meta">last seq #14922</div>
        </div>
        <div className="countdown" style={{ color: "var(--sem-extended)" }}>—:—</div>
      </div>
      <ConnectionStrip state={state}/>
      <div className="stream">
        <div className="ai-copy">
          {state === "reconnecting" && "网络抖动 · 重连中"}
          {state === "syncing" && "正在追赶事件流 #14922 → #14998"}
          {state === "schema" && "客户端版本过旧 · 请刷新"}
          {state === "mini" && "在抖音 App 内打开可获得完整体验"}
          <small>backend-authoritative · 出价不会丢失</small>
        </div>
      </div>
      <div className="leaderboard">
        <div className="section-tag"><span>本场缓存 · CACHED</span><b>up to #14922</b></div>
        <LeaderRow rank="01" name="u_4221" sub="cached" av="U2" bid={11800} variant="lead"/>
        <LeaderRow rank="02" name="YOU" sub="cached" av="YU" bid={11480} variant="self"/>
        <LeaderRow rank="03" name="u_7811" sub="cached" av="U7" bid={11200}/>
      </div>
      <div className="bid-bar">
        <div className="step"><b>STEP</b>—</div>
        <button className="place" disabled style={{ opacity: 0.5, cursor: "not-allowed" }}>
          <span>{state === "schema" ? "REFRESH REQUIRED" : "RESUMING…"}</span>
          <small>backend keeps bids · no loss</small>
        </button>
      </div>
    </>
  );
}

Object.assign(window, { RoomLive, RoomLast10s, RoomBidWheel, RoomRejected, RoomLeading, HammerSOLD, EvidenceVerified, EvidenceBroken, Reconnect });
