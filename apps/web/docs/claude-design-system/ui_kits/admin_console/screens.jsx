/* global React, Pipeline5, StatusPill, Stat, Card */
const { useState: useStateS } = React;

/* ============ VLM Review ============ */
function VLMReview() {
  const facts = [
    { k: "时代 · DYNASTY",      ai: "清乾隆", seller: { del: "清乾隆", ins: "清雍正" }, conf: 0.92, risk: true,  confirmed: true },
    { k: "工艺 · TECHNIQUE",    ai: "青花",   seller: { del: null, ins: "青花" },       conf: 0.97, risk: false, confirmed: true },
    { k: "尺寸 · DIMENSIONS",   ai: "口径 15.4cm · 高 6.8cm", seller: { del: null, ins: "口径 15.4cm · 高 6.8cm" }, conf: 0.88, risk: false, confirmed: true },
    { k: "品相 · CONDITION",    ai: "完整 · 无修补", seller: { del: "完整 · 无修补", ins: "口沿一处冲线 · 长约 8mm" }, conf: 0.71, risk: true, confirmed: false },
    { k: "来源 · PROVENANCE",   ai: "无法识别", seller: { del: null, ins: "私人旧藏 · 香港 1998" }, conf: null, risk: false, confirmed: false },
  ];
  const done = facts.filter(f => f.confirmed).length;
  return (
    <div className="page">
      <div className="page-head">
        <h1>VLM Fact Review</h1>
        <span className="tag">LOT 2026-01-088 · ITEM 青花瓷碗 · 清雍正</span>
        <div className="actions">
          <button className="btn ghost">Save draft</button>
          <button className="btn primary" disabled={done < facts.length} style={done < facts.length ? { opacity: 0.5, cursor: "not-allowed" } : null}>Confirm & schedule →</button>
        </div>
      </div>

      <Pipeline5 current="vlm"/>

      <div className="vlm-grid" style={{ marginTop: 16 }}>
        <div className="vlm-source">
          <div className="card">
            <div className="cb" style={{ padding: 10 }}>
              <div className="video">
                <div className="play">▶</div>
                <div className="tc">00:02:14 · sampled frame</div>
              </div>
              <div className="frames">
                {[1,2,3,4,5].map(n => <div key={n} className={"f" + (n === 3 ? " sel" : "")} data-n={"#" + (n + 140)}></div>)}
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--solemn-text-muted)", marginTop: 8, letterSpacing: "0.04em" }}>
                VLM · gpt-4v · sampled 5 of 312 frames · cyan border = AI-sourced (non-authoritative)
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="fact-list">
            {facts.map((f, i) => (
              <div key={i} className={"fact" + (f.risk ? " risk" : "")}>
                <div className="fh">
                  <span className="k">{f.k}</span>
                  <span className="ai-chip">AI</span>
                  {f.risk && <span className="ai-chip" style={{ background: "rgba(254,44,85,0.10)", color: "var(--douyin-red-deep)", borderColor: "rgba(254,44,85,0.4)" }}>SELLER EDIT · HIGH RISK</span>}
                  <span className="conf">{f.conf ? "conf " + f.conf.toFixed(2) : "n/a"}</span>
                </div>
                <div className="fb">
                  <div className="col">
                    <span className="ck">ai_proposed</span>
                    <span className="cv" style={{ color: "var(--solemn-text-muted)" }}>{f.ai}</span>
                  </div>
                  <div className="col diff">
                    <span className="ck">seller_confirmed</span>
                    <span className="cv">
                      {f.seller.del && <del>{f.seller.del}</del>}
                      <ins>{f.seller.ins}</ins>
                    </span>
                  </div>
                </div>
                <div className="ff">
                  {f.conf && <>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--solemn-text-muted)", letterSpacing: "0.04em" }}>CONFIDENCE</span>
                    <div className="conf-bar"><div style={{ width: (f.conf * 100) + "%" }}/></div>
                  </>}
                  {!f.conf && <span style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--solemn-text-muted)" }}>AI declined · seller-provided</span>}
                  <span className={"check" + (f.confirmed ? "" : " todo")}>{f.confirmed ? "✓" : ""}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="statement-card" style={{ marginTop: 12 }}>
            <div className="sh">
              <h4>HIGH-RISK SELLER STATEMENT · 卖家声明</h4>
              <span className="ai-chip" style={{ background: "rgba(254,44,85,0.10)", color: "var(--douyin-red-deep)", borderColor: "rgba(254,44,85,0.4)", padding: "2px 6px", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", borderRadius: 4, border: "1px solid" }}>REQUIRED</span>
            </div>
            <textarea defaultValue={"本件器物口沿处一处冲线已如实标注。所有信息均经核对，如有不符，本店全额退款并承担运费。买家拍前请仔细查看实物图与视频。"}></textarea>
          </div>

          <div className="gate">
            <div className="ginfo">
              <h4>GATE · all facts confirmed before SCHEDULED</h4>
              <p>Once 5 of 5 are confirmed and the high-risk statement is non-empty, you can move this auction to SCHEDULED. Backend will write a frozen-rules snapshot to the chain.</p>
            </div>
            <div className="gprog">{done}<span style={{ color: "var(--solemn-text-muted)", fontSize: 14, fontWeight: 500 }}> / 5</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============ Live Console ============ */
function LiveConsole({ onCancel }) {
  const bids = [
    { seq: 14998, ts: "20:48:28.901", user: "u_8842", price: 12800, kind: "HAMMER",   delta: "+10×" },
    { seq: 14997, ts: "20:48:25.430", user: "u_8842", price: 12800, kind: "BID_ACCEPTED", delta: "+10×" },
    { seq: 14996, ts: "20:48:22.310", user: "—",      price: null,  kind: "ANTI_SNIPE_EXT +5s", delta: "" },
    { seq: 14994, ts: "20:48:21.142", user: "u_7811", price: 11800, kind: "BID_ACCEPTED", delta: "+5×" },
    { seq: 14990, ts: "20:48:18.022", user: "u_4221", price: 11200, kind: "BID_ACCEPTED", delta: "+2×" },
    { seq: 14988, ts: "20:48:16.118", user: "u_3142", price: 11000, kind: "BID_ACCEPTED", delta: "+1×" },
  ];
  const rejects = [
    { seq: "—", ts: "20:48:27.512", user: "u_5520", price: 12200, code: "ERR_TOO_LOW" },
    { seq: "—", ts: "20:48:26.881", user: "u_9001", price: 12400, code: "ERR_OUT_OF_SEQ" },
    { seq: "—", ts: "20:48:24.030", user: "u_3142", price: 11700, code: "ERR_TOO_LOW" },
  ];
  return (
    <div className="page">
      <div className="page-head">
        <h1>Live Console</h1>
        <span className="tag">LOT 2026-01-088 · 青花瓷碗 · 清雍正</span>
        <StatusPill kind="live"/>
        <div className="actions">
          <button className="btn ghost">Pause AI commentary</button>
        </div>
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat lbl="Current price" val="¥12,800" sub="seq #14998 · Δ 42ms" variant="live"/>
        <Stat lbl="Time left" val="00:09" sub="extended ×2 · +10s total" variant="live"/>
        <Stat lbl="Active bidders" val="287" sub="of 8,442 connected"/>
        <Stat lbl="Bids placed" val="1,287" sub="rejects 142 · accept 1,145"/>
      </div>

      <div className="console-grid">
        <div>
          <div className="console-stream">
            <div className="overlay-top">
              <span className="live-dot">LIVE</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(245,237,221,0.7)" }}>seller cam · 1080p · 60fps</span>
              <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(245,237,221,0.7)" }}>AI offline ✕ · bids unaffected</span>
            </div>
            <div className="product-icon">
              <svg width="180" height="180" viewBox="0 0 120 120" fill="none">
                <circle cx="60" cy="60" r="42" stroke="#C9A961" strokeWidth="1.2" opacity="0.7"/>
                <circle cx="60" cy="60" r="30" stroke="#C9A961" strokeWidth="1.2"/>
                <path d="M40 78 Q60 92 80 78" stroke="#dcbf7f" strokeWidth="1.2" fill="none"/>
              </svg>
            </div>
            <div className="overlay-bot">
              <div className="price-block">
                <div className="price-lbl">CURRENT PRICE · ¥CNY</div>
                <div className="price">¥12,800.00</div>
              </div>
              <div className="timer">
                <div className="timer-lbl">LAST 10s · ANTI-SNIPE</div>
                <div className="timer-val urgent">00:09</div>
              </div>
            </div>
          </div>

          <Card title="Bid stream · authoritative" meta="Redis-Lua · Redis Stream" actions={<button className="btn sm ghost">Export</button>}>
            <div className="stream-feed">
              <table className="tbl tbl-thin">
                <thead><tr><th>SEQ</th><th>TIME</th><th>USER</th><th>EVENT</th><th>STEP</th><th>PRICE</th></tr></thead>
                <tbody>
                  {bids.map(b => (
                    <tr key={b.seq}>
                      <td className="mono">#{b.seq}</td>
                      <td className="mono" style={{ color: "var(--solemn-text-muted)" }}>{b.ts}</td>
                      <td className="mono">{b.user}</td>
                      <td><span style={{ fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: 10, letterSpacing: "0.12em", color: b.kind.startsWith("HAMMER") ? "#a3873f" : b.kind.startsWith("ANTI") ? "var(--sem-extended)" : "var(--solemn-text-soft)" }}>{b.kind}</span></td>
                      <td className="mono" style={{ color: "var(--solemn-text-muted)" }}>{b.delta}</td>
                      <td className={"mono num" + (b.kind.startsWith("HAMMER") ? " lead" : "")}>{b.price ? "¥" + b.price.toLocaleString("en-US") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div className="right-col">
          <Card title="Leaderboard" meta="top 5 bidders">
            <table className="tbl tbl-thin">
              <tbody>
                <tr><td className="mono">01</td><td>u_8842 <small style={{ color: "#a3873f", fontFamily: "var(--font-mono)", fontSize: 10 }}>· LEAD</small></td><td className="mono num lead">¥12,800</td></tr>
                <tr><td className="mono">02</td><td>u_4221</td><td className="mono num">¥11,800</td></tr>
                <tr><td className="mono">03</td><td>u_7811</td><td className="mono num">¥11,200</td></tr>
                <tr><td className="mono">04</td><td>u_3142</td><td className="mono num">¥11,000</td></tr>
                <tr><td className="mono">05</td><td>u_9001</td><td className="mono num">¥10,800</td></tr>
              </tbody>
            </table>
          </Card>

          <Card title="Last 3 rejects" meta="non-authoritative">
            <table className="tbl tbl-thin">
              <thead><tr><th>TIME</th><th>USER</th><th>TRIED</th><th>CODE</th></tr></thead>
              <tbody>
                {rejects.map((r, i) => (
                  <tr key={i}>
                    <td className="mono" style={{ color: "var(--solemn-text-muted)" }}>{r.ts}</td>
                    <td className="mono">{r.user}</td>
                    <td className="mono num rej">¥{r.price.toLocaleString("en-US")}</td>
                    <td><span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--douyin-red-deep)", fontWeight: 700, letterSpacing: "0.04em" }}>{r.code}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="danger-zone">
            <h4>⚠ Danger zone</h4>
            <p>Cancel this auction. All buyers receive <b>AUCTION_CANCELLED</b>; bid records freeze; state → <b>CANCELLED</b>; event written to evidence chain. This cannot be undone.</p>
            <button className="btn danger" onClick={onCancel}>Cancel this auction…</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============ Cancel modal ============ */
function CancelModal({ onClose }) {
  const [val, setVal] = useStateS("");
  const match = val.replace(/[^0-9.]/g, "") === "12800.00";
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="mh">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#cb203f" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          <h3>取消本场拍卖 · Cancel auction</h3>
          <span className="tag">DESTRUCTIVE · 2 STEP</span>
        </div>
        <div className="mb">
          <p style={{ marginTop: 0, fontSize: 13, color: "var(--solemn-text-soft)" }}>This will fire <b>AUCTION_CANCELLED</b> to every connected client and write a terminal event to the chain. Sellers cannot un-cancel.</p>
          <ul>
            <li>All 8,442 connected buyers receive <b>AUCTION_CANCELLED</b> push.</li>
            <li>Bid records (1,287 events) freeze in place — visible in evidence.</li>
            <li>State <b>LIVE → CANCELLED</b>. Event written to hash chain.</li>
            <li>No order is created. No settlement runs.</li>
          </ul>
          <div className="echo">
            <label>CONFIRM CURRENT PRICE</label>
            <input placeholder="¥12,800.00" value={val} onChange={e => setVal(e.target.value)} />
          </div>
        </div>
        <div className="mf">
          <button className="btn ghost" onClick={onClose}>Keep auction live</button>
          <button className="btn danger" disabled={!match} style={!match ? { opacity: 0.5, cursor: "not-allowed" } : null}>Cancel — write to chain</button>
        </div>
      </div>
    </div>
  );
}

/* ============ Publish Form ============ */
function PublishForm() {
  return (
    <div className="page">
      <div className="page-head">
        <h1>Publish item</h1>
        <span className="tag">new lot · status will be DRAFT until VLM passes</span>
        <div className="actions">
          <button className="btn ghost">Save draft</button>
          <button className="btn primary">Send for VLM review →</button>
        </div>
      </div>

      <Pipeline5 current="draft"/>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16, marginTop: 18 }}>
        <Card>
          <div className="section-h"><h3>ITEM</h3><span className="tag">required</span><div className="rule"/></div>
          <div className="form-grid">
            <div className="field full">
              <label>Title · 中英文</label>
              <div className="input"><input defaultValue="青花瓷碗 · 清雍正"/></div>
            </div>
            <div className="field">
              <label>Category</label>
              <div className="input"><input defaultValue="瓷器 · Porcelain"/></div>
            </div>
            <div className="field">
              <label>Lot code</label>
              <div className="input mono"><span className="prefix">LOT</span><input defaultValue="2026-01-088"/></div>
              <div className="hint">auto-generated · editable until VLM_REVIEW</div>
            </div>
            <div className="field full">
              <label>Description</label>
              <div className="input"><textarea rows="3" defaultValue="清雍正青花瓷碗，胎质细腻，发色沉稳，口沿一处冲线（已如实标注）。"></textarea></div>
            </div>
          </div>

          <div className="section-h"><h3>MEDIA</h3><span className="tag">≥ 1 video, ≥ 3 photos</span><div className="rule"/></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            <div style={{ aspectRatio: "1", borderRadius: 8, background: "#1f2333", border: "1px solid var(--solemn-divider)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--solemn-gold-soft)", fontSize: 22 }}>▶</div>
            <div style={{ aspectRatio: "1", borderRadius: 8, background: "#272b3d", border: "1px solid var(--solemn-divider)" }}/>
            <div style={{ aspectRatio: "1", borderRadius: 8, background: "#272b3d", border: "1px solid var(--solemn-divider)" }}/>
            <div style={{ aspectRatio: "1", borderRadius: 8, background: "#f4ecd9", border: "2px dashed var(--bridge-rose-gold)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--bridge-rose-gold)", fontSize: 22 }}>+</div>
          </div>
        </Card>

        <Card>
          <div className="section-h"><h3>AUCTION RULES</h3><span className="tag">frozen at SCHEDULED</span><div className="rule"/></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="field">
              <label>Start price · 起拍价</label>
              <div className="input mono"><span className="prefix">¥</span><input defaultValue="10,000.00"/></div>
              <div className="hint">stored as cents string · "1000000"</div>
            </div>
            <div className="field">
              <label>Increment unit · 加价单位</label>
              <div className="input mono"><span className="prefix">¥</span><input defaultValue="100.00"/></div>
            </div>
            <div className="field">
              <label>Reserve · 保留价 (hidden)</label>
              <div className="input mono"><span className="prefix">¥</span><input defaultValue="12,000.00"/></div>
            </div>
            <div className="field">
              <label>Cap · 封顶价</label>
              <div className="input mono"><span className="prefix">¥</span><input defaultValue="200,000.00"/></div>
            </div>
            <div className="field">
              <label>Anti-snipe · 反狙击</label>
              <div className="row2">
                <div className="input mono"><span className="prefix">+s</span><input defaultValue="5"/></div>
                <div className="input mono"><span className="prefix">×</span><input defaultValue="5"/></div>
              </div>
              <div className="hint">extend +5s up to 5 times</div>
            </div>
            <div className="field">
              <label>Duration · 时长 (s)</label>
              <div className="input mono"><input defaultValue="60"/></div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ============ Items & Orders ============ */
function ItemsOrders() {
  const [filter, setFilter] = useStateS("ALL");
  const filters = [
    { id: "ALL", label: "ALL", n: 42 },
    { id: "draft", label: "DRAFT", n: 6 },
    { id: "vlm", label: "VLM_REVIEW", n: 3 },
    { id: "scheduled", label: "SCHEDULED", n: 4 },
    { id: "live", label: "LIVE", n: 1 },
    { id: "sold", label: "SOLD", n: 22 },
    { id: "nobid", label: "NO_BID", n: 4 },
    { id: "cancelled", label: "CANCELLED", n: 2 },
    { id: "order", label: "ORDER_CREATED", n: 22 },
  ];
  const rows = [
    { lot: "2026-01-088", item: "青花瓷碗 · 清雍正", st: "live",      winner: "u_8842",  price: 12800, settle: "—",          time: "now"      },
    { lot: "2026-01-086", item: "粉彩花鸟纹瓶 · 清",  st: "sold",      winner: "u_4221",  price: 38600, settle: "ESCROW",     time: "20:32"    },
    { lot: "2026-01-084", item: "明永乐青花碗 · 残件", st: "nobid",     winner: "—",        price: null,  settle: "—",          time: "20:18"    },
    { lot: "2026-01-082", item: "唐三彩马 · 残修",     st: "cancelled", winner: "—",        price: null,  settle: "—",          time: "19:55"    },
    { lot: "2026-01-080", item: "宋钧窑碗 · 完整",     st: "order",     winner: "u_7811",  price: 88200, settle: "PAID",       time: "19:30"    },
    { lot: "2026-01-078", item: "清乾隆粉彩盘",       st: "scheduled", winner: "—",        price: null,  settle: "—",          time: "21:30"    },
    { lot: "2026-01-076", item: "民国浅绛山水",       st: "vlm",       winner: "—",        price: null,  settle: "—",          time: "draft"    },
    { lot: "2026-01-074", item: "清雍正白釉杯",       st: "draft",     winner: "—",        price: null,  settle: "—",          time: "draft"    },
  ];
  const filtered = filter === "ALL" ? rows : rows.filter(r => r.st === filter);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Items & Orders</h1>
        <span className="tag">org_8842 · this month</span>
        <div className="actions">
          <button className="btn ghost">Export CSV</button>
          <button className="btn primary">+ New item</button>
        </div>
      </div>

      <div className="stats" style={{ marginBottom: 18 }}>
        <Stat lbl="GMV · 本月" val="¥1,284,600" sub="+22% vs last month" variant="gold"/>
        <Stat lbl="Sold lots" val="22" sub="of 30 LIVE this month"/>
        <Stat lbl="Avg hammer · serif" val="¥58,390"/>
        <Stat lbl="Active now" val="1" sub="LOT 2026-01-088 · 287 bidders" variant="live"/>
      </div>

      <div className="filter-row">
        {filters.map(f => (
          <button key={f.id} className={"chip" + (filter === f.id ? " active" : "")} onClick={() => setFilter(f.id)}>
            {f.label}<span className="num">{f.n}</span>
          </button>
        ))}
      </div>

      <Card>
        <table className="tbl">
          <thead><tr><th>LOT</th><th>ITEM</th><th>STATUS</th><th>WINNER</th><th>HAMMER PRICE</th><th>SETTLEMENT</th><th>TIME</th></tr></thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.lot}>
                <td className="lot">{r.lot}</td>
                <td>{r.item}</td>
                <td><StatusPill kind={r.st}/></td>
                <td className="mono" style={{ color: r.winner === "—" ? "var(--solemn-text-muted)" : "inherit" }}>{r.winner}</td>
                <td className={"mono num" + (r.price ? " lead" : "")}>{r.price ? "¥" + r.price.toLocaleString("en-US") + ".00" : "—"}</td>
                <td><span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: r.settle === "—" ? "var(--solemn-text-muted)" : r.settle === "PAID" ? "#137e44" : "var(--bridge-rose-gold)", fontWeight: 600, letterSpacing: "0.06em" }}>{r.settle}</span></td>
                <td className="mono" style={{ color: "var(--solemn-text-muted)" }}>{r.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

Object.assign(window, { VLMReview, LiveConsole, CancelModal, PublishForm, ItemsOrders });
