import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { EXPECTED_CHAIN, EXPECTED_GENESIS, EXPECTED_SPEC } from "../lib/endpoints.js";
import { createTracker, readBeefy } from "../lib/finality.js";
import { babeFromHeader } from "../lib/babe.js";
import { loadMonitorEnv } from "../lib/env.js";
import { alerts as getAlerts, lags } from "../lib/metrics.js";
import { openObservationStore } from "./observation-store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staticRoot = path.resolve(root, process.env.RIFT_BUILD_DIR || "dist");
const env = loadMonitorEnv(path.join(root, ".env"));
const host = process.env.RIFT_HOST || "127.0.0.1";
const port = integerSetting("RIFT_PORT", 4179, 1, 65535);
const retentionDays = integerSetting("RIFT_HISTORY_DAYS", 30, 1, 3650);
const staleSeconds = integerSetting("RIFT_STALE_AFTER_SECONDS", 30, 1, 3600);
const corsOrigins = new Set((process.env.RIFT_CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)
  .map((origin) => {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error("RIFT_CORS_ORIGINS must contain exact HTTP or HTTPS origins without paths");
    }
    return parsed.origin;
  }));
const thresholds = {
  grandpaLag: thresholdSetting("GRANDPA_LAG_THRESHOLD", env.grandpaLagThreshold),
  beefyLag: thresholdSetting("BEEFY_LAG_THRESHOLD", env.beefyLagThreshold),
};
const endpoint = validateEndpoint(env.substrateWs);
const dataDir = path.resolve(root, process.env.RIFT_DATA_DIR || ".data");
const databasePath = process.env.RIFT_DATABASE
  ? path.resolve(root, process.env.RIFT_DATABASE)
  : path.join(dataDir, "rift.sqlite");
const store = openObservationStore(databasePath, retentionDays);
store.prune();
const previous = store.latest();
let stopping = false;
let monitor;
let activeProvider;
let cancelActiveSession;
let wakeRetry;

function integerSetting(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value >= minimum && value <= maximum) return value;
  throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
}

function thresholdSetting(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function validateEndpoint(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("SUBSTRATE_WS must be a valid WebSocket URL");
  }
  if (!["ws:", "wss:"].includes(parsed.protocol)) throw new Error("SUBSTRATE_WS must use ws:// or wss://");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("SUBSTRATE_WS must not contain credentials, query parameters, or a fragment");
  }
  return parsed;
}

