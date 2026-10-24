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

const thresholds = { ...DEFAULT_THRESHOLDS };
const tracker = createTracker(thresholds);
const authorCounts = new Map();

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
      text("#best", sample.number.toLocaleString("en-US"));
      const hashLink = document.querySelector("#best-hash");
      hashLink.replaceChildren();
      const anchor = document.createElement("a");
      anchor.href = blockLink(sample.number);
      anchor.textContent = sample.hash;
      anchor.rel = "noreferrer";
      hashLink.append(anchor);
      text("#grandpa", grandpaNumber.toLocaleString("en-US"));
      text("#grandpa-lag", grandpaLag == null ? "GRANDPA is ahead of best" : `lag ${grandpaLag}`);
      text("#beefy", beefy.number.toLocaleString("en-US"));
      text("#beefy-lag", `lag ${beefyLag == null ? "n/a" : beefyLag} · set ${beefy.setId} · ${beefy.authorities} authorities`);
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

async function loadRegistry(address) {
  snapshotsEl.replaceChildren();
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
  registryStatus.textContent = `${total} snapshot${total === 1 ? "" : "s"} on chain ${CHAIN_ID}.`;
  for (let id = 0; id < total; id += 1) {
    const snap = await registry.get(id);
    const lag = await registry.beefyLag(id);
    const tr = document.createElement("tr");
    for (const value of [
      id,
      snap.bestBlock.toString(),
      snap.grandpaFinalized.toString(),
      snap.beefyFinalized.toString(),
      lag.toString(),
      snap.payloadHash,
    ]) {
      const td = document.createElement("td");
      td.textContent = String(value);
      tr.append(td);
    }
    snapshotsEl.append(tr);
  }
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
    hashResult.textContent = keccak256(toUtf8Bytes(body));
  } catch (err) {
    hashResult.textContent = err.message;
  }
});

document.querySelector("#hash-raw").addEventListener("click", () => {
  const raw = document.querySelector("#payload").value;
  hashResult.textContent = keccak256(toUtf8Bytes(raw));
});

const saved = localStorage.getItem("registry") || "";
fetch("/config.json")
  .then((response) => response.json())
  .then((config) => {
    registryInput.value = saved || config.registry || "";
    return loadRegistry(registryInput.value.trim());
  })
  .catch((err) => {
    registryStatus.textContent = err.message;
  });

followChain().catch((err) => {
  connection.textContent = err.message.split("\n")[0];
  connection.classList.add("down");
});
