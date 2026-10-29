import React, { useEffect, useState } from "react";
import { Contract, JsonRpcProvider, keccak256, toUtf8Bytes } from "ethers";
import { CHAIN_ID, EVM_RPC, SCANNER } from "../lib/endpoints.js";
import { canonicalJson } from "../lib/snapshot.js";
import registryAbi from "../abi/FinalityRegistry.json";

function archivedFieldsMatch(body, report) {
  try {
    const snapshot = JSON.parse(body);
    const fields = [
      [snapshot.best?.number, report.bestBlock],
      [snapshot.grandpa?.number, report.grandpaFinalized],
      [snapshot.beefy?.number, report.beefyFinalized],
      [snapshot.beefy?.setId, report.beefySetId],
      [snapshot.beefy?.authorities, report.beefyAuthorities],
      [snapshot.babe?.skippedSlotsObserved, report.skippedSlots],
    ];
    return fields.every(([archived, onchain]) => archived != null && BigInt(archived) === BigInt(onchain));
  } catch {
    return false;
  }
}

async function archiveFor(payloadHash, report) {
  const hex = String(payloadHash).replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return { match: "file not on this site", fieldsMatch: null };
  try {
    const response = await fetch(`/snapshots/${hex}.json`);
    if (!response.ok) return { match: "file not on this site", fieldsMatch: null };
    const body = await response.text();
    const match = keccak256(toUtf8Bytes(body)).toLowerCase() === String(payloadHash).toLowerCase()
      ? "matches file"
      : "file differs";
    const fieldsMatch = archivedFieldsMatch(body, report);
    const meta = await fetch(`/snapshots/${hex}.meta.json`);
    const record = meta.ok ? await meta.json() : {};
    return {
      match,
      fieldsMatch,
      txHash: typeof record.txHash === "string" ? record.txHash : "",
      blockNumber: Number.isSafeInteger(Number(record.blockNumber)) && Number(record.blockNumber) > 0 ? Number(record.blockNumber) : null,
    };
  } catch {
    return { match: "archive unavailable", fieldsMatch: null };
  }
}

