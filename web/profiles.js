import {
  CHAIN_ID,
  DEFAULT_THRESHOLDS,
  EXPECTED_CHAIN,
  EXPECTED_SPEC,
  SCANNER,
} from "../lib/endpoints.js";
import { evmChainId } from "./runtime-config.js";

function threshold(raw, fallback, minimum = 0) {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= minimum ? value : fallback;
}

export const profiles = {
  portaldot: {
    id: "portaldot",
    label: "Portaldot V3 Test",
    family: "Substrate",
    kind: "substrate",
    description: "Block production, GRANDPA finality, and BEEFY checkpoints.",
    thresholds: {
      grandpaLag: threshold(import.meta.env.VITE_GRANDPA_LAG_THRESHOLD, DEFAULT_THRESHOLDS.grandpaLag),
      beefyLag: threshold(import.meta.env.VITE_BEEFY_LAG_THRESHOLD, DEFAULT_THRESHOLDS.beefyLag),
      staleSeconds: threshold(import.meta.env.VITE_HEAD_STALE_AFTER_SECONDS, DEFAULT_THRESHOLDS.headStaleSeconds, 1),
    },
    metrics: [
      { id: "best", label: "Best block", hint: "Latest imported head", series: "best", tone: "best" },
      { id: "grandpa", label: "GRANDPA finalized", hint: "Finalized head", series: "grandpa", tone: "grandpa" },
      { id: "beefy", label: "BEEFY finalized", hint: "Finalized checkpoint", series: "beefy", tone: "beefy" },
      { id: "slotGaps", label: "Slot gaps", hint: "Observed between heads", series: "slotGaps", tone: "slots" },
    ],
    chartSeries: [
      { id: "grandpaLag", label: "GRANDPA lag", color: "#A995FF" },
      { id: "beefyLag", label: "BEEFY lag", color: "#73DCE1" },
      { id: "slotGaps", label: "Slot gaps", color: "#FFC366" },
    ],
    trackStages: [
      { id: "beefy", label: "BEEFY", color: "#73DCE1" },
      { id: "grandpa", label: "GRANDPA", color: "#A995FF" },
      { id: "best", label: "Best", color: "#C8FF45" },
    ],
    blockUrl: (number) => `${SCANNER}/blocks/${number}`,
    chainId: CHAIN_ID,
    expectedChain: EXPECTED_CHAIN,
    expectedSpec: EXPECTED_SPEC,
  },
  "portaldot-evm": {
    id: "portaldot-evm",
    label: "Portaldot V3 Test · EVM",
    family: "EVM",
    kind: "evm",
    description: "EVM block height, finality, and RPC-reported sync state.",
    thresholds: { staleSeconds: 30 },
    metrics: [
      { id: "best", label: "Latest EVM block", hint: "Imported execution block", series: "best", tone: "best" },
      { id: "finalized", label: "Finalized block", hint: "Finalized checkpoint", series: "finalized", tone: "grandpa" },
      { id: "peerCount", label: "Connected peers", hint: "Reported by the node", series: "peerCount", tone: "beefy" },
      { id: "syncStatus", label: "Sync status", hint: "RPC-reported sync state", series: null, tone: "slots" },
    ],
    chartSeries: [
      { id: "blockHeight", label: "Block height", color: "#C8FF45" },
      { id: "peerCount", label: "Peer count", color: "#A995FF" },
    ],
    trackStages: [
      { id: "finalized", label: "Finalized", color: "#A995FF" },
      { id: "best", label: "Latest", color: "#C8FF45" },
    ],
    blockUrl: null,
    chainId: evmChainId,
    expectedChain: EXPECTED_CHAIN,
    expectedSpec: "EVM JSON-RPC",
  },
};

export const profileChoices = Object.values(profiles).map(({ id, label }) => ({ id, label }));