function log(level, event, extra = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level, event, ...extra })}\n`);
}

function safeMessage(error) {
  const message = error?.message || (error?.type === "error" || error?.constructor?.name === "ErrorEvent"
    ? "WebSocket connection failed"
    : error || "Unknown source error");
  return String(message)
    .split("\n")[0]
    .replace(/(?:wss?|https?):\/\/\S+/gi, "[configured endpoint]")
    .slice(0, 240);
}

function redactLibraryLogs() {
  const methods = ["debug", "error", "info", "log", "warn"];
  const redact = (text) => String(text).replace(/(?:wss?|https?):\/\/[^\s'"<>]+/gi, "[configured endpoint]");
  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = (...values) => original(...values.map((value) => value instanceof Error ? redact(value.message) : typeof value === "string" ? redact(value) : value));
  }
}

function openProvider(provider, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribeConnected = () => {};
    let unsubscribeError = () => {};
    let unsubscribeDisconnected = () => {};
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribeConnected();
      unsubscribeError();
      unsubscribeDisconnected();
      if (error) reject(error);
      else resolve();
    };
    const connected = () => finish();
    const failed = (error) => finish(
      error instanceof Error ? error : new Error(error?.message || "WebSocket connection failed"),
    );
    const timer = setTimeout(() => finish(new Error("WebSocket connection timed out")), timeoutMs);
    unsubscribeConnected = provider.on("connected", connected);
    unsubscribeError = provider.on("error", failed);
    unsubscribeDisconnected = provider.on("disconnected", failed);
    provider.connect().catch(failed);
  });
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function freshConnection(patch = {}) {
  return {
    mode: "service",
    status: "connecting",
    label: "Starting monitor",
    endpoint: endpoint.host,
    runtime: "Portaldot V3",
    updatedAt: previous?.at || undefined,
    error: "",
    ...patch,
  };
}

monitor = {
  connection: freshConnection(),
  metrics: previous?.metrics || {},
  validators: [],
  alerts: previous?.alerts || [],
  details: previous?.details || [],
  observed: 0,
  cursor: previous?.id || "0",
};

function setConnection(patch) {
  monitor = { ...monitor, connection: freshConnection({ ...monitor.connection, ...patch }) };
}

function monitorStatus() {
  const connection = monitor.connection;
  if (connection.status === "live" && connection.updatedAt && Date.now() - connection.updatedAt > staleSeconds * 1000) {
    return { ...connection, status: "stale", label: "No new head" };
  }
  return connection;
}

function serviceInfo() {
  return {
    historyDays: retentionDays,
    observations: store.count(),
    staleAfterSeconds: staleSeconds,
  };
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function apiError(res, status, code, message) {
  jsonResponse(res, status, { error: { code, message } });
}

function parseInteger(url, key, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) throw new Error(`Query parameter "${key}" must appear once`);
  if (values.length === 0) return null;
  if (!/^(0|[1-9]\d*)$/.test(values[0])) throw new Error(`Query parameter "${key}" must be a non-negative integer`);
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Query parameter "${key}" must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseObservationQuery(url) {
  const allowed = new Set(["limit", "since", "until", "before", "after"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown query parameter "${key}"`);
    if (url.searchParams.getAll(key).length !== 1) throw new Error(`Query parameter "${key}" must appear once`);
  }
  const limit = parseInteger(url, "limit", { minimum: 1, maximum: 500 }) ?? 200;
  const since = parseInteger(url, "since");
  const until = parseInteger(url, "until");
  const before = parseInteger(url, "before", { minimum: 1 });
  const after = parseInteger(url, "after");
  if (before != null && after != null) throw new Error('Use either "before" or "after", not both');
  if (since != null && until != null && since > until) throw new Error('Query parameter "since" must be earlier than "until"');
  return { limit, since, until, before, after };
}

function publicObservation(row) {
  return {
    id: row.id,
    at: row.at,
    best: row.best,
    bestHash: row.bestHash,
    grandpa: row.grandpa,
    beefy: row.beefy,
    grandpaLag: row.grandpaLag,
    beefyLag: row.beefyLag,
    slotGaps: row.slotGaps,
    alerts: row.alerts,
  };
}

function contentType(file) {
  return ({
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  })[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("bad path");
    return;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("bad path");
    return;
  }
  const requested = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = path.resolve(staticRoot, requested);
  if (!candidate.startsWith(`${staticRoot}${path.sep}`) && candidate !== staticRoot) {
    res.writeHead(404).end("not found");
    return;
  }
  const found = existsSync(candidate) && statSync(candidate).isFile();
  const file = found ? candidate : path.extname(decoded) ? null : path.join(staticRoot, "index.html");
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
    return;
  }
  if (!existsSync(file)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("Build the dashboard first with pnpm build");
    return;
  }
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    "content-type": contentType(file),
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", "http://rift.local");
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    const origin = req.headers.origin;
    if (origin && corsOrigins.has(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      if (!origin || !corsOrigins.has(origin)) {
        apiError(res, 403, "origin_not_allowed", "This browser origin is not allowed");
        return;
      }
      res.setHeader("access-control-allow-methods", "GET");
      res.setHeader("access-control-allow-headers", "Content-Type");
      res.writeHead(204, { "cache-control": "no-store" }).end();
      return;
    }
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      apiError(res, 405, "method_not_allowed", "This endpoint supports GET only");
      return;
    }
    if (url.pathname === "/api/health") {
      if ([...url.searchParams].length) {
        apiError(res, 400, "invalid_query", "This endpoint does not accept query parameters");
        return;
      }
      jsonResponse(res, 200, {
        ok: true,
        service: "RIFT",
        apiVersion: 1,
        monitor: {
          status: monitorStatus().status,
          updatedAt: monitor.connection.updatedAt || null,
          endpoint: endpoint.host,
        },
        retentionDays,
      });
      return;
    }
    if (url.pathname === "/api/v1/current") {
      if ([...url.searchParams].length) {
        apiError(res, 400, "invalid_query", "This endpoint does not accept query parameters");
        return;
      }
      jsonResponse(res, 200, {
        version: 1,
        connection: monitorStatus(),
        metrics: monitor.metrics,
        validators: monitor.validators,
        alerts: monitor.alerts,
        details: monitor.details,
        observed: monitor.observed,
        cursor: monitor.cursor,
        service: serviceInfo(),
      });
      return;
    }
    if (url.pathname === "/api/v1/observations") {
      try {
        const page = store.list(parseObservationQuery(url));
        jsonResponse(res, 200, {
          version: 1,
          observations: page.observations.map(publicObservation),
          page: page.page,
          retentionDays,
        });
      } catch (error) {
        apiError(res, 400, "invalid_query", safeMessage(error));
      }
      return;
    }
    apiError(res, 404, "not_found", "API endpoint not found");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  serveStatic(req, res, url.pathname);
}

