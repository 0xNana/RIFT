import { readFileSync } from "node:fs";
import { CHAIN_ID, EVM_RPC, SUBSTRATE_WS } from "./endpoints.js";

function parse(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export function loadEnv(path = ".env") {
  let file = {};
  try {
    file = parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const merged = { ...file, ...process.env };
  return {
    privateKey: merged.PRIVATE_KEY || "",
    substrateWs: merged.SUBSTRATE_WS || SUBSTRATE_WS,
    evmRpc: merged.EVM_RPC || EVM_RPC,
    chainId: Number(merged.CHAIN_ID || CHAIN_ID),
    registryAddress: merged.REGISTRY_ADDRESS || "",
    grandpaLagThreshold: Number(merged.GRANDPA_LAG_THRESHOLD || 6),
    beefyLagThreshold: Number(merged.BEEFY_LAG_THRESHOLD || 24),
  };
}
