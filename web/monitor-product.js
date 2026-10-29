const HISTORY_LIMIT = 500;
const POLL_INTERVAL_MS = 3_000;
const MAX_POINTS = 600;
const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");

function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

async function readJson(url) {
  const response = await fetch(apiUrl(url), { cache: "no-store" });
  const type = response.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new Error("RIFT service returned an unexpected response");
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || `RIFT service returned ${response.status}`);
  return body;
}

export async function hasProductService() {
  try {
    const response = await fetch(apiUrl("/api/health"), { cache: "no-store" });
    if (!(response.headers.get("content-type") || "").includes("application/json")) return false;
    const body = await response.json();
    return response.ok && body.service === "RIFT" && body.apiVersion === 1;
  } catch {
    return false;
  }
}

function historyPoint(row) {
  return {
    at: row.at,
    best: row.best,
    bestHash: row.bestHash,
    grandpa: row.grandpa,
    beefy: row.beefy,
    grandpaLag: row.grandpaLag,
    beefyLag: row.beefyLag,
    slotGaps: row.slotGaps,
    alerts: row.alerts || [],
    id: row.id,
  };
}

function monitorState(current, series) {
  return {
    connection: { ...current.connection, mode: "service" },
    metrics: current.metrics || {},
    series: series.slice(-MAX_POINTS),
    validators: current.validators || [],
    alerts: current.alerts || [],
    details: current.details || [],
    observed: current.observed || 0,
    service: current.service || null,
  };
}

export function startProductMonitor(onChange) {
  let active = true;
  let inFlight = false;
  let cursor = "0";
  let series = [];
  let timer;

  const refresh = async (initial = false) => {
    const current = await readJson("/api/v1/current");
    if (current.version !== 1) throw new Error("Unsupported RIFT API version");
    if (initial) {
      const page = await readJson(`/api/v1/observations?limit=${HISTORY_LIMIT}`);
      series = page.observations.map(historyPoint);
      if (page.page?.hasMore && series.length < MAX_POINTS) {
        const older = await readJson(`/api/v1/observations?before=${encodeURIComponent(series[0]?.id || "1")}&limit=${MAX_POINTS - series.length}`);
        series = [...older.observations.map(historyPoint), ...series].slice(-MAX_POINTS);
      }
      cursor = series.at(-1)?.id || current.cursor || "0";
    } else {
      let hasMore = true;
      let pages = 0;
      while (hasMore && pages < 10) {
        const page = await readJson(`/api/v1/observations?after=${encodeURIComponent(cursor)}&limit=${HISTORY_LIMIT}`);
        const next = page.observations || [];
        if (!next.length) break;
        series = [...series, ...next.map(historyPoint)].slice(-MAX_POINTS);
        cursor = next.at(-1).id;
        hasMore = page.page?.hasMore === true;
        pages += 1;
      }
    }
    if (active) onChange(monitorState(current, series));
  };

  const update = async () => {
    if (!active || inFlight) return;
    inFlight = true;
    try {
      await refresh(false);
    } catch (error) {
      if (active) onChange((current) => ({
        ...current,
        connection: {
          ...current.connection,
          mode: "service",
          status: "down",
          label: "RIFT service unavailable",
          error: error.message,
        },
      }));
    } finally {
      inFlight = false;
      if (active) timer = window.setTimeout(update, POLL_INTERVAL_MS);
    }
  };

  refresh(true).then(() => {
    if (active) timer = window.setTimeout(update, POLL_INTERVAL_MS);
  }).catch((error) => {
    if (active) onChange((current) => ({
      ...current,
      connection: { ...current.connection, mode: "service", status: "down", label: "RIFT service unavailable", error: error.message },
    }));
    if (active) timer = window.setTimeout(update, POLL_INTERVAL_MS);
  });

  return () => {
    active = false;
    if (timer) window.clearTimeout(timer);
  };
}
