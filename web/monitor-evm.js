import { JsonRpcProvider } from "ethers";
import { EXPECTED_CHAIN } from "../lib/endpoints.js";
import { evmChainId, evmRpc } from "./runtime-config.js";

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

export function startEvmMonitor(onChange) {
  let closed = false;
  let timer;
  let provider;
  let state = {
    connection: { mode: "browser-rpc", status: "connecting", label: "Connecting to Portaldot EVM", endpoint: "", runtime: "EVM JSON-RPC" },
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
  let endpoint;
  try {
    endpoint = validateEndpoint(evmRpc.trim(), ["http:", "https:"], "Portaldot EVM RPC URL");
  } catch (error) {
    emit(failedConnection(state, error));
    return () => { closed = true; };
  }
  emit({ connection: { mode: "browser-rpc", status: "connecting", label: "Connecting to Portaldot EVM", endpoint: endpoint.host, runtime: `EVM JSON-RPC · chain ${evmChainId}` } });
  provider = new JsonRpcProvider(endpoint.toString(), evmChainId, { staticNetwork: true });

  const poll = async () => {
    try {
      const [chainHex, bestHex, syncValue, finalizedBlock, peerHex] = await Promise.all([
        provider.send("eth_chainId", []),
        provider.send("eth_blockNumber", []),
        provider.send("eth_syncing", []).catch(() => null),
        provider.send("eth_getBlockByNumber", ["finalized", false]).catch(() => null),
        provider.send("net_peerCount", []).catch(() => null),
      ]);
      const chainId = Number(BigInt(chainHex));
      if (chainId !== evmChainId) throw new Error(`Network mismatch: expected ${EXPECTED_CHAIN} (${evmChainId}), got chain ${chainId}`);
      const best = Number(BigInt(bestHex));
      const finalized = finalizedBlock?.number ? Number(BigInt(finalizedBlock.number)) : null;
      const peerCount = peerHex == null ? null : Number(BigInt(peerHex));
      let syncStatus = syncValue == null ? "Not exposed by endpoint" : "Synced";
      let syncProgress = syncValue == null ? null : 100;
      if (syncValue && typeof syncValue === "object") {
        const current = Number(BigInt(syncValue.currentBlock || "0x0"));
        const highest = Number(BigInt(syncValue.highestBlock || "0x0"));
        syncProgress = highest > 0 ? Math.round((current / highest) * 100) : 0;
        syncStatus = `Syncing · ${syncProgress}%`;
      }
      const now = Date.now();
      const nextAlerts = [];
      if (syncValue && typeof syncValue === "object") nextAlerts.push({ code: "syncing", severity: "warning", title: "Node is syncing", value: syncStatus });
      const history = trimHistory([...state.series, { at: now, blockHeight: best, peerCount, best, finalized, alerts: nextAlerts }]);
      emit({
        connection: { mode: "browser-rpc", status: "live", label: "Portaldot EVM", endpoint: endpoint.host, runtime: `EVM JSON-RPC · chain ${evmChainId}`, updatedAt: now, error: "" },
        metrics: { best, finalized, peerCount, syncStatus, syncProgress },
        series: history,
        alerts: nextAlerts,
        details: [
          { label: "Network", value: `${EXPECTED_CHAIN} · EVM` },
          { label: "Chain ID", value: evmChainId },
          { label: "Finalized block", value: finalized == null ? "Not exposed by endpoint" : finalized },
          { label: "Sync status", value: syncStatus },
          { label: "Peer count", value: peerCount == null ? "Not exposed by this endpoint" : String(peerCount) },
        ],
        observed: state.observed + 1,
      });
    } catch (error) {
      emit(failedConnection(state, error));
    }
    if (!closed) timer = setTimeout(poll, 12_000);
  };
  poll();
  return () => {
    closed = true;
    clearTimeout(timer);
    provider?.destroy();
  };
}