async function runConnectedSession() {
  let api;
  let provider;
  let unsubscribeHeads;
  let unsubscribeFinalized;
  let unsubscribeProviderError = () => {};
  let unsubscribeProviderDisconnected = () => {};
  let endSession;
  let reason = "RPC disconnected";
  const ended = new Promise((resolve) => { endSession = resolve; });
  const reconnect = (error) => {
    reason = safeMessage(error || "RPC disconnected");
    endSession();
  };
  const request = (promise, label, timeoutMs = 15_000) => Promise.race([
    withTimeout(promise, timeoutMs, `${label} timed out`),
    ended.then(() => { throw new Error(reason); }),
  ]);

  try {
    await cryptoWaitReady();
    provider = new WsProvider(endpoint.toString(), false, {}, 15_000);
    activeProvider = provider;
    unsubscribeProviderError = provider.on("error", reconnect);
    unsubscribeProviderDisconnected = provider.on("disconnected", reconnect);
    cancelActiveSession = () => {
      reconnect(new Error("Monitor stopping"));
      activeProvider?.disconnect().catch(() => {});
    };
    await openProvider(provider);
    api = await withTimeout(ApiPromise.create({ provider }), 25_000, "RPC initialization timed out");
    api.on("disconnected", reconnect);
    api.on("error", reconnect);
    const chain = (await request(api.rpc.system.chain(), "Network identity read")).toString();
    const spec = api.runtimeVersion.specName.toString();
    if (chain !== EXPECTED_CHAIN || spec !== EXPECTED_SPEC) {
      throw new Error(`RPC network mismatch: expected Portaldot V3, got ${chain} / ${spec}`);
    }
    const genesis = api.genesisHash.toHex().toLowerCase();
    if (genesis !== EXPECTED_GENESIS) throw new Error(`RPC genesis mismatch: expected configured Portaldot V3 network, got ${genesis}`);
    const runtime = `${spec} · spec ${api.runtimeVersion.specVersion.toString()}`;
    const tracker = createTracker(thresholds);
    const authors = new Map();
    const finalized = await request(api.rpc.chain.getFinalizedHead(), "GRANDPA head read");
    tracker.noteGrandpa(await request(api.rpc.chain.getHeader(finalized), "GRANDPA header read"));
    setConnection({ status: "live", label: chain, runtime, connectedAt: Date.now(), error: "" });
    log("info", "source_connected", { chain, runtime, endpoint: endpoint.host });

    unsubscribeFinalized = await request(
      api.rpc.chain.subscribeFinalizedHeads((header) => tracker.noteGrandpa(header)),
      "GRANDPA subscription",
    );
    let queue = Promise.resolve();
    unsubscribeHeads = await request(api.rpc.chain.subscribeNewHeads((header) => {
      queue = queue.then(async () => {
        if (stopping) return;
        const validators = await api.query.session.validators();
        tracker.noteValidators(validators);
        const babe = babeFromHeader(api, header);
        const author = babe && validators[babe.authorityIndex] ? validators[babe.authorityIndex].toString() : null;
        if (author) authors.set(author, (authors.get(author) || 0) + 1);
        const sample = tracker.noteBest({ header, babe, author, deriveAuthor: null, currentSlot: null, genesisSlot: null, skippedEpochs: null });
        const beefy = await readBeefy(api);
        const grandpa = tracker.grandpaNumber;
        const { grandpaLag, beefyLag } = lags(sample.number, grandpa, beefy.number);
        const at = Date.now();
        const sampleAlerts = getAlerts({ grandpaLag, beefyLag, slotGap: sample.slotGap, thresholds });
        const next = {
          connection: {
            mode: "service",
            status: "live",
            label: chain,
            endpoint: endpoint.host,
            runtime,
            connectedAt: monitor.connection.connectedAt,
            updatedAt: at,
            error: "",
          },
          metrics: {
            best: String(sample.number),
            bestHash: sample.hash,
            grandpa: grandpa == null ? null : String(grandpa),
            grandpaLag,
            beefy: String(beefy.number),
            beefyLag,
            beefySet: beefy.setId,
            authorities: beefy.authorities,
            slotGaps: tracker.skippedSlots,
            slot: babe ? `${babe.kind} · slot ${babe.slot}` : "No BABE predigest on this head",
          },
          validators: validators.map((validator, index) => {
            const account = validator.toString();
            return { index, account, blocks: authors.get(account) || 0 };
          }).sort((a, b) => b.blocks - a.blocks || a.index - b.index),
          alerts: sampleAlerts,
          details: [
            { label: "Runtime", value: runtime },
            { label: "BEEFY set", value: `${beefy.setId} · ${beefy.authorities} authorities` },
            { label: "BABE slot", value: babe ? `${babe.slot} · ${babe.kind}` : "Not available" },
            { label: "Last observed", value: new Date(at).toISOString() },
          ],
          observed: tracker.observedBlocks,
          cursor: monitor.cursor,
        };
        next.cursor = store.append(next);
        monitor = next;
        store.prune();
      }).catch((error) => {
        log("error", "sample_failed", { message: safeMessage(error) });
        setConnection({ status: "down", label: "Source read failed", error: safeMessage(error) });
        reconnect(error);
      });
    }), "new-head subscription");
    await ended;
    throw new Error(reason);
  } finally {
    try { unsubscribeHeads?.(); } catch {}
    try { unsubscribeFinalized?.(); } catch {}
    if (api) {
      api.off("disconnected", reconnect);
      api.off("error", reconnect);
      await api.disconnect().catch(() => {});
    } else if (provider) await provider.disconnect().catch(() => {});
    unsubscribeProviderError();
    unsubscribeProviderDisconnected();
    if (activeProvider === provider) activeProvider = null;
    cancelActiveSession = null;
  }
}

