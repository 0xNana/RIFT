import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { connectSubstrate, createTracker, readBeefy } from "../lib/finality.js";
import { babeFromHeader } from "../lib/babe.js";
import { loadEnv } from "../lib/env.js";
import { canonicalJson } from "../lib/snapshot.js";
import { lags } from "../lib/metrics.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1];
}

function explain(err) {
  return err?.message?.split("\n")[0] || String(err);
}

const env = loadEnv();
const blocksNeeded = Number(arg("--blocks", "4"));
const outPath = arg("--out", "evidence/collector-run.jsonl");
const snapshotPath = arg("--snapshot", "snapshots/latest.json");

if (!Number.isInteger(blocksNeeded) || blocksNeeded < 1) {
  console.error("collector: --blocks must be a positive integer");
  process.exit(1);
}

const api = await connectSubstrate(env.substrateWs);
const tracker = createTracker({
  grandpaLag: env.grandpaLagThreshold,
  beefyLag: env.beefyLagThreshold,
});
const lines = [];
let unsubscribeNew = () => {};
let unsubscribeFinalized = () => {};

try {
  const finalized = await api.rpc.chain.getFinalizedHead();
  tracker.noteGrandpa(await api.rpc.chain.getHeader(finalized));
  unsubscribeFinalized = await api.rpc.chain.subscribeFinalizedHeads((header) => {
    tracker.noteGrandpa(header);
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out before ${blocksNeeded} new heads`));
    }, Math.max(60_000, blocksNeeded * 20_000));
    let chain = Promise.resolve();
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    api.rpc.chain
      .subscribeNewHeads((header) => {
        chain = chain
          .then(async () => {
            if (settled) return;
            const validators = await api.query.session.validators();
            tracker.noteValidators(validators);
            const babe = babeFromHeader(api, header);
            const author =
              babe && validators[babe.authorityIndex]
                ? validators[babe.authorityIndex].toString()
                : null;
            let deriveAuthor = null;
            try {
              const derived = await api.derive.chain.getHeader(header.hash);
              deriveAuthor = derived?.author?.toString() || null;
            } catch (err) {
              deriveAuthor = `error: ${explain(err)}`;
            }
            const currentSlot = (await api.query.babe.currentSlot()).toString();
            const genesisSlot = (await api.query.babe.genesisSlot()).toString();
            const skippedEpochs = JSON.parse(
              JSON.stringify((await api.query.babe.skippedEpochs()).toHuman()),
            );
            const sample = tracker.noteBest({
              header,
              babe,
              author,
              deriveAuthor,
              currentSlot,
              genesisSlot,
              skippedEpochs,
            });
            const beefy = await readBeefy(api);
            const grandpaNumber = tracker.grandpaNumber;
            const { grandpaLag, beefyLag } = lags(sample.number, grandpaNumber, beefy.number);
            const line = {
              best: sample.number,
              bestHash: sample.hash,
              grandpa: grandpaNumber,
              beefy: beefy.number,
              grandpaLag,
              beefyLag,
              babeKind: babe?.kind ?? null,
              authorityIndex: babe?.authorityIndex ?? null,
              slot: babe?.slot ?? null,
              currentSlot,
              slotGap: sample.slotGap,
              skippedSlotsObserved: tracker.skippedSlots,
              author,
              deriveAuthor,
              authorAgrees: sample.authorAgrees,
              headerAuthor: sample.headerAuthor,
              beefySetId: beefy.setId,
              beefyAuthorities: beefy.authorities,
              skippedEpochs,
            };
            lines.push(line);
            console.log(JSON.stringify(line));
            if (lines.length >= blocksNeeded) succeed();
          })
          .catch(fail);
      })
      .then((unsub) => {
        unsubscribeNew = unsub;
      })
      .catch(fail);
  });

  const beefy = await readBeefy(api);
  const currentSlot = (await api.query.babe.currentSlot()).toString();
  const genesisSlot = (await api.query.babe.genesisSlot()).toString();
  const skippedEpochs = JSON.parse(
    JSON.stringify((await api.query.babe.skippedEpochs()).toHuman()),
  );
  const snapshot = tracker.snapshot({
    chain: (await api.rpc.system.chain()).toString(),
    specName: api.runtimeVersion.specName.toString(),
    specVersion: api.runtimeVersion.specVersion.toNumber(),
    genesisHash: api.genesisHash.toHex(),
    beefy,
    currentSlot,
    genesisSlot,
    skippedEpochs,
  });
  mkdirSync(dirname(snapshotPath), { recursive: true });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(snapshotPath, `${canonicalJson(snapshot)}\n`);
  writeFileSync(outPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  console.error(`collector: wrote ${lines.length} heads to ${outPath}`);
  console.error(`collector: wrote ${snapshotPath}`);
} finally {
  unsubscribeNew();
  unsubscribeFinalized();
  await api.disconnect();
}
