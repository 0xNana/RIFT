# RIFT productization roadmap

**Brand:** RIFT — Onchain Intelligence  
**First product:** a finality operations and incident-evidence tool for Portaldot V3 node and validator-program operators.

RIFT is not trying to be a general block explorer. It helps an operator see which stage of the BABE → GRANDPA → BEEFY pipeline is behind, decide whether the RPC feed is fresh, and investigate a report by its payload hash or publication transaction.

## What works today

- A React dashboard reads Portaldot V3 Substrate telemetry and the EVM-hosted registry. `pnpm dev` uses the browser RPC adapter; `pnpm product` runs the Substrate monitor server-side.
- The self-hosted product mode keeps an always-on monitor with reconnect/backoff, graceful shutdown, a health endpoint, and a same-origin read API.
- RIFT stores timestamped head/finality observations in SQLite, reloads history after page or process restarts, and applies a configurable retention window. The default is 30 days.
- The Overview shows best, GRANDPA, and BEEFY heads, lag, thresholds, source health, and session-local observations.
- Production attributes blocks from BABE pre-digests to the current session validator set. Counts reset when the monitor service restarts; the history is retained separately.
- Reports can be found by payload hash or publication transaction hash. RIFT hashes the exact archived bytes and compares six stored report fields with the archive.
- A CLI collector can observe a bounded number of new heads and write JSONL plus a snapshot. The publisher can hash and publish a snapshot to the registry.

The self-hosted service is a single-instance pilot, not a shared hosted product. It has no team authentication, external alert delivery, managed backups, hosted workspace, billing, or consensus-proof validation. The registry stores reporter-submitted values; archive consistency does not prove that an observation is true.

## Phase 1 — pilot readiness

The first product slice is implemented. Before a team relies on it for on-call operations, the deployment should add:

1. A process supervisor, monitored backups, and a restore procedure for the SQLite history.
2. A timestamped incident bundle with source/runtime identity, threshold settings, observed heads, and related report hashes.
3. External alert delivery for stale telemetry and sustained finality lag, with deduplication and recovery notifications.
4. An authenticated private deployment before more than one trusted operator uses the dashboard.

Keep the RPC URL and any credentials in server-side configuration, and never put a reporter private key in the monitor service.

## Phase 2 — validate the operator workflow

Add alert rules for stale telemetry, GRANDPA lag, BEEFY lag, and observed slot gaps. Include duration, deduplication, and a recovery notification so one noisy endpoint does not flood the team. Send alerts to a webhook or the team's chosen chat channel; attach the source context and a link to the RIFT investigation view.

Pilot with one Portaldot operator team before building a general hosted product. Track whether alerts were actionable, how quickly the operator identified the lagging stage, how often the source was simply stale, and which retention or integrations the team actually needs. A successful demo is not evidence of demand; use the pilot to decide what to build next.

## Phase 3 — charge for the workflow teams request

If teams ask for shared access and managed operations, add tenant-isolated workspaces, roles, endpoint management, alert routing, incident history, retention controls, audit logs, and subscription billing. Start with a hosted team plan based on monitored environments and retention rather than charging for generic RPC traffic. Keep a self-hosted option for teams that need to retain control of their endpoints and data.

Do not set a price or promise multiple chains until the pilot shows what teams value and what it costs to operate. Keep RIFT's focus on finality-stage visibility and evidence handoff: RPC providers already offer broad event notifications, so notifications alone are not a durable differentiator ([Alchemy Webhooks overview](https://www.alchemy.com/docs/reference/webhooks-overview)).

## Product boundary

RIFT can report observed head positions, calculated lag, feed freshness, session-local production, and whether a submitted report matches its archived bytes and stored fields. Today it cannot establish consensus truth or verify BABE, GRANDPA, or BEEFY proofs. Keep this boundary explicit in the UI, alert copy, evidence exports, and sales material until proof verification is actually implemented and independently checked.
