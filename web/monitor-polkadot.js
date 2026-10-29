import { ApiPromise, WsProvider } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { EXPECTED_GENESIS, SUBSTRATE_WS } from "../lib/endpoints.js";
import { babeFromHeader } from "../lib/babe.js";
import { createTracker, readBeefy } from "../lib/finality.js";
import { alerts as getAlerts, lags } from "../lib/metrics.js";
import { profiles } from "./profiles.js";

const trimHistory = (items) => items.slice(-600);

function failedConnection(state, error) {
  return {
    ...state,
    connection: {
      ...state.connection,
      status: "down",
      label: error.message.split("\n")[0],
      error: error.message.split("\n")[0],
    },
  };
}

function validateEndpoint(raw, protocols, name) {
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid public RPC URL`);
  }
  if (!protocols.includes(endpoint.protocol)) throw new Error(`${name} must use ${protocols.join(" or ")}`);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(`${name} must not contain credentials, query tokens, or a fragment`);
  }
  if (location.protocol === "https:" && endpoint.protocol !== "wss:" && endpoint.protocol !== "https:") {
    throw new Error("HTTPS dashboards require a secure RPC endpoint");
  }
  return endpoint;
}

export function startPortaldotMonitor(onChange) {
  const thresholds = profiles.portaldot.thresholds;
  const tracker = createTracker(thresholds);
  const authors = new Map();
  let api;
  let unsubHeads;
  let unsubFinalized;
  let closed = false;
  let state = {
    connection: { mode: "browser-rpc", status: "connecting", label: "Connecting to Portaldot", endpoint: "", runtime: "" },
    metrics: {},
    series: [],
    validators: [],
    alerts: [],
    details: [],
    observed: 0,
  };
  const emit = (patch) => {
    if (closed) return;
    state = { ...state, ...patch };
    onChange(state);
  };

  const run = async () => {
    await cryptoWaitReady();
    const endpoint = validateEndpoint(
      String(import.meta.env.VITE_SUBSTRATE_WS || SUBSTRATE_WS).trim(),
      ["ws:", "wss:"],
      "VITE_SUBSTRATE_WS",
    );
    api = await ApiPromise.create({ provider: new WsProvider(endpoint.toString()) });
    const chain = (await api.rpc.system.chain()).toString();
    const spec = api.runtimeVersion.specName.toString();
    const genesis = api.genesisHash.toHex().toLowerCase();
    const profile = profiles.portaldot;
    if (chain !== profile.expectedChain || spec !== profile.expectedSpec || genesis !== EXPECTED_GENESIS) {
      await api.disconnect();
      throw new Error(`RPC network mismatch: expected ${chainLabel(profile)}, got ${chain} / ${spec} / ${genesis}`);
    }
    emit({
      connection: {
        mode: "browser-rpc",
        status: "live",
        label: chain,
        endpoint: endpoint.host,
        runtime: `${spec} · spec ${api.runtimeVersion.specVersion.toString()}`,
        connectedAt: Date.now(),
      },
    });
    const finalized = await api.rpc.chain.getFinalizedHead();
    tracker.noteGrandpa(await api.rpc.chain.getHeader(finalized));
    unsubFinalized = await api.rpc.chain.subscribeFinalizedHeads((header) => tracker.noteGrandpa(header));

    let queue = Promise.resolve();
    unsubHeads = await api.rpc.chain.subscribeNewHeads((header) => {
      queue = queue.then(async () => {
        const validators = await api.query.session.validators();
        tracker.noteValidators(validators);
        const babe = babeFromHeader(api, header);
        const author = babe && validators[babe.authorityIndex] ? validators[babe.authorityIndex].toString() : null;
        if (author) authors.set(author, (authors.get(author) || 0) + 1);
        const sample = tracker.noteBest({ header, babe, author, deriveAuthor: null, currentSlot: null, genesisSlot: null, skippedEpochs: null });
        const beefy = await readBeefy(api);
        const grandpa = tracker.grandpaNumber;
        const { grandpaLag, beefyLag } = lags(sample.number, grandpa, beefy.number);
        const now = Date.now();
        const sampleAlerts = getAlerts({ grandpaLag, beefyLag, slotGap: sample.slotGap, thresholds });
        const history = trimHistory([...state.series, {
          at: now,
          best: sample.number,
          grandpa: grandpa,
          beefy: beefy.number,
          grandpaLag: grandpaLag ?? 0,
          beefyLag: beefyLag ?? 0,
          slotGaps: tracker.skippedSlots,
          alerts: sampleAlerts,
        }]);
        emit({
          connection: { ...state.connection, status: "live", label: chain, updatedAt: now, error: "" },
          metrics: {
            best: sample.number,
            bestHash: sample.hash,
            grandpa,
            grandpaLag,
            beefy: beefy.number,
            beefyLag,
            beefySet: beefy.setId,
            authorities: beefy.authorities,
            slotGaps: tracker.skippedSlots,
            slot: babe ? `${babe.kind} · slot ${babe.slot}` : "No BABE predigest on this head",
          },
          series: history,
          validators: validators.map((validator, index) => {
            const account = validator.toString();
            return { index, account, blocks: authors.get(account) || 0 };
          }).sort((a, b) => b.blocks - a.blocks || a.index - b.index),
          alerts: sampleAlerts,
          details: [
            { label: "Runtime", value: `${spec} · ${api.runtimeVersion.specVersion.toString()}` },
            { label: "BEEFY set", value: `${beefy.setId} · ${beefy.authorities} authorities` },
            { label: "BABE slot", value: babe ? `${babe.slot} · ${babe.kind}` : "Not available" },
          ],
          observed: tracker.observedBlocks,
        });
      }).catch((error) => emit(failedConnection(state, error)));
    });
  };

  run().catch((error) => emit(failedConnection(state, error)));
  return () => {
    closed = true;
    if (typeof unsubHeads === "function") unsubHeads();
    if (typeof unsubFinalized === "function") unsubFinalized();
    if (api) api.disconnect();
  };
}

function chainLabel(profile) {
  return `${profile.expectedChain} / ${profile.expectedSpec} / configured genesis`;
}
