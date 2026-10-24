import assert from "node:assert/strict";
import test from "node:test";
import { createTracker } from "../lib/finality.js";

function header(number) {
  return {
    number: { toNumber: () => number },
    hash: { toHex: () => `0x${number.toString(16).padStart(64, "0")}` },
    author: undefined,
  };
}

test("slot gaps between delivered heads add up", () => {
  const tracker = createTracker({ grandpaLag: 6, beefyLag: 24 });
  tracker.noteGrandpa(header(10));
  tracker.noteBest({
    header: header(11),
    babe: { kind: "SecondaryPlain", authorityIndex: 0, slot: "100" },
    author: "alice",
    deriveAuthor: "alice",
    currentSlot: "100",
    genesisSlot: "90",
    skippedEpochs: [],
  });
  const second = tracker.noteBest({
    header: header(12),
    babe: { kind: "SecondaryPlain", authorityIndex: 1, slot: "104" },
    author: "bob",
    deriveAuthor: "bob",
    currentSlot: "104",
    genesisSlot: "90",
    skippedEpochs: [],
  });
  assert.equal(second.slotGap, 3);
  assert.equal(tracker.skippedSlots, 3);
  assert.equal(second.headerAuthor, null);
  assert.equal(second.authorAgrees, true);
});
