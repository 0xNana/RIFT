import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { profiles } from "./profiles.js";
import { ActivityPanel, EvmSourcePanel, Overview, ProductionPanel } from "./Dashboard.jsx";

const RegistryPanel = lazy(() => import("./RegistryPanels.jsx").then((module) => ({ default: module.RegistryPanel })));
const VerifyPanel = lazy(() => import("./RegistryPanels.jsx").then((module) => ({ default: module.VerifyPanel })));

const baseSections = [
  { id: "overview", icon: "◫" },
  { id: "production", icon: "◷" },
  { id: "registry", icon: "▤" },
  { id: "verify", icon: "✓" },
];
const copy = {
  portaldot: ["Overview", "Production", "Reports", "Verify data"],
  "portaldot-evm": ["Overview", "RPC details", "Activity", "Source config"],
};
const hints = {
  portaldot: ["Network health", "Validators and peers", "On-chain snapshots", "Payload integrity"],
  "portaldot-evm": ["EVM network health", "Public JSON-RPC", "Recent observations", "RPC endpoint"],
};

function readSection() {
  const value = location.hash.slice(1);
  return baseSections.some((item) => item.id === value) ? value : "overview";
}

function blankState(label = "Connecting") {
  return {
    connection: { status: "connecting", label, endpoint: "", runtime: "" },
    metrics: {}, series: [], validators: [], alerts: [], details: [], observed: 0,
  };
}

export default function App() {
  const [section, setSection] = useState(readSection);
  const [profileId, setProfileId] = useState("portaldot");
  const [monitor, setMonitor] = useState(() => blankState());
  const [publishedHashes, setPublishedHashes] = useState(() => new Map());
  const [now, setNow] = useState(Date.now());
  const profile = profiles[profileId];
  const nav = useMemo(() => baseSections.map((item, index) => ({
    ...item, label: copy[profileId][index], hint: hints[profileId][index],
  })), [profileId]);
  const current = nav.find((item) => item.id === section) || nav[0];
  const receiveHashes = useCallback((hashes) => setPublishedHashes(hashes), []);
  useEffect(() => {
    const sync = () => setSection(readSection());
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    window.addEventListener("hashchange", sync);
    return () => {
      window.clearInterval(clock);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let stop;
    const isSubstrate = profileId === "portaldot";
    setPublishedHashes(new Map());
    setMonitor(blankState(isSubstrate ? "Connecting to Portaldot" : "Connecting to Portaldot EVM RPC"));
    const loadAdapter = isSubstrate
      ? import("./monitor-polkadot.js")
      : import("./monitor-evm.js");
    loadAdapter.then((adapter) => {
      if (!active) return;
      stop = isSubstrate
        ? adapter.startPortaldotMonitor(setMonitor)
        : adapter.startEvmMonitor(setMonitor);
    }).catch((error) => {
      if (active) setMonitor((current) => ({ ...current, connection: { ...current.connection, status: "down", label: error.message, error: error.message } }));
    });
    return () => {
      active = false;
      stop?.();
    };
  }, [profileId]);

  const connection = monitor.connection.updatedAt && profile.thresholds.staleSeconds
    && now - monitor.connection.updatedAt > profile.thresholds.staleSeconds * 1000
    ? { ...monitor.connection, status: "stale", label: "Stale telemetry" }
    : monitor.connection;

  const exportData = () => {
    const blob = new Blob([JSON.stringify({ profile: profile.label, exportedAt: new Date().toISOString(), ...monitor }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${profile.id}-monitor-report.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" aria-label="RIFT Onchain Intelligence home"><img src="/brand/rift-mark.svg" alt="" /><span><strong>RIFT</strong><small>ONCHAIN INTELLIGENCE</small></span></a>
        <p className="nav-label">Observe</p>
        <nav className="primary-nav" aria-label="Workspace">
          {nav.map((item) => <a key={item.id} href={`#${item.id}`} aria-current={section === item.id ? "page" : undefined}><span className="nav-icon" aria-hidden="true">{item.icon}</span><span className="nav-copy"><strong>{item.label}</strong><small>{item.hint}</small></span>{item.id === "registry" && profileId === "portaldot" && <span className="nav-count">{publishedHashes.size}</span>}</a>)}
        </nav>
      </aside>

      <main id="main" className="main-content">
        <header className="topbar"><div className="breadcrumbs"><span>RIFT / {profile.family.toUpperCase()}</span><b>/</b><strong>{current.label}</strong></div><div className="topbar-tools"><label className="profile-picker"><span className="sr-only">Monitoring profile</span><select value={profileId} onChange={(event) => { setProfileId(event.target.value); setSection("overview"); location.hash = "overview"; }}><option value="portaldot">Portaldot V3 Test · Substrate</option><option value="portaldot-evm">Portaldot V3 Test · EVM</option></select></label></div></header>
        <section className="page-heading"><div><p className="eyebrow">NETWORK STATUS <span aria-hidden="true">/</span> {profile.family.toUpperCase()}</p><h1>{section === "overview" ? "Network overview" : current.label}</h1><p className="page-description">{profile.description}</p></div><div className="heading-actions"><ConnectionPill connection={connection} /><button type="button" className="button button-secondary" onClick={exportData}>Download report <span aria-hidden="true">↓</span></button></div></section>
        {section === "overview" && <Overview profile={profile} monitor={{ ...monitor, connection }} />}
        {section === "production" && <ProductionPanel profile={profile} monitor={{ ...monitor, connection }} />}
        {section === "registry" && (profileId === "portaldot" ? <Suspense fallback={<section className="surface section-placeholder">Loading registry…</section>}><RegistryPanel onHashes={receiveHashes} /></Suspense> : <ActivityPanel profile={profile} monitor={monitor} />)}
        {section === "verify" && (profileId === "portaldot" ? <Suspense fallback={<section className="surface section-placeholder">Loading verifier…</section>}><VerifyPanel publishedHashes={publishedHashes} /></Suspense> : <EvmSourcePanel profile={profile} connection={connection} />)}
      </main>
    </div>
  );
}

function ConnectionPill({ connection }) {
  const label = connection.label || "Connecting";
  return <span className={`connection-pill state-${connection.status}`} role="status"><i />{label}</span>;
}
