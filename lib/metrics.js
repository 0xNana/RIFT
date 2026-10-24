export function lags(best, grandpa, beefy) {
  if (![best, grandpa, beefy].every((n) => Number.isInteger(n) && n >= 0)) {
    throw new Error("block numbers must be non-negative integers");
  }
  return {
    grandpaLag: best >= grandpa ? best - grandpa : null,
    beefyLag: grandpa >= beefy ? grandpa - beefy : null,
  };
}

export function alerts({ grandpaLag, beefyLag, slotGap, thresholds }) {
  const out = [];
  if (grandpaLag != null && grandpaLag >= thresholds.grandpaLag) {
    out.push({
      code: "grandpa_lag",
      value: grandpaLag,
      threshold: thresholds.grandpaLag,
    });
  }
  if (beefyLag != null && beefyLag >= thresholds.beefyLag) {
    out.push({
      code: "beefy_lag",
      value: beefyLag,
      threshold: thresholds.beefyLag,
    });
  }
  if (slotGap > 0) {
    out.push({ code: "slot_gap", value: slotGap, threshold: 1 });
  }
  return out;
}
