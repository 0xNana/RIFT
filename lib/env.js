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

function readMonitorEnv(path) {
  const allowed = new Set(["SUBSTRATE_WS", "GRANDPA_LAG_THRESHOLD", "BEEFY_LAG_THRESHOLD"]);
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (allowed.has(key)) out[key] = trimmed.slice(eq + 1).trim();
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
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

export function loadMonitorEnv(path = ".env") {
  const file = readMonitorEnv(path);
  return {
    substrateWs: process.env.SUBSTRATE_WS || file.SUBSTRATE_WS || SUBSTRATE_WS,
    grandpaLagThreshold: Number(process.env.GRANDPA_LAG_THRESHOLD || file.GRANDPA_LAG_THRESHOLD || 6),
    beefyLagThreshold: Number(process.env.BEEFY_LAG_THRESHOLD || file.BEEFY_LAG_THRESHOLD || 24),
  };
}