async function monitorLoop() {
  let failures = 0;
  while (!stopping) {
    setConnection({ status: "connecting", label: failures ? "Reconnecting to Portaldot" : "Connecting to Portaldot", error: "" });
    try {
      await runConnectedSession();
      failures = 0;
    } catch (error) {
      if (stopping) break;
      failures += 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5));
      setConnection({ status: "down", label: "Reconnecting to source", error: safeMessage(error) });
      log("warn", "source_reconnect_scheduled", { attempt: failures, retryInMs: delay, message: safeMessage(error) });
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          wakeRetry = null;
          resolve();
        }, delay);
        wakeRetry = () => {
          clearTimeout(timer);
          wakeRetry = null;
          resolve();
        };
      });
    }
  }
}

if (!existsSync(staticRoot)) mkdirSync(staticRoot, { recursive: true });
redactLibraryLogs();
const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    log("error", "request_failed", { message: safeMessage(error) });
    if (!res.headersSent) apiError(res, 500, "internal_error", "The request could not be completed");
    else res.destroy();
  });
});

server.listen(port, host, () => log("info", "service_started", {
  host,
  port,
  retentionDays,
  endpoint: endpoint.host,
  previousObservations: store.count(),
}));

const monitorTask = monitorLoop().catch((error) => log("error", "monitor_stopped", { message: safeMessage(error) }));

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log("info", "shutdown_started", { signal });
  cancelActiveSession?.();
  wakeRetry?.();
  await new Promise((resolve) => server.close(resolve));
  await monitorTask;
  store.close();
  log("info", "shutdown_complete");
}

process.once("SIGINT", () => shutdown("SIGINT").then(() => process.exit(0)));
process.once("SIGTERM", () => shutdown("SIGTERM").then(() => process.exit(0)));
