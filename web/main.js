import { ApiPromise, WsProvider } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { Contract, JsonRpcProvider, keccak256, toUtf8Bytes } from "ethers";
import {
  SUBSTRATE_WS,
  EVM_RPC,
  CHAIN_ID,
  SCANNER,
  DEFAULT_THRESHOLDS,
  EXPECTED_CHAIN,
  EXPECTED_SPEC,
} from "../lib/endpoints.js";
import { babeFromHeader } from "../lib/babe.js";
import { createTracker, readBeefy } from "../lib/finality.js";
import { alerts, lags } from "../lib/metrics.js";
import { canonicalJson } from "../lib/snapshot.js";
import registryAbi from "../abi/FinalityRegistry.json";

const connection = document.querySelector("#connection");
const alertsEl = document.querySelector("#alerts");
const authorsEl = document.querySelector("#authors");
const snapshotsEl = document.querySelector("#snapshots");
const registryStatus = document.querySelector("#registry-status");
const hashResult = document.querySelector("#hash-result");
const registryInput = document.querySelector("#registry");

function text(id, value) {
  document.querySelector(id).textContent = value;
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

function envThreshold(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
}

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

function showAlerts(items) {
  alertsEl.replaceChildren();
  for (const item of items) {
    const p = document.createElement("p");
    p.className = "alert";
    p.textContent = `${item.code} is ${item.value}, threshold ${item.threshold}`;
    alertsEl.appendChild(p);
  }
}

function renderAuthors(rows) {
  authorsEl.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement("tr");
    const account = document.createElement("td");
    const blocks = document.createElement("td");
    account.textContent = row.account;
    blocks.textContent = String(row.blocks);
    tr.append(account, blocks);
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

async function followChain() {
  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(SUBSTRATE_WS) });
  const chain = (await api.rpc.system.chain()).toString();
  const spec = api.runtimeVersion.specName.toString();
  if (chain !== EXPECTED_CHAIN || spec !== EXPECTED_SPEC) {
    throw new Error(`expected ${EXPECTED_CHAIN} / ${EXPECTED_SPEC}, got ${chain} / ${spec}`);
  }
  connection.textContent = chain;
  connection.classList.add("live");
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
      anchor.rel = "noreferrer";
      hashLink.append(anchor);
      setLinkedNumber("#grandpa", grandpaNumber);
      text("#grandpa-lag", grandpaLag == null
        ? `GRANDPA is ahead of best · alert at ${thresholds.grandpaLag}`
        : `lag ${grandpaLag} · alert at ${thresholds.grandpaLag}`);
      setLinkedNumber("#beefy", beefy.number);
      text("#beefy-lag", `lag ${beefyLag == null ? "n/a" : beefyLag} · alert at ${thresholds.beefyLag} · set ${beefy.setId} · ${beefy.authorities} authorities`);
      text("#skipped", String(tracker.skippedSlots));
      text("#slot", babe ? `${babe.kind} slot ${babe.slot}` : "no BABE predigest");
      text("#set", `${validators.length} session validators`);
      renderAuthors(
        validators
          .map((validator) => {
            const account = validator.toString();
            return { account, blocks: authorCounts.get(account) || 0 };
          })
          .sort((x, y) => y.blocks - x.blocks || x.account.localeCompare(y.account)),
      );
      showAlerts(alerts({
        grandpaLag,
        beefyLag,
        slotGap: sample.slotGap,
        thresholds,
      }));
    }).catch((err) => {
      connection.textContent = err.message.split("\n")[0];
      connection.classList.remove("live");
      connection.classList.add("down");
    });
  });
}

async function archiveFor(payloadHash) {
  const hex = String(payloadHash).replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return { match: "file not on this site", txHash: "" };
  const response = await fetch(`/snapshots/${hex}.json`);
  if (!response.ok) return { match: "file not on this site", txHash: "" };
  const body = await response.text();
  const hash = keccak256(toUtf8Bytes(body));
  const match = hash.toLowerCase() === String(payloadHash).toLowerCase() ? "matches file" : "file differs";
  let txHash = "";
  try {
    const meta = await fetch(`/snapshots/${hex}.meta.json`);
    if (meta.ok) {
      const record = await meta.json();
      if (typeof record.txHash === "string") txHash = record.txHash;
    }
  } catch {
    txHash = "";
  }
  return { match, txHash };
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
    tx.textContent = info.txHash;
    cell.append(tx);
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
    textCell(row, snap.payloadHash);
    archiveCell(row, await archiveFor(snap.payloadHash));
    snapshotsEl.append(row);
  }
  if (!latest) {
    registryStatus.textContent = `0 snapshots on chain ${CHAIN_ID}.`;
    return;
  }
  const when = new Date(Number(latest.timestamp) * 1000).toISOString();
  registryStatus.textContent = `${total} snapshot${total === 1 ? "" : "s"} on chain ${CHAIN_ID}. Reporter ${shortAddress(latest.reporter)} at ${when}.`;
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
  connection.textContent = err.message.split("\n")[0];
  connection.classList.add("down");
});
