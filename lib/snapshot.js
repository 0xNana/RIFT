import { keccak256, toUtf8Bytes } from "ethers";

export function canonicalJson(value) {
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return JSON.stringify(value);
  if (kind === "number") {
    if (!Number.isFinite(value)) throw new Error("snapshot numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (kind === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error(`cannot canonicalize ${kind}`);
}

export function payloadHash(snapshot) {
  const body = canonicalJson(snapshot);
  return { body, hash: keccak256(toUtf8Bytes(body)) };
}
