import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { loadEnv } from "../lib/env.js";
import { CHAIN_ID } from "../lib/endpoints.js";
import { canonicalJson, payloadHash } from "../lib/snapshot.js";

function explain(err) {
  return [err.shortMessage, err.reason, err.code, err.message]
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .join(" | ");
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1];
}

const env = loadEnv();
const snapshotPath = arg("--snapshot", "snapshots/latest.json");
if (!env.privateKey || env.privateKey === "0x") {
  console.error("publish: set PRIVATE_KEY in .env");
  process.exit(1);
}
if (!env.registryAddress) {
  console.error("publish: set REGISTRY_ADDRESS in .env");
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const { body, hash } = payloadHash(snapshot);
const artifact = JSON.parse(
  readFileSync("abi/FinalityRegistry.json", "utf8"),
);
const provider = new JsonRpcProvider(env.evmRpc, CHAIN_ID);
const wallet = new Wallet(env.privateKey, provider);
const registry = new Contract(env.registryAddress, artifact, wallet);

try {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    throw new Error(`EVM chain id ${network.chainId} did not match ${CHAIN_ID}`);
  }
  const allowed = await registry.reporters(wallet.address);
  if (!allowed) {
    throw new Error(`${wallet.address} is not an allowlisted reporter`);
  }
  const args = [
    snapshot.best.number,
    snapshot.grandpa.number,
    snapshot.beefy.number,
    BigInt(snapshot.beefy.setId),
    snapshot.beefy.authorities,
    snapshot.babe.skippedSlotsObserved,
    hash,
  ];
  const tx = await registry.publish(...args);
  console.error(`publish: submitted ${tx.hash}`);
  const receipt = await tx.wait();
  const id = (await registry.count()) - 1n;
  const archived = `snapshots/${hash.slice(2)}.json`;
  mkdirSync("snapshots", { recursive: true });
  writeFileSync(archived, body);
  const meta = {
    payloadHash: hash,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
    contract: env.registryAddress,
    id: id.toString(),
    snapshot: archived,
  };
  writeFileSync(`snapshots/${hash.slice(2)}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(JSON.stringify(meta, null, 2));
} catch (err) {
  console.error(`publish: ${explain(err)}`);
  process.exitCode = 1;
}
