import { ApiPromise, WsProvider } from "@polkadot/api";
import { EXPECTED_CHAIN, EXPECTED_SPEC } from "./endpoints.js";
import { alerts, lags } from "./metrics.js";

export async function connectSubstrate(url) {
  const api = await ApiPromise.create({
    provider: new WsProvider(url),
  });
  const chain = await api.rpc.system.chain();
  const spec = api.runtimeVersion.specName.toString();
  if (chain.toString() !== EXPECTED_CHAIN || spec !== EXPECTED_SPEC) {
    const seen = `${chain.toString()} / ${spec}`;
    await api.disconnect();
    throw new Error(
      `refusing endpoint ${url}: expected ${EXPECTED_CHAIN} / ${EXPECTED_SPEC}, got ${seen}`,
    );
  }
  return api;
}

export async function readBeefy(api) {
  const hash = await api.rpc.beefy.getFinalizedHead();
  const header = await api.rpc.chain.getHeader(hash);
  const setId = await api.query.beefy.validatorSetId();
  const authorities = await api.query.beefy.authorities();
  return {
    hash: hash.toHex(),
    number: header.number.toNumber(),
    setId: setId.toString(),
    authorities: authorities.length,
    authorityIds: authorities.map((id) => id.toHex()),
  };
}

export function createTracker(thresholds) {
  const authors = new Map();
  let previousSlot = null;
  let skippedSlots = 0;
  let best = null;
  let grandpa = null;
  let observedBlocks = 0;
  let lastGap = 0;

  return {
    noteValidators(validators) {
      for (const validator of validators) {
        const account = validator.toString();
        if (!authors.has(account)) authors.set(account, 0);
      }
    },
    noteGrandpa(header) {
      grandpa = { number: header.number.toNumber(), hash: header.hash.toHex() };
    },
    noteBest({ header, babe, author, deriveAuthor, currentSlot, genesisSlot, skippedEpochs }) {
      const number = header.number.toNumber();
      const hash = header.hash.toHex();
      best = { number, hash };
      observedBlocks += 1;
      let slotGap = 0;
      if (babe && previousSlot != null) {
        const slot = BigInt(babe.slot);
        const prev = BigInt(previousSlot);
        if (slot > prev + 1n) {
          const gap = slot - prev - 1n;
          if (gap > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error(`slot gap ${gap.toString()} exceeds a safe integer`);
          }
          slotGap = Number(gap);
          skippedSlots += slotGap;
        }
      }
      if (babe) previousSlot = babe.slot;
      lastGap = slotGap;
      if (author) authors.set(author, (authors.get(author) || 0) + 1);
      const lag = grandpa ? lags(number, grandpa.number, number) : null;
      return {
        number,
        hash,
        babe,
        author,
        deriveAuthor,
        authorAgrees: deriveAuthor ? deriveAuthor === author : null,
        headerAuthor: header.author ? header.author.toString() : null,
        slotGap,
        currentSlot,
        genesisSlot,
        skippedEpochs,
        grandpaLag: lag ? lag.grandpaLag : null,
      };
    },
    snapshot({ chain, specName, specVersion, genesisHash, beefy, currentSlot, genesisSlot, skippedEpochs }) {
      if (!best || !grandpa) throw new Error("snapshot needs a best head and a finalized head");
      const { grandpaLag, beefyLag } = lags(best.number, grandpa.number, beefy.number);
      const lifetimeSlotGap =
        currentSlot != null && genesisSlot != null
          ? (BigInt(currentSlot) - BigInt(genesisSlot) - BigInt(best.number)).toString()
          : null;
      const authorRows = [...authors.entries()]
        .map(([account, blocks]) => ({ account, blocks }))
        .sort((a, b) => a.account.localeCompare(b.account));
      return {
        version: 1,
        chain,
        specName,
        specVersion,
        genesisHash,
        capturedAt: new Date().toISOString(),
        best,
        grandpa,
        beefy: {
          number: beefy.number,
          hash: beefy.hash,
          setId: beefy.setId,
          authorities: beefy.authorities,
        },
        lags: { grandpa: grandpaLag, beefy: beefyLag },
        babe: {
          currentSlot,
          genesisSlot,
          headSlot: previousSlot,
          skippedSlotsObserved: skippedSlots,
          lifetimeSlotGap,
          skippedEpochs,
        },
        authors: authorRows,
        observedBlocks,
        alerts: alerts({
          grandpaLag,
          beefyLag,
          slotGap: lastGap,
          thresholds,
        }),
        authorSource: "SpConsensusBabeDigestsPreDigest authority index into session.validators",
        beefyAuthorityIds: beefy.authorityIds,
      };
    },
    get skippedSlots() {
      return skippedSlots;
    },
    get observedBlocks() {
      return observedBlocks;
    },
    get grandpaNumber() {
      return grandpa ? grandpa.number : null;
    },
  };
}