function ageLabel(seconds) {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function hashValue(value) {
  return String(value || "").trim().replace(/^0x/i, "").toLowerCase();
}

export function RegistryPanel({ onHashes }) {
  const [address, setAddress] = useState("");
  const [queryAddress, setQueryAddress] = useState("");
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState("Loading registry configuration…");
  const [loading, setLoading] = useState(false);
  const [request, setRequest] = useState(0);
  const [hashInput, setHashInput] = useState("");
  const [hashQuery, setHashQuery] = useState("");
  const [hashError, setHashError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const saved = (localStorage.getItem("registry") || "").trim();
        const fromEnv = String(import.meta.env.VITE_REGISTRY_ADDRESS || "").trim();
        if (saved || fromEnv) {
          const initial = saved || fromEnv;
          if (active) {
            setAddress(initial);
            setQueryAddress(initial);
          }
          return initial;
        }
        const response = await fetch("/config.json");
        if (!response.ok) throw new Error(`config.json returned ${response.status}`);
        const config = await response.json();
        const initial = String(config.registry || "").trim();
        if (active) {
          setAddress(initial);
          setQueryAddress(initial);
        }
        return initial;
      } catch (error) {
        if (active) setStatus(error.message);
        return "";
      }
    })().then((initial) => {
      if (!active) return;
      if (initial) setRequest((value) => value + 1);
      else setStatus("No registry address configured. Add a FinalityRegistry address to load reports.");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!request) return undefined;
    let active = true;
    const load = async () => {
      setLoading(true);
      setRows([]);
      onHashes(new Map());
      if (!queryAddress.trim()) {
        setStatus("No registry address configured. Add a FinalityRegistry address to load reports.");
        setLoading(false);
        return;
      }
      setStatus("Reading on-chain reports…");
      const provider = new JsonRpcProvider(EVM_RPC, CHAIN_ID, { staticNetwork: true });
      try {
        const code = await provider.getCode(queryAddress.trim());
        if (code === "0x") {
          setStatus(`No contract code at ${queryAddress.trim()}.`);
          return;
        }
        const registry = new Contract(queryAddress.trim(), registryAbi, provider);
        const total = Number(await registry.count());
        const loaded = [];
        const hashes = new Map();
        let latest = null;
        for (let id = 0; id < total; id += 1) {
          const [snapshot, lag] = await Promise.all([registry.get(id), registry.beefyLag(id)]);
          latest = snapshot;
          hashes.set(String(snapshot.payloadHash).toLowerCase(), id);
          loaded.push({
            id,
            best: Number(snapshot.bestBlock),
            grandpa: Number(snapshot.grandpaFinalized),
            beefy: Number(snapshot.beefyFinalized),
            lag: Number(lag),
            hash: String(snapshot.payloadHash),
            archive: await archiveFor(snapshot.payloadHash, snapshot),
          });
          if (active) {
            setRows([...loaded]);
            onHashes(new Map(hashes));
          }
        }
        if (!active) return;
        if (!latest) {
          setStatus(`0 reports on EVM chain ${CHAIN_ID}.`);
          return;
        }
        const publishedAt = Number(latest.timestamp);
        const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000 - publishedAt));
        const reporter = String(latest.reporter);
        setStatus(`${total} report${total === 1 ? "" : "s"} · latest ${ageLabel(ageSeconds)} · reporter ${reporter.slice(0, 6)}…${reporter.slice(-4)} · ${new Date(publishedAt * 1000).toISOString()}`);
      } catch (error) {
        if (active) setStatus(error.message);
      } finally {
        provider.destroy();
        if (active) setLoading(false);
      }
    };
    load();
    return () => { active = false; };
  }, [request, queryAddress, onHashes]);

  const submit = (event) => {
    event.preventDefault();
    localStorage.setItem("registry", address.trim());
    setQueryAddress(address.trim());
    setRequest((value) => value + 1);
  };

  const submitHashLookup = (event) => {
    event.preventDefault();
    const value = hashValue(hashInput);
    if (!/^[0-9a-f]{64}$/.test(value)) {
      setHashQuery("");
      setHashError("Enter a 32-byte payload hash or transaction hash.");
      return;
    }
    setHashError("");
    setHashQuery(value);
  };

  const visibleRows = hashQuery
    ? rows.filter((row) => hashValue(row.hash) === hashQuery || hashValue(row.archive.txHash) === hashQuery)
    : rows;

  return (
    <section className="surface data-surface">
      <header className="surface-heading registry-heading">
        <div><h2>Attestation registry</h2><p>Compare report fields with the on-chain record and verify the archived bytes against its hash. Consensus signatures are not verified.</p></div>
        <form className="registry-form" onSubmit={submit}>
          <label htmlFor="registry-address">FinalityRegistry address</label>
          <div><input id="registry-address" value={address} onChange={(event) => setAddress(event.target.value)} spellCheck="false" autoComplete="off" /><button className="button button-primary" type="submit" disabled={loading}>{loading ? "Loading…" : "Load reports"}</button></div>
        </form>
      </header>
      <p className="table-status" role="status">{status}</p>
      <form className="hash-investigator" onSubmit={submitHashLookup}>
        <label htmlFor="report-hash">Investigate a report by hash</label>
        <div><input id="report-hash" type="text" value={hashInput} onChange={(event) => { setHashInput(event.target.value); setHashError(""); }} placeholder="Paste payload hash or publication transaction hash" spellCheck="false" autoComplete="off" aria-invalid={Boolean(hashError)} aria-describedby="report-hash-help" /><button className="button button-primary" type="submit">Find report</button>{hashQuery && <button className="button button-secondary" type="button" onClick={() => { setHashInput(""); setHashQuery(""); setHashError(""); }}>Clear</button>}</div>
        <span id="report-hash-help">Searches this registry’s on-chain reports. Matching report rows include archived-byte and field checks.</span>
        {hashError && <p className="lookup-message lookup-error" role="alert">{hashError}</p>}
        {hashQuery && !loading && <p className={`lookup-message ${visibleRows.length ? "lookup-found" : "lookup-miss"}`} role="status">{visibleRows.length ? `Found report${visibleRows.length === 1 ? "" : "s"} ${visibleRows.map((row) => `#${row.id}`).join(", ")}. Inspect the matching row below.` : "No report in this registry matches that hash."}</p>}
      </form>
      <div className="table-scroll"><table><thead><tr><th>ID</th><th>Best</th><th>GRANDPA</th><th>BEEFY</th><th>Lag</th><th>Payload hash</th><th>Archive</th></tr></thead>
        <tbody>{visibleRows.map((row) => <tr key={row.id} className={hashQuery ? "report-row-match" : undefined}><td>{row.id}</td><td><a href={`${SCANNER}/blocks/${row.best}`} target="_blank" rel="noreferrer">{row.best.toLocaleString()}</a></td><td><a href={`${SCANNER}/blocks/${row.grandpa}`} target="_blank" rel="noreferrer">{row.grandpa.toLocaleString()}</a></td><td><a href={`${SCANNER}/blocks/${row.beefy}`} target="_blank" rel="noreferrer">{row.beefy.toLocaleString()}</a></td><td>{row.lag}</td><td className="table-hash" title={row.hash}>{row.hash}</td><td><div className="evidence-checks"><span className={`archive-state ${row.archive.match === "matches file" ? "is-match" : row.archive.match === "file differs" ? "is-error" : ""}`}>Hash · {row.archive.match}</span><span className={`archive-state ${row.archive.fieldsMatch === true ? "is-match" : row.archive.fieldsMatch === false ? "is-error" : ""}`}>Report fields · {row.archive.fieldsMatch == null ? "not checked" : row.archive.fieldsMatch ? "match" : "mismatch"}</span></div>{row.archive.txHash && <span className="table-meta">Tx {row.archive.txHash}</span>}{row.archive.blockNumber && <a className="table-meta" href={`${SCANNER}/blocks/${row.archive.blockNumber}`} target="_blank" rel="noreferrer">Included in block {row.archive.blockNumber}</a>}</td></tr>)}</tbody>
      </table>{!loading && visibleRows.length === 0 && <div className="table-empty">{hashQuery ? "No matching report in the loaded registry" : "No reports loaded"}</div>}</div>
    </section>
  );
}

export function VerifyPanel({ publishedHashes }) {
  const [payload, setPayload] = useState("");
  const [result, setResult] = useState(null);
  const hash = (raw, canonical) => {
    try {
      const body = canonical ? canonicalJson(JSON.parse(raw)) : raw;
      const digest = keccak256(toUtf8Bytes(body));
      const match = publishedHashes.get(digest.toLowerCase());
      setResult({ digest, status: match == null ? (publishedHashes.size ? "miss" : "neutral") : "match", detail: match == null ? "" : `Matches report ${match}` });
    } catch (error) {
      setResult({ status: "miss", detail: error.message });
    }
  };
  return <section className="surface verify-surface"><header className="surface-heading"><div><h2>Verify a snapshot hash</h2><p>Compare canonical JSON or exact archived bytes with a loaded registry report.</p></div></header>
    <label className="field-label" htmlFor="snapshot-json">Snapshot JSON</label><textarea id="snapshot-json" rows="10" value={payload} onChange={(event) => setPayload(event.target.value)} spellCheck="false" />
    <div className="form-actions"><button type="button" className="button button-primary" onClick={() => hash(payload, true)}>Hash canonical JSON</button><button type="button" className="button button-secondary" onClick={() => hash(payload, false)}>Hash exact text</button></div>
    {result && <p className={`hash-result ${result.status}`} role="status"><strong>{result.detail || result.digest}</strong>{result.digest && result.detail && <code>{result.digest}</code>}</p>}
  </section>;
}
