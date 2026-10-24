// SpConsensusBabeDigestsPreDigest is the metadata name on portaldot-v3.
// SecondaryPlain payloads observed on the testnet decode to an authority
// index plus a slot that matches babe.currentSlot.

export function babeFromHeader(api, header) {
  const log = header.digest.logs.find((item) => item.isPreRuntime);
  if (!log) return null;
  const [engine, payload] = log.asPreRuntime;
  if (engine.toUtf8() !== "BABE") return null;
  const pre = api.registry.createType("SpConsensusBabeDigestsPreDigest", payload);
  const inner = pre.isPrimary
    ? pre.asPrimary
    : pre.isSecondaryPlain
      ? pre.asSecondaryPlain
      : pre.isSecondaryVRF
        ? pre.asSecondaryVRF
        : null;
  if (!inner) return null;
  return {
    kind: pre.type,
    authorityIndex: inner.authorityIndex.toNumber(),
    slot: inner.slot.toString(),
  };
}
