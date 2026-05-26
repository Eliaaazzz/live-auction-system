/* global React */
const { useState } = React;

/* ---------- Sidebar ---------- */
function Sidebar({ current, onNav }) {
  const items = [
    { id: "live",   group: "OPERATE",  label: "Live Console",  icon: "radio",    count: "1" },
    { id: "vlm",    group: "OPERATE",  label: "VLM Review",    icon: "shield",   count: "3" },
    { id: "items",  group: "INVENTORY",label: "Items & Orders",icon: "list",     count: "42" },
    { id: "pub",    group: "INVENTORY",label: "Publish",       icon: "plus",     count: null },
    { id: "evid",   group: "RECORD",   label: "Evidence Chain",icon: "link",     count: "98%" },
    { id: "rep",    group: "RECORD",   label: "Replay Verifier",icon: "check",   count: null },
  ];
  const groups = [...new Set(items.map(i => i.group))];

  function NavIcon({ name }) {
    const map = {
      radio:  <><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></>,
      shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>,
      list:   <><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></>,
      plus:   <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>,
      link:   <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></>,
      check:  <polyline points="20 6 9 17 4 12"/>,
    };
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{map[name]}</svg>;
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="mark" src="../../assets/mark-lumen.svg" alt=""/>
        <div className="title">
          <div className="lumen">Lumen</div>
          <div className="auction">AUCTION · ADMIN</div>
        </div>
      </div>
      <nav>
        {groups.map(g => (
          <React.Fragment key={g}>
            <div className="group">{g}</div>
            {items.filter(i => i.group === g).map(i => (
              <div key={i.id} className={"nav-item" + (current === i.id ? " active" : "")} onClick={() => onNav(i.id)}>
                <NavIcon name={i.icon}/>
                <span>{i.label}</span>
                {i.count && <span className="count">{i.count}</span>}
              </div>
            ))}
          </React.Fragment>
        ))}
      </nav>
      <div className="footer">
        <div className="av">EL</div>
        <div className="nm">Elia Z.<small>seller · org_8842</small></div>
      </div>
    </aside>
  );
}

/* ---------- Top bar ---------- */
function TopBar({ crumbs = [], status = "ok" }) {
  return (
    <div className="topbar">
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="sep">/</span>}
            <span className={i === crumbs.length - 1 ? "here" : ""}>{c}</span>
          </React.Fragment>
        ))}
      </div>
      <div className="filler"/>
      {status === "ok" && <div className="status-pill"><span className="dot"></span><span className="lbl">CONNECTED</span><span className="meta">seq #14998 · Δ 42ms · server 20:48:30</span></div>}
      {status === "live" && <div className="status-pill" style={{ background: "rgba(254,44,85,0.10)", borderColor: "rgba(254,44,85,0.32)" }}><span className="dot" style={{ background: "#FE2C55", boxShadow: "0 0 8px rgba(254,44,85,0.6)" }}></span><span className="lbl" style={{ color: "var(--douyin-red-deep)" }}>LIVE</span><span className="meta">8,442 connected · 287 active · ext ×2</span></div>}
    </div>
  );
}

/* ---------- 5-step pipeline ---------- */
function Pipeline5({ current = "live" }) {
  const steps = [
    { id: "draft",     label: "DRAFT" },
    { id: "vlm",       label: "VLM_REVIEW" },
    { id: "scheduled", label: "SCHEDULED" },
    { id: "live",      label: "LIVE" },
    { id: "terminal",  label: "SOLD / NO_BID" },
  ];
  const cIdx = steps.findIndex(s => s.id === current);
  return (
    <div className="pipeline">
      {steps.map((s, i) => {
        const cls = i < cIdx ? "done" : i === cIdx ? "cur" : "";
        return <div key={s.id} className={"st " + cls}><span className="n">{i + 1}</span>{s.label}</div>;
      })}
    </div>
  );
}

/* ---------- Status pill (canonical) ---------- */
function StatusPill({ kind }) {
  const labels = { draft: "DRAFT", vlm: "VLM_REVIEW", scheduled: "SCHEDULED", live: "LIVE", sold: "SOLD", nobid: "NO_BID", cancelled: "CANCELLED", order: "ORDER_CREATED" };
  return <span className={"spill " + kind}>{labels[kind]}</span>;
}

/* ---------- Stat block ---------- */
function Stat({ lbl, val, sub, variant }) {
  return (
    <div className={"stat" + (variant ? " " + variant : "")}>
      <div className="lbl">{lbl}</div>
      <div className="val">{val}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

/* ---------- Card wrapper ---------- */
function Card({ title, meta, actions, children }) {
  return (
    <div className="card">
      {(title || meta || actions) && (
        <div className="ch">
          {title && <h3>{title}</h3>}
          {meta && <span className="meta">{meta}</span>}
          {actions}
        </div>
      )}
      <div className="cb">{children}</div>
    </div>
  );
}

Object.assign(window, { Sidebar, TopBar, Pipeline5, StatusPill, Stat, Card });
