import { ApiPromise, WsProvider } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { Contract, JsonRpcProvider, keccak256, toUtf8Bytes } from "ethers";
import {
  SUBSTRATE_WS as DEFAULT_SUBSTRATE_WS,
  EVM_RPC,
  CHAIN_ID,
  SCANNER,
  DEFAULT_THRESHOLDS,
  EXPECTED_CHAIN,
  EXPECTED_SPEC,
  EXPECTED_GENESIS,
} from "../lib/endpoints.js";
import { babeFromHeader } from "../lib/babe.js";
import { createTracker, readBeefy } from "../lib/finality.js";
import { alerts, lags } from "../lib/metrics.js";
import { canonicalJson } from "../lib/snapshot.js";
import registryAbi from "../abi/FinalityRegistry.json";

const connection = document.querySelector("#connection");
const alertsEl = document.querySelector("#alerts");
const freshnessAlert = document.querySelector("#freshness-alert");
const authorsEl = document.querySelector("#authors");
const snapshotsEl = document.querySelector("#snapshots");
const registryStatus = document.querySelector("#registry-status");
const hashResult = document.querySelector("#hash-result");
const registryInput = document.querySelector("#registry-address");
let connectionState = "connecting";

function text(id, value) {
  document.querySelector(id).textContent = value;
}

function showConnection(message, state) {
  connection.replaceChildren();
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.setAttribute("aria-hidden", "true");
  connection.append(dot, document.createTextNode(message));
  connection.classList.toggle("live", state === "live");
  connection.classList.toggle("down", state === "down");
  connection.classList.toggle("stale", state === "stale");
  if (state === "stale") {
    freshnessAlert.hidden = false;
    freshnessAlert.textContent = `No new head received for ${staleAfterSeconds} seconds. Check the RPC endpoint and node health before relying on these readings.`;
  } else if (state === "down") {
    freshnessAlert.hidden = false;
    freshnessAlert.textContent = `Live network data is unavailable: ${message}. Check the RPC endpoint and connection.`;
  } else {
    freshnessAlert.hidden = true;
    freshnessAlert.textContent = "";
  }
  connectionState = state;
}

function blockLink(number) {
  return `${SCANNER}/blocks/${number}`;
}

function setLinkedNumber(selector, number) {
  const el = document.querySelector(selector);
  el.replaceChildren();
  const anchor = document.createElement("a");
  anchor.href = blockLink(number);
  anchor.textContent = Number(number).toLocaleString("en-US");
  anchor.rel = "noreferrer";
  el.append(anchor);
}

