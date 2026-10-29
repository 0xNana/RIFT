import React, { useEffect, useMemo, useState } from "react";

const ranges = [
  { id: "5m", label: "Last 5 minutes", ms: 5 * 60_000 },
  { id: "15m", label: "Last 15 minutes", ms: 15 * 60_000 },
  { id: "1h", label: "Last hour", ms: 60 * 60_000 },
];
const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function shown(value) {
  if (value == null || value === "" || (typeof value === "number" && !Number.isFinite(value))) return "—";
  return typeof value === "number" ? numberFormat.format(value) : value;
}

function timeLabel(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function severityFor(alerts = []) {
  if (!alerts.length) return "healthy";
  return alerts.some((item) => ["grandpa_lag", "beefy_lag"].includes(item.code)) ? "critical" : "warning";
}

function eventRows(series = []) {
  return [...series].reverse().map((point) => {
    const alerts = point.alerts || [];
    const severity = severityFor(alerts);
    const summary = alerts.length
      ? alerts.map((item) => item.code === "slot_gap" ? `${item.value} BABE slots skipped` : item.code === "syncing" ? item.title : `${item.code.replace("_", " ")} · ${shown(item.value)}`).join(" · ")
      : `Network update · block ${shown(point.best ?? point.blockHeight)}`;
    return { at: point.at, severity, summary, value: shown(point.best ?? point.blockHeight), alerts };
  });
}

function matchesSeverity(row, filter) {
  return filter === "all" || row.severity === filter;
}

function observedLabel(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString() : "not yet observed";
}

function DataNotice({ connection, profile, service }) {
  const isService = connection.mode === "service";
  if (connection.status === "down") return <div className="notice notice-error" role="alert"><span aria-hidden="true">!</span><p><strong>{isService ? "RIFT monitor needs attention" : "Source connection needs attention"}</strong><br />{connection.error || connection.label}{isService && connection.updatedAt ? ` · Showing saved data through ${observedLabel(connection.updatedAt)}.` : ""}</p></div>;
  if (connection.status === "stale") return <div className="notice notice-warning" role="status"><span aria-hidden="true">◷</span><p><strong>Telemetry is stale</strong><br />{isService ? `No new head within ${service?.staleAfterSeconds ?? 30} seconds. Saved data is current through ${observedLabel(connection.updatedAt)}; ${service?.observations ?? 0} observations are retained.` : "No new head arrived within the configured freshness window."}</p></div>;
  const source = isService ? "RIFT monitor service" : profile.kind === "evm" ? "Portaldot EVM RPC" : "Portaldot Substrate RPC";
  const liveCopy = isService
    ? `${connection.runtime || "Portaldot V3"} · durable history · ${service?.historyDays ?? 30}-day retention`
    : `${connection.runtime || "Network adapter"} · ${connection.endpoint}`;
  const connectingCopy = isService && connection.updatedAt
    ? `Reconnecting to ${connection.endpoint}; displayed readings are saved through ${observedLabel(connection.updatedAt)}. ${service?.observations ?? 0} observations are retained.`
    : "Live readings will appear when the monitor receives its first update.";
  return <div className="notice notice-info" role="status"><span aria-hidden="true">ⓘ</span><p><strong>{connection.status === "live" ? `${source} connected` : `Connecting to ${source}`}</strong><br />{connection.status === "live" ? liveCopy : connectingCopy}</p></div>;
}

export function Overview({ profile, monitor }) {
  const [rangeId, setRangeId] = useState("15m");
  const [seriesId, setSeriesId] = useState(profile.chartSeries[0]?.id || "");
  const [severity, setSeverity] = useState("all");
  useEffect(() => setSeriesId(profile.chartSeries[0]?.id || ""), [profile.id]);
  const rows = useMemo(() => eventRows(monitor.series).filter((row) => matchesSeverity(row, severity)).slice(0, 8), [monitor.series, severity]);

  return <>
    <DataNotice connection={monitor.connection} profile={profile} service={monitor.service} />
    <section className="metric-grid" aria-label="Network metrics">{profile.metrics.map((metric) => <MetricCard key={metric.id} metric={metric} profile={profile} metrics={monitor.metrics} />)}</section>
    <section className="content-grid">
      <TrendChart profile={profile} points={monitor.series} rangeId={rangeId} onRangeChange={setRangeId} seriesId={seriesId} onSeriesChange={setSeriesId} />
      <SourceHealth profile={profile} monitor={monitor} />
    </section>
    <HeadPosition profile={profile} metrics={monitor.metrics} />
    <section className="surface activity-surface"><header className="surface-heading"><div><h2>Recent activity</h2><p>{monitor.connection.mode === "service" ? "Persisted observations and threshold events" : "Updates and threshold events from this session"}</p></div><FilterSelect label="Activity severity" value={severity} onChange={setSeverity} options={[["all", "All events"], ["warning", "Warnings"], ["critical", "Critical"]]} /></header><EventTable rows={rows} compact /></section>
  </>;
}

function MetricCard({ metric, profile, metrics }) {
  const value = metrics[metric.id];
  let foot = metric.hint;
  if (metric.id === "grandpa" && metrics.grandpaLag != null) foot = `Lag ${shown(metrics.grandpaLag)} blocks · alert at ${profile.thresholds.grandpaLag}`;
  if (metric.id === "beefy" && metrics.beefyLag != null) foot = `Lag ${shown(metrics.beefyLag)} blocks · alert at ${profile.thresholds.beefyLag}`;
  if (metric.id === "slotGaps" && metrics.slot) foot = metrics.slot;
  if (metric.id === "syncStatus" && metrics.syncProgress != null) foot = `${metrics.syncProgress}% sync progress`;
  const valueNode = value != null && profile.blockUrl && ["best", "grandpa", "beefy"].includes(metric.id)
    ? <a className="metric-value-link" href={profile.blockUrl(value)} target="_blank" rel="noreferrer" title={metric.id === "best" ? metrics.bestHash : undefined}>{shown(value)}</a>
    : shown(value);
  return <article className={`metric-card tone-${metric.tone}`}><div className="metric-top"><span>{metric.label}</span><span className="metric-menu" aria-hidden="true">•••</span></div><strong className="metric-value">{valueNode}</strong><span className="metric-foot">{foot}</span></article>;
}

function HeadPosition({ profile, metrics }) {
  const stages = profile.trackStages.map((stage) => ({ ...stage, value: Number(metrics[stage.id]) }))
    .filter((stage) => metrics[stage.id] != null && metrics[stage.id] !== "" && Number.isFinite(stage.value));
  if (stages.length < 2) return null;
  const minimum = Math.min(...stages.map((stage) => stage.value));
  const maximum = Math.max(...stages.map((stage) => stage.value));
  const span = maximum - minimum;
  const positions = [];
  const pins = stages.map((stage) => {
    const position = span === 0 ? 50 : ((stage.value - minimum) / span) * 100;
    const offset = positions.filter((value) => Math.abs(value - position) < 5).length;
    positions.push(position);
    return { ...stage, position, top: 8 + offset * 13 };
  });
  return <section className="surface head-position"><header className="surface-heading"><div><h2>Finality position</h2><p>Current head progression across the selected network stages</p></div><span className="head-span">{shown(span)} block{span === 1 ? "" : "s"} between stages</span></header>
    <div className="head-rail" aria-hidden="true"><i />{pins.map((pin) => <span key={pin.id} style={{ left: `${pin.position}%`, top: `${pin.top}px`, background: pin.color }} />)}</div>
    <div className="head-legend">{pins.map((pin) => <div key={pin.id}><i style={{ background: pin.color }} /><span>{pin.label}</span><strong>{profile.blockUrl ? <a href={profile.blockUrl(pin.value)} target="_blank" rel="noreferrer">{shown(pin.value)}</a> : shown(pin.value)}</strong></div>)}</div>
  </section>;
}

function FilterSelect({ label, value, onChange, options, className = "" }) {
  return <label className={`filter-control ${className}`}><span className="sr-only">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>;
}

function TrendChart({ profile, points, rangeId, onRangeChange, seriesId, onSeriesChange }) {
  const range = ranges.find((item) => item.id === rangeId) || ranges[1];
  const series = profile.chartSeries.find((item) => item.id === seriesId) || profile.chartSeries[0];
  const data = points.filter((point) => point.at >= Date.now() - range.ms
    && point[series?.id] != null
    && Number.isFinite(Number(point[series?.id])));
  const values = data.map((item) => Number(item[series?.id])).filter(Number.isFinite);
  const width = 760;
  const height = 196;
  const pad = { left: 42, right: 14, top: 12, bottom: 25 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const span = Math.max(1, max - min);
  const x = (index) => pad.left + (data.length < 2 ? plotW / 2 : (index / (data.length - 1)) * plotW);
  const y = (value) => pad.top + plotH - ((value - min) / span) * plotH;
  const path = data.map((point, index) => `${x(index)},${y(Number(point[series?.id]))}`).join(" ");
  const axis = [0, 0.5, 1].map((part) => ({ value: min + span * part, y: pad.top + plotH * (1 - part) }));

  return <article className="surface chart-surface"><header className="surface-heading"><div><h2>Network activity</h2><p>{data.length ? `${data.length} observations · ${range.label.toLowerCase()}` : "Observed over the current session"}</p></div><div className="chart-filters"><FilterSelect label="Chart metric" value={series?.id || ""} onChange={onSeriesChange} options={profile.chartSeries.map((item) => [item.id, item.label])} /><FilterSelect label="Chart period" value={rangeId} onChange={onRangeChange} options={ranges.map((item) => [item.id, item.label])} /></div></header>
    {values.length === 0 ? <div className="chart-empty"><div className="chart-empty-icon">⌁</div><strong>No history yet</strong><span>Time-series data appears after the monitor receives its first update.</span></div> : <div className="chart-wrap"><svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${series.label} over the ${range.label.toLowerCase()}`} preserveAspectRatio="none">
      {axis.map((line, index) => <g key={index}><line x1={pad.left} x2={width - pad.right} y1={line.y} y2={line.y} stroke="#e7edef" strokeWidth="1" /><text x="0" y={line.y + 3} fill="#96a3a9" fontSize="10">{numberFormat.format(line.value)}</text></g>)}
      {data.length > 1 && <polyline points={`${pad.left},${pad.top + plotH} ${path} ${x(data.length - 1)},${pad.top + plotH}`} fill={`${series.color}12`} stroke="none" />}
      <polyline points={path} fill="none" stroke={series.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {data.length > 0 && <circle cx={x(data.length - 1)} cy={y(Number(data.at(-1)[series.id]))} r="4" fill={series.color}><title>Latest: {shown(Number(data.at(-1)[series.id]))}</title></circle>}
      <text x={pad.left} y={height - 3} fill="#9aa6ab" fontSize="9">{timeLabel(data[0].at)}</text><text x={width - pad.right} y={height - 3} textAnchor="end" fill="#9aa6ab" fontSize="9">{timeLabel(data.at(-1).at)}</text>
    </svg><div className="chart-legend"><i style={{ background: series.color }} /><span>{series.label}</span><strong>{shown(values.at(-1))}</strong></div></div>}
  </article>;
}

function SourceHealth({ profile, monitor }) {
  const health = monitor.connection.status === "live" ? "Healthy" : monitor.connection.status === "stale" ? "Stale" : monitor.connection.status === "down" ? "Needs attention" : "Connecting";
  return <article className="surface status-surface"><header className="surface-heading"><div><h2>Source health</h2><p>Connection and runtime details</p></div><span className={`health-badge state-${monitor.connection.status}`}>{health}</span></header>
    <div className="health-endpoint"><span className="health-dot" /><div><strong>{monitor.connection.endpoint || (profile.kind === "evm" ? "Portaldot EVM RPC" : "Portaldot Substrate RPC")}</strong><small>{monitor.connection.runtime || profile.expectedSpec}</small></div></div>
    <dl className="detail-list">{(monitor.details.length ? monitor.details : [{ label: "Network", value: profile.label }, { label: "Chain ID", value: profile.chainId }, { label: "Last update", value: "Waiting for data" }]).map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
  </article>;
}

export function ProductionPanel({ profile, monitor }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("blocks");
  if (profile.kind === "evm") return <article className="surface data-surface"><header className="surface-heading"><div><h2>EVM RPC health</h2><p>Live state reported by Portaldot’s EVM JSON-RPC endpoint.</p></div><span className={`health-badge state-${monitor.connection.status}`}>{monitor.connection.label}</span></header><DetailTable items={monitor.details} /><p className="table-note">Peer count is shown when the endpoint exposes the <code>net_peerCount</code> method.</p></article>;

  const validators = monitor.validators.filter((item) => item.account.toLowerCase().includes(query.toLowerCase())).sort((a, b) => sort === "index" ? a.index - b.index : b.blocks - a.blocks || a.index - b.index);
  const total = monitor.validators.reduce((sum, item) => sum + item.blocks, 0);
  return <section className="surface data-surface"><header className="surface-heading"><div><h2>Block production</h2><p>{monitor.validators.length} session validators · {shown(monitor.observed)} heads observed in this session</p></div><div className="table-filters"><label className="search-field"><span aria-hidden="true">⌕</span><input type="search" aria-label="Filter validators" placeholder="Filter validators" value={query} onChange={(event) => setQuery(event.target.value)} /></label><FilterSelect label="Sort validators" value={sort} onChange={setSort} options={[["blocks", "Most blocks"], ["index", "Validator index"]]} /></div></header>
    <p className="table-note">Author counts use BABE pre-digests mapped through the current session validator set. They reset when the monitor service restarts; saved network observations remain available in activity history.</p>
    <div className="table-scroll"><table><thead><tr><th>Index</th><th>Validator</th><th>Production share</th><th className="numeric">Blocks</th></tr></thead><tbody>{validators.map((row) => { const percent = total ? (row.blocks / total) * 100 : 0; return <tr key={row.account}><td>{row.index}</td><td className="validator-address" title={row.account}>{row.account}</td><td><div className="share-cell"><span className="share-track"><i style={{ width: `${percent}%` }} /></span><span>{Math.round(percent)}%</span></div></td><td className="numeric">{shown(row.blocks)}</td></tr>; })}</tbody></table>{validators.length === 0 && <div className="table-empty">{query ? "No validators match this filter" : "Waiting for validator data"}</div>}</div>
  </section>;
}

function DetailTable({ items = [] }) {
  return <div className="detail-table">{items.length ? items.map((item) => <div key={item.label}><span>{item.label}</span><strong>{item.value}</strong></div>) : <p>Waiting for the first successful source update.</p>}</div>;
}

export function ActivityPanel({ profile, monitor }) {
  const [rangeId, setRangeId] = useState("1h");
  const [severity, setSeverity] = useState("all");
  const [query, setQuery] = useState("");
  const range = ranges.find((item) => item.id === rangeId) || ranges[2];
  const rows = eventRows(monitor.series).filter((row) => Date.now() - row.at <= range.ms && matchesSeverity(row, severity) && row.summary.toLowerCase().includes(query.toLowerCase()));
  return <section className="surface data-surface"><header className="surface-heading"><div><h2>Monitoring activity</h2><p>{profile.label} · {rows.length} matching observations</p></div><div className="table-filters"><label className="search-field"><span aria-hidden="true">⌕</span><input type="search" aria-label="Search activity" placeholder="Search activity" value={query} onChange={(event) => setQuery(event.target.value)} /></label><FilterSelect label="Activity period" value={rangeId} onChange={setRangeId} options={ranges.map((item) => [item.id, item.label])} /><FilterSelect label="Activity severity" value={severity} onChange={setSeverity} options={[["all", "All events"], ["warning", "Warnings"], ["critical", "Critical"]]} /></div></header><EventTable rows={rows} /></section>;
}

function EventTable({ rows, compact = false }) {
  return <div className="table-scroll"><table className="events-table"><thead><tr><th>Severity</th><th>Event</th><th>Observed</th><th>Block</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.at}-${index}`}><td><span className={`severity-tag severity-${row.severity}`}>{row.severity}</span></td><td>{row.summary}</td><td>{timeLabel(row.at)}</td><td className="numeric">{row.value}</td></tr>)}</tbody></table>{rows.length === 0 && <div className="table-empty">{compact ? "No activity matches this filter" : "No monitoring activity in this period"}</div>}</div>;
}

export function EvmSourcePanel({ profile, connection }) {
  return <section className="surface endpoint-panel"><header className="surface-heading"><div><h2>Portaldot EVM source</h2><p>Public HTTP JSON-RPC endpoint selected by the Vite environment.</p></div><span className={`health-badge state-${connection.status}`}>{connection.label}</span></header><DetailTable items={[
    { label: "Network", value: profile.expectedChain },
    { label: "Chain ID", value: profile.chainId },
    { label: "RPC endpoint", value: connection.endpoint || "Connecting" },
    { label: "Protocol", value: profile.expectedSpec },
  ]} /><p className="table-note">The public RPC URL and chain ID come from <code>EVM_RPC</code> and <code>CHAIN_ID</code> at Vite startup.</p></section>;
}
