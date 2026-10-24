import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, payloadHash } from "../lib/snapshot.js";
import { alerts, lags } from "../lib/metrics.js";

test("canonical JSON sorts keys and ignores input order", () => {
  const left = canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } });
  const right = canonicalJson({ a: { c: [3, 1], d: 2 }, b: 1 });
  assert.equal(left, right);
  assert.equal(left, '{"a":{"c":[3,1],"d":2},"b":1}');
});

test("payload hash is stable across key order", () => {
  const a = payloadHash({ z: 1, a: "0xabc" });
  const b = payloadHash({ a: "0xabc", z: 1 });
  assert.equal(a.hash, b.hash);
  assert.equal(a.body, b.body);
  assert.match(a.hash, /^0x[0-9a-f]{64}$/);
});

test("lags are non-negative differences", () => {
  assert.deepEqual(lags(100, 98, 90), { grandpaLag: 2, beefyLag: 8 });
  assert.deepEqual(lags(100, 100, 105), { grandpaLag: 0, beefyLag: null });
});

test("alerts fire only at the configured thresholds", () => {
  const thresholds = { grandpaLag: 6, beefyLag: 24 };
  assert.deepEqual(alerts({ grandpaLag: 5, beefyLag: 23, slotGap: 0, thresholds }), []);
  assert.deepEqual(
    alerts({ grandpaLag: 6, beefyLag: 24, slotGap: 2, thresholds }).map((item) => item.code),
    ["grandpa_lag", "beefy_lag", "slot_gap"],
  );
});
