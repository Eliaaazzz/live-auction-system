/* global React, ReactDOM, Sidebar, TopBar, VLMReview, LiveConsole, CancelModal, PublishForm, ItemsOrders */
const { useState: useStateA } = React;

const SCREENS = {
  live:  { crumbs: ["Operate", "Live Console"],     status: "live", Comp: LiveConsole },
  vlm:   { crumbs: ["Operate", "VLM Review"],       status: "ok",   Comp: VLMReview },
  pub:   { crumbs: ["Inventory", "Publish"],        status: "ok",   Comp: PublishForm },
  items: { crumbs: ["Inventory", "Items & Orders"], status: "ok",   Comp: ItemsOrders },
  evid:  { crumbs: ["Record", "Evidence Chain"],    status: "ok",   Comp: () => <Placeholder name="Evidence Chain Browser" sub="Search any LOT → full evidence timeline. Lives behind the Replay Verifier."/> },
  rep:   { crumbs: ["Record", "Replay Verifier"],   status: "ok",   Comp: () => <Placeholder name="Replay Verifier" sub="Re-runs Redis Stream against Lua script · proves backend integrity."/> },
};

function Placeholder({ name, sub }) {
  return (
    <div className="page">
      <div className="page-head"><h1>{name}</h1></div>
      <div className="card">
        <div className="cb" style={{ padding: 60, textAlign: "center", color: "var(--solemn-text-muted)" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 6 }}>NOT IN THIS KIT</div>
          <div style={{ fontSize: 13 }}>{sub}</div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [page, setPage] = useStateA("live");
  const [showCancel, setShowCancel] = useStateA(false);
  const s = SCREENS[page];
  const Comp = s.Comp;

  return (
    <>
      <div className="app">
        <Sidebar current={page} onNav={(id) => { setPage(id); setShowCancel(false); }}/>
        <TopBar crumbs={s.crumbs} status={s.status}/>
        <div className="main" data-screen-label={s.crumbs.join(" · ")}>
          {page === "live" ? <LiveConsole onCancel={() => setShowCancel(true)}/> : <Comp/>}
        </div>
      </div>
      {showCancel && <CancelModal onClose={() => setShowCancel(false)}/>}
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