function shortAddress(address) {
  const value = String(address || "");
  if (value.length < 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function ageLabel(seconds) {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function envThreshold(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
}

function positiveSeconds(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const substrateWs = String(import.meta.env.VITE_SUBSTRATE_WS || DEFAULT_SUBSTRATE_WS).trim();
const staleAfterSeconds = positiveSeconds(
  import.meta.env.VITE_HEAD_STALE_AFTER_SECONDS,
  DEFAULT_THRESHOLDS.headStaleSeconds,
);

function linkedCell(row, number) {
  const cell = document.createElement("td");
  const anchor = document.createElement("a");
  anchor.href = blockLink(number);
  anchor.textContent = number.toString();
  anchor.rel = "noreferrer";
  cell.append(anchor);
  row.append(cell);
}

function textCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = String(value);
  row.append(cell);
}

const alertCopy = {
  grandpa_lag: "GRANDPA lag",
  beefy_lag: "BEEFY lag",
  slot_gap: "Slot gap",
};

function showAlerts(items) {
  alertsEl.replaceChildren();
  for (const item of items) {
    const p = document.createElement("p");
    p.className = "alert";
    const name = document.createElement("strong");
    name.textContent = alertCopy[item.code] || item.code;
    const detail = document.createElement("span");
    detail.textContent = item.code === "slot_gap"
      ? `${item.value} BABE slots were skipped between delivered heads.`
      : `${item.value} blocks. Alert at ${item.threshold}.`;
    p.append(name, detail);
    alertsEl.appendChild(p);
  }
}

function renderAuthors(rows) {
  authorsEl.replaceChildren();
  const total = rows.reduce((sum, row) => sum + row.blocks, 0);
  text("#observed", total === 0 ? "No blocks observed yet" : `${total} blocks observed`);
  for (const row of rows) {
    const tr = document.createElement("tr");
    const index = document.createElement("td");
    const account = document.createElement("td");
    const share = document.createElement("td");
    const blocks = document.createElement("td");
    index.textContent = String(row.index);
    index.className = "num";
    account.textContent = row.account;
    account.className = "account";
    const width = total === 0 ? 0 : (row.blocks / total) * 100;
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("span");
    fill.style.width = `${width}%`;
    bar.append(fill);
    const pct = document.createElement("div");
    pct.className = "pct";
    pct.textContent = total === 0 ? "0%" : `${Math.round(width)}%`;
    share.className = "share";
    share.append(bar, pct);
    blocks.textContent = String(row.blocks);
    blocks.className = "num";
    tr.append(index, account, share, blocks);
    authorsEl.appendChild(tr);
  }
}

const thresholds = {
  grandpaLag: envThreshold(import.meta.env.VITE_GRANDPA_LAG_THRESHOLD, DEFAULT_THRESHOLDS.grandpaLag),
  beefyLag: envThreshold(import.meta.env.VITE_BEEFY_LAG_THRESHOLD, DEFAULT_THRESHOLDS.beefyLag),
};
const tracker = createTracker(thresholds);
const authorCounts = new Map();
const publishedHashes = new Map();
const history = [];
const svgNs = "http://www.w3.org/2000/svg";
let lastHeadAt = 0;
let connectedAt = 0;
let liveChainName = EXPECTED_CHAIN;

text("#chain-id", String(CHAIN_ID));
document.querySelector("#grandpa-meter").setAttribute("aria-valuemax", String(thresholds.grandpaLag));
document.querySelector("#beefy-meter").setAttribute("aria-valuemax", String(thresholds.beefyLag));
text("#grandpa-cap", String(thresholds.grandpaLag));
text("#beefy-cap", String(thresholds.beefyLag));

function renderUpdated() {
  const el = document.querySelector("#updated");
  const activityAt = lastHeadAt || connectedAt;
  if (!activityAt) {
    el.textContent = connectionState === "down"
      ? "Feed unavailable · waiting for first head"
      : "Waiting for a head";
    return;
  }
  const seconds = Math.max(0, Math.round((Date.now() - activityAt) / 1000));
  if (connectionState === "down") {
    el.textContent = lastHeadAt
      ? `Feed error · last head ${seconds}s ago`
      : `Feed error · waiting for first head`;
    return;
  }
  if (seconds > staleAfterSeconds) {
    if (connectionState !== "stale") showConnection("Stale telemetry", "stale");
    el.textContent = lastHeadAt
      ? `Stale · last head ${seconds}s ago`
      : `Stale · no head received in ${seconds}s`;
    return;
  }
  if (connectionState === "stale") showConnection(liveChainName, "live");
  el.textContent = lastHeadAt
    ? seconds < 2 ? "Received just now" : `Received ${seconds}s ago`
    : `Connected · waiting for a head ${seconds}s`;
}

function setMeter(cardSelector, meterSelector, lag, threshold) {
  const card = document.querySelector(cardSelector);
  const meter = document.querySelector(meterSelector);
  const numeric = lag == null ? 0 : lag;
  const cap = Math.max(threshold, 1);
  meter.querySelector("span").style.width = `${Math.min(100, (numeric / cap) * 100)}%`;
  meter.setAttribute("aria-valuenow", String(numeric));
  card.classList.toggle("hot", lag != null && lag >= threshold);
  card.classList.toggle("ok", lag != null && lag < threshold);
}

function drawTrack({ best, grandpa, beefy }) {
  const root = document.querySelector("#track");
  root.replaceChildren();
  const points = [
    { key: "BEEFY", n: beefy, cls: "beefy" },
    { key: "GRANDPA", n: grandpa, cls: "grandpa" },
    { key: "Best", n: best, cls: "best" },
  ];
  const min = Math.min(best, grandpa, beefy);
  const max = Math.max(best, grandpa, beefy);
  const span = Math.max(max - min, 1);
  const rail = document.createElement("div");
  rail.className = "rail";
  rail.setAttribute("aria-hidden", "true");
  const line = document.createElement("div");
  line.className = "rail-line";
  rail.append(line);
  const placed = [];
  for (const point of points) {
    const pin = document.createElement("span");
    pin.className = `pin ${point.cls}`;
    const pct = ((point.n - min) / span) * 100;
    const stack = placed.filter((item) => Math.abs(item - pct) < 8).length;
    placed.push(pct);
    pin.style.left = `${pct}%`;
    pin.style.top = `${stack * 12}px`;
    rail.append(pin);
  }
  const legend = document.createElement("div");
  legend.className = "rail-legend";
  for (const point of points) {
    const item = document.createElement("p");
    item.className = point.cls;
    const name = document.createElement("strong");
    name.textContent = point.key;
    const anchor = document.createElement("a");
    anchor.href = blockLink(point.n);
    anchor.rel = "noreferrer";
    anchor.textContent = Number(point.n).toLocaleString("en-US");
    item.append(name, anchor);
    legend.append(item);
  }
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = max === min
    ? "Best, GRANDPA, and BEEFY are on the same block."
    : `${max - min} blocks from the earliest of these heads to the latest.`;
  root.append(rail, legend, note);
}

function svgEl(name, attrs) {
  const el = document.createElementNS(svgNs, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function drawHistory() {
  const svg = document.querySelector("#history");
  const empty = document.querySelector("#history-empty");
  if (history.length < 2) {
    empty.removeAttribute("hidden");
    svg.setAttribute("hidden", "");
    svg.replaceChildren();
    return;
  }
  empty.setAttribute("hidden", "");
  svg.removeAttribute("hidden");
  const width = 640;
  const height = 160;
  const padL = 28;
  const padR = 36;
  const padY = 16;
  const observed = Math.max(...history.map((point) => Math.max(point.grandpaLag, point.beefyLag)), 1);
  const marks = [thresholds.grandpaLag, thresholds.beefyLag].filter((value) => value <= observed * 4);
  const maxY = Math.max(observed, ...marks, 1);
  const xAt = (index) => padL + (index / (history.length - 1)) * (width - padL - padR);
  const yAt = (value) => height - padY - (value / maxY) * (height - padY * 2);
  const series = (key) => history.map((point, index) => `${xAt(index).toFixed(1)},${yAt(point[key]).toFixed(1)}`).join(" ");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.replaceChildren(svgEl("title", { id: "history-title" }));
  svg.querySelector("title").textContent = "GRANDPA lag and BEEFY lag for heads received on this page.";
  for (const value of [0, maxY]) {
    const y = yAt(value).toFixed(1);
    svg.append(svgEl("line", {
      x1: String(padL),
      x2: String(width - padR),
      y1: y,
      y2: y,
      stroke: "#2a3340",
      "stroke-width": "1",
    }));
    const label = svgEl("text", {
      x: "0",
      y: String(Number(y) + 4),
      fill: "#6d7b8c",
      "font-size": "11",
    });
    label.textContent = String(value);
    svg.append(label);
  }
  for (const value of marks) {
    const y = yAt(value).toFixed(1);
    svg.append(svgEl("line", {
      x1: String(padL),
      x2: String(width - padR),
      y1: y,
      y2: y,
      stroke: "#8b95a5",
      "stroke-dasharray": "4 4",
      "stroke-width": "1.5",
    }));
    const label = svgEl("text", {
      x: String(width - padR + 6),
      y: String(Number(y) + 4),
      fill: "#8b95a5",
      "font-size": "11",
    });
    label.textContent = String(value);
    svg.append(label);
  }
  const above = [
    ["GRANDPA", thresholds.grandpaLag],
    ["BEEFY", thresholds.beefyLag],
  ].filter(([, value]) => value > observed * 4);
  text("#history-note", above.length
    ? `${above.map(([name, value]) => `${name} alert ${value}`).join(" · ")} above this range`
    : "");
  for (const [key, stroke] of [["grandpaLag", "#8eb6ff"], ["beefyLag", "#3ddecb"]]) {
    svg.append(svgEl("polyline", {
      fill: "none",
      stroke,
      "stroke-width": "2.5",
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
      points: series(key),
    }));
    const last = history[history.length - 1];
    svg.append(svgEl("circle", {
      cx: xAt(history.length - 1).toFixed(1),
      cy: yAt(last[key]).toFixed(1),
      r: "3.5",
      fill: stroke,
    }));
  }
}

async function followChain() {
  await cryptoWaitReady();
  let endpoint;
  try {
    endpoint = new URL(substrateWs);
  } catch {
    throw new Error("VITE_SUBSTRATE_WS must be a valid public WebSocket URL");
  }
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) {
    throw new Error("VITE_SUBSTRATE_WS must use ws:// or wss://");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("VITE_SUBSTRATE_WS must not contain credentials, query tokens, or a fragment");
  }
  if (location.protocol === "https:" && endpoint.protocol !== "wss:") {
    throw new Error("HTTPS dashboards require a wss:// RPC endpoint");
  }
  text("#source", `RPC endpoint: ${endpoint.host}`);
  const api = await ApiPromise.create({ provider: new WsProvider(endpoint.toString()) });
  const chain = (await api.rpc.system.chain()).toString();
  const spec = api.runtimeVersion.specName.toString();
  const genesis = api.genesisHash.toHex().toLowerCase();
  if (chain !== EXPECTED_CHAIN || spec !== EXPECTED_SPEC || genesis !== EXPECTED_GENESIS) {
    await api.disconnect();
    throw new Error(
      `RPC network mismatch: expected ${EXPECTED_CHAIN} / ${EXPECTED_SPEC} / ${EXPECTED_GENESIS}, got ${chain} / ${spec} / ${genesis}`,
    );
  }
  liveChainName = chain;
  connectedAt = Date.now();
  showConnection(chain, "live");
  text("#runtime", `${chain} · ${spec} · spec ${api.runtimeVersion.specVersion.toString()}`);
  renderUpdated();
  const finalized = await api.rpc.chain.getFinalizedHead();
  tracker.noteGrandpa(await api.rpc.chain.getHeader(finalized));
  await api.rpc.chain.subscribeFinalizedHeads((header) => tracker.noteGrandpa(header));

  let chainQueue = Promise.resolve();
  await api.rpc.chain.subscribeNewHeads((header) => {
    chainQueue = chainQueue.then(async () => {
      const validators = await api.query.session.validators();
      tracker.noteValidators(validators);
      const babe = babeFromHeader(api, header);
      const author = babe && validators[babe.authorityIndex]
        ? validators[babe.authorityIndex].toString()
        : "unknown";
      if (author !== "unknown") authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
      const sample = tracker.noteBest({
        header,
        babe,
        author: author === "unknown" ? null : author,
        deriveAuthor: null,
        currentSlot: null,
        genesisSlot: null,
        skippedEpochs: null,
      });
      const beefy = await readBeefy(api);
      const grandpaNumber = tracker.grandpaNumber;
      const { grandpaLag, beefyLag } = lags(sample.number, grandpaNumber, beefy.number);
      setLinkedNumber("#best", sample.number);
      const hashLink = document.querySelector("#best-hash");
      hashLink.replaceChildren();
      const anchor = document.createElement("a");
      anchor.href = blockLink(sample.number);
      anchor.textContent = sample.hash;
      anchor.title = sample.hash;
      anchor.rel = "noreferrer";
      hashLink.append(anchor);
      setLinkedNumber("#grandpa", grandpaNumber);
      text("#grandpa-lag", grandpaLag == null
        ? `Ahead of best · alert at ${thresholds.grandpaLag}`
        : `Lag ${grandpaLag} · alert at ${thresholds.grandpaLag}`);
      setLinkedNumber("#beefy", beefy.number);
      text("#beefy-lag", beefyLag == null
        ? `Ahead of GRANDPA · alert at ${thresholds.beefyLag}`
        : `Lag ${beefyLag} · alert at ${thresholds.beefyLag}`);
      text("#beefy-set", `Set ${beefy.setId} · ${beefy.authorities} authorities`);
      text("#skipped", String(tracker.skippedSlots));
      text("#slot", babe ? `${babe.kind} · slot ${babe.slot}` : "No BABE predigest on this head");
      document.querySelector("#slots-card").classList.toggle("hot", tracker.skippedSlots > 0);
      document.querySelector("#slots-card").classList.toggle("ok", tracker.skippedSlots === 0);
      text("#set", `${validators.length} session validators`);
      setMeter(".metric.grandpa", "#grandpa-meter", grandpaLag, thresholds.grandpaLag);
      setMeter(".metric.beefy", "#beefy-meter", beefyLag, thresholds.beefyLag);
      drawTrack({ best: sample.number, grandpa: grandpaNumber, beefy: beefy.number });
      history.push({
        grandpaLag: grandpaLag ?? 0,
        beefyLag: beefyLag ?? 0,
      });
      if (history.length > 60) history.shift();
      lastHeadAt = Date.now();
      if (connectionState !== "live") showConnection(chain, "live");
      renderUpdated();
      drawHistory();
      renderAuthors(
        validators
          .map((validator, index) => {
            const account = validator.toString();
            return { index, account, blocks: authorCounts.get(account) || 0 };
          })
          .sort((x, y) => y.blocks - x.blocks || x.index - y.index),
      );
      showAlerts(alerts({
        grandpaLag,
        beefyLag,
        slotGap: sample.slotGap,
        thresholds,
      }));
    }).catch((err) => {
      showConnection(err.message.split("\n")[0], "down");
    });
  });
}

async function archiveFor(payloadHash) {
  const hex = String(payloadHash).replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    return { match: "file not on this site", txHash: "", blockNumber: null };
  }
  let match = "archive unavailable";
  try {
    const response = await fetch(`/snapshots/${hex}.json`);
    if (!response.ok) {
      return { match: "file not on this site", txHash: "", blockNumber: null };
    }
    const body = await response.text();
    const hash = keccak256(toUtf8Bytes(body));
    match = hash.toLowerCase() === String(payloadHash).toLowerCase()
      ? "matches file"
      : "file differs";
  } catch {
    return { match, txHash: "", blockNumber: null };
  }
  let txHash = "";
  let blockNumber = null;
  try {
    const meta = await fetch(`/snapshots/${hex}.meta.json`);
    if (meta.ok) {
      const record = await meta.json();
      if (typeof record.txHash === "string") txHash = record.txHash;
      const candidate = Number(record.blockNumber);
      if (Number.isSafeInteger(candidate) && candidate > 0) blockNumber = candidate;
    }
  } catch {
    txHash = "";
    blockNumber = null;
  }
  return { match, txHash, blockNumber };
}

function archiveCell(row, info) {
  const cell = document.createElement("td");
  const label = document.createElement("span");
  label.textContent = info.match;
  label.className = info.match === "matches file" ? "match" : info.match === "file differs" ? "miss" : "absent";
  cell.append(label);
  if (info.txHash) {
    const tx = document.createElement("span");
    tx.className = "tx";
    tx.textContent = `Tx ${info.txHash}`;
    cell.append(tx);
  }
  if (info.blockNumber != null) {
    const block = document.createElement("a");
    block.className = "tx explorer-block";
    block.href = blockLink(info.blockNumber);
    block.rel = "noreferrer";
    block.textContent = `Included in block ${info.blockNumber}`;
    cell.append(block);
  }
  row.append(cell);
}

async function loadRegistry(address) {
  snapshotsEl.replaceChildren();
  publishedHashes.clear();
  if (!address) {
    registryStatus.textContent = "No registry address yet. Deploy FinalityRegistry, then paste the address.";
    return;
  }
  registryStatus.textContent = "Reading the registry…";
  const provider = new JsonRpcProvider(EVM_RPC, CHAIN_ID, { staticNetwork: true });
  const code = await provider.getCode(address);
  if (code === "0x") {
    registryStatus.textContent = `No contract code at ${address}.`;
    return;
  }
  const registry = new Contract(address, registryAbi, provider);
  const total = Number(await registry.count());
  let latest = null;
  for (let id = 0; id < total; id += 1) {
    const snap = await registry.get(id);
    const lag = await registry.beefyLag(id);
    latest = snap;
    publishedHashes.set(String(snap.payloadHash).toLowerCase(), id);
    const row = document.createElement("tr");
    textCell(row, id);
    linkedCell(row, snap.bestBlock);
    linkedCell(row, snap.grandpaFinalized);
    linkedCell(row, snap.beefyFinalized);
    textCell(row, lag);
    const hashCell = document.createElement("td");
    hashCell.className = "account";
    hashCell.textContent = String(snap.payloadHash);
    row.append(hashCell);
    archiveCell(row, await archiveFor(snap.payloadHash));
    snapshotsEl.append(row);
  }
  if (!latest) {
    registryStatus.textContent = `0 snapshots on chain ${CHAIN_ID}.`;
    return;
  }
  const publishedAt = Number(latest.timestamp);
  const when = new Date(publishedAt * 1000).toISOString();
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000 - publishedAt));
  registryStatus.textContent = `${total} snapshot${total === 1 ? "" : "s"} on chain ${CHAIN_ID}. Latest report ${ageLabel(ageSeconds)} · reporter ${shortAddress(latest.reporter)} · ${when}.`;
}

function describeHash(hash) {
  hashResult.className = "hash";
  const id = publishedHashes.get(hash.toLowerCase());
  if (publishedHashes.size === 0) {
    hashResult.textContent = hash;
    return;
  }
  if (id == null) {
    hashResult.classList.add("miss");
    hashResult.textContent = `${hash} — does not match a loaded snapshot`;
    return;
  }
  hashResult.classList.add("match");
  hashResult.textContent = `${hash} — matches snapshot ${id}`;
}

document.querySelector("#registry-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const address = registryInput.value.trim();
  localStorage.setItem("registry", address);
  loadRegistry(address).catch((err) => {
    registryStatus.textContent = err.message;
  });
});

document.querySelector("#hash-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const body = canonicalJson(JSON.parse(document.querySelector("#payload").value));
    describeHash(keccak256(toUtf8Bytes(body)));
  } catch (err) {
    hashResult.className = "hash miss";
    hashResult.textContent = err.message;
  }
});

document.querySelector("#hash-raw").addEventListener("click", () => {
  const raw = document.querySelector("#payload").value;
  describeHash(keccak256(toUtf8Bytes(raw)));
});

async function startingAddress() {
  const saved = (localStorage.getItem("registry") || "").trim();
  if (saved) return saved;
  const fromEnv = String(import.meta.env.VITE_REGISTRY_ADDRESS || "").trim();
  if (fromEnv) return fromEnv;
  const response = await fetch("/config.json");
  if (!response.ok) throw new Error(`config.json returned ${response.status}`);
  const config = await response.json();
  return String(config.registry || "").trim();
}

startingAddress()
  .then((address) => {
    registryInput.value = address;
    return loadRegistry(address);
  })
  .catch((err) => {
    registryStatus.textContent = err.message;
  });

followChain().catch((err) => {
  showConnection(err.message.split("\n")[0], "down");
});

const shellViews = ["overview", "production", "registry", "verify"];

function shellView() {
  const raw = location.hash.replace(/^#/, "");
  if (raw === "registry-panel") return "registry";
  return shellViews.includes(raw) ? raw : "overview";
}

function applyShellView() {
  const view = shellView();
  const changed = document.documentElement.dataset.view !== view;
  document.documentElement.dataset.view = view;
  if (changed) document.querySelector("main").scrollTop = 0;
  for (const id of shellViews) {
    const tab = document.querySelector(`#tab-${id}`);
    if (id === view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  if (rawHashAlias()) history.replaceState(null, "", `#${view}`);
}

function rawHashAlias() {
  return location.hash === "#registry-panel";
}

window.addEventListener("hashchange", applyShellView);
applyShellView();

setInterval(renderUpdated, 1000);
