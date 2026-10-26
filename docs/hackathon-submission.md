# Portaldot Hacker House 2026 Submission Pack

## Project summary

**Project:** Portaldot Finality<br>
**Track:** Node Operations & Tooling<br>
**Source repository:** [github.com/0xNana/portaldot-finality](https://github.com/0xNana/portaldot-finality)<br>
**One sentence:** Portaldot Finality gives operators one live view of BABE block production, GRANDPA finality, and BEEFY checkpoint lag, with snapshots they can hash-check against a Portaldot V3 EVM registry.

## Working schedule

Portaldot's timeline update lists Office Hours on **Oct 28–29**, final submission/code freeze at **Nov 6, 04:00 UTC**, Demo Day on **Nov 8–9**, and Community Choice voting from **Nov 9, 16:00 UTC to Nov 10, 16:00 UTC**. Check [Portaldot's timeline update](https://teapawt.org/PortaldotL0/status/2109577148109381814) or the official Discord for later changes. The check-in feedback time in the listing was Oct 26 at 16:00 UTC; check DoraHacks or Discord for the result.

### Problem

An operator checking only the latest block can miss where the finality pipeline is falling behind. Portaldot Finality puts the best head, GRANDPA-finalized head, BEEFY-finalized head, slot observations, and session authors in one live view, then preserves a reporter-submitted snapshot hash on Portaldot V3.

### First user hypothesis

The first user is a Portaldot node or validator-program operator who needs to identify which consensus stage is lagging and inspect what a monitor observed. Bridge-facing teams may also care about BEEFY freshness, but the current product does not verify BEEFY signatures or gate bridge execution. Validate the primary user and the useful alert thresholds with Portaldot during Office Hours before broadening the scope.

### Why Portaldot is part of the product

The monitor reads BABE, GRANDPA, session, and BEEFY state from Portaldot V3's native WebSocket API. It anchors report fields and a canonical JSON hash through the V3 EVM execution environment. The dashboard reads both sides: native consensus state and the EVM registry. This is a practical use of the V3 network's native and EVM-compatible capabilities.

## What works

- Live best, GRANDPA, and BEEFY heads with lag calculations and configurable thresholds.
- BABE author attribution from the pre-runtime digest and current session validator list.
- A freshness state when the browser receives no new head within the configured time window.
- A `FinalityRegistry` deployed at `0x4438B228A44aF949bcb6417BA13536909f3E37A9` on chain `420420777`.
- A published snapshot (`id 0`) whose archived JSON bytes match its on-chain payload hash.
- A dashboard that reads the registry, shows report age and reporter, compares each payload hash against the archive, and links report blocks through the scanner's confirmed block route.
- A CLI collector that can point at another RPC endpoint for the same network through `SUBSTRATE_WS`.

## Trust boundary

The registry is an append-only report log. It stores values supplied by an allowlisted reporter and a hash of off-chain JSON. It does not validate BABE, GRANDPA, or BEEFY proofs, and the report hash proves only that the archived bytes match the value recorded by the reporter. The dashboard is an observer and diagnostic aid, not a trustless verifier or a bridge safety control.

`skippedSlotsObserved` counts gaps between heads delivered to this collector. A dropped WebSocket notification can look like a slot gap, so the interface labels it as an observed gap rather than a protocol-confirmed skipped slot.

## Demo script (under three minutes)

**0:00–0:20 — Establish the live source**<br>
Open Overview. Point out the Portaldot V3 chain, RPC host, live connection state, and last-head age. Explain that the banner turns stale if no new head arrives within the configured window.

**0:20–1:05 — Show the finality pipeline**<br>
Compare Best, GRANDPA, and BEEFY. Explain GRANDPA lag as Best minus GRANDPA, and BEEFY lag as GRANDPA minus BEEFY. Show the threshold meters and the short page-local lag trend. Say that history begins when this page connects.

**1:05–1:30 — Show production visibility**<br>
Open Production. Show the session validator positions and the BABE authors observed since this page connected. Explain that this is a sample from the current browser session, not a historical performance ranking.

**1:30–2:20 — Follow the on-chain evidence**<br>
Open Registry. Show the snapshot row, payload hash, archive match, reporter, publication age, and link to the containing scanner block. Open Verify and hash the archived JSON in exact-byte mode if the live demo environment allows it.

**2:20–2:50 — State the boundary and value**<br>
Explain that the report is reporter-submitted and hash-anchored; consensus proofs are not verified by the contract. Close with the operator job: see which stage is behind and inspect the report before investigating.

Use a fresh, live snapshot in the final recording. If the network is healthy and no alert fires, show the healthy state. Any replay or simulated condition must be visibly labeled as replay/simulation.

## Office Hours questions

1. For the Node Operations & Tooling track, is the first useful deployment a monitor for one operator-owned RPC endpoint, or a shared view of multiple Portaldot nodes?
2. Which BABE, GRANDPA, and BEEFY metrics and alert thresholds would Portaldot's node or validator program actually use during an incident?
3. Which RPC data or proof format should a future version consume to independently validate GRANDPA justifications or BEEFY commitments? Is that a current ecosystem need or a later roadmap item?
4. Would a self-hosted collector with JSON/Prometheus-style metrics fit the node program's tooling, and what is the simplest integration path?

## Adoption and continuation hypothesis

Keep the first release open-source and self-hostable. A Portaldot operator can run the collector against its own same-network RPC endpoint; the public dashboard provides a reference view of the shared testnet endpoint. If operators need a managed multi-node service, alert routing, or longer history, validate those needs before building a hosted product. The potential ecosystem path is integration with Portaldot's node and validator operations program; no adoption commitment has been secured yet.

## Pitch deck copy

### Slide 1 — Portaldot Finality

**Subtitle:** See which stage of the Portaldot finality pipeline is falling behind.<br>
**Footer:** Node Operations & Tooling · Portaldot Hacker House 2026

**Speaker note:** This project gives Portaldot operators one live view across block production, GRANDPA finality, and BEEFY checkpoints.

### Slide 2 — The operator problem

**Headline:** A latest-block number alone does not show where finality is waiting.<br>
**Main copy:** Operators need to distinguish slow block production from GRANDPA lag and BEEFY lag, then inspect the data behind the alert.<br>
**User:** Portaldot node and validator-program operators. This first-user hypothesis is still being validated.

**Speaker note:** The dashboard calculates GRANDPA lag as Best minus GRANDPA, and BEEFY lag as GRANDPA minus BEEFY. The interface reports freshness so an old view does not look current.

### Slide 3 — The operator view

**Headline:** One live view shows the head, both finality stages, and production.<br>
**Main copy:** Best · GRANDPA · BEEFY · session authors · lag thresholds · feed freshness.<br>
**Evidence to show:** Use a current dashboard screenshot or the live product. Capture it from the final deployed build after a fresh network connection.

**Speaker note:** The author counts begin when the page connects. They describe this session, not a historical validator-performance ranking.

### Slide 4 — Portaldot V3 integration

**Headline:** Native consensus reads and a V3 EVM report registry.<br>
**Flow:** Portaldot native WebSocket → observer → lag and author metrics → canonical JSON → keccak256 → `FinalityRegistry` on Portaldot V3 EVM.<br>
**Boundary:** The registry anchors a reporter's snapshot hash. It does not verify GRANDPA or BEEFY proofs.

**Speaker note:** The mixed integration is useful because the monitor reads consensus state from the native API and records a reproducible report on the V3 EVM side. The report is hash-checkable; consensus truth remains unverified by the contract.

### Slide 5 — Testnet evidence

**Network:** Portaldot V3 testnet · chain ID `420420777`<br>
**Registry:** `0x4438B228A44aF949bcb6417BA13536909f3E37A9`<br>
**Deployment:** transaction `0x6575da61e037844b9ed9f6785c9fd73f2eff55f47642f0dd0c93d2e9b93e4dde` · [block 173034](https://scanner-testnet-v3.portaldot.dev/blocks/173034)<br>
**First report:** transaction `0xa721afc66a1787eb29fda92ba03b3f52f7a289c05320007798415aadabb13e4b` · [block 173181](https://scanner-testnet-v3.portaldot.dev/blocks/173181)<br>
**Archive:** snapshot `id 0` · payload hash `0x6360ee55176421d34340185d27176baf107cb500e1d358e5f43d68f3adc0d577` · archived bytes match the on-chain hash.

**Speaker note:** These are the currently checked-in evidence values from October 24. Replace the report row with a newly published snapshot before final presentation. Do not describe this report as cryptographic proof of finality.

### Slide 6 — Adoption path

**Headline:** Start with a self-hosted operator monitor.<br>
**Next step:** Use Office Hours to validate the first operator, useful alert thresholds, and whether the node program wants one-node or multi-node visibility.<br>
**Continuation:** Keep the collector and dashboard open-source; consider managed multi-node monitoring only if operators ask for it.

**Speaker note:** No user adoption or integration commitment has been secured yet. The next milestone is an operator-confirmed workflow and a fresh, repeatable testnet report.

## Final handoff checklist

- [x] Project and track are stated clearly.
- [x] Contract deployment and first report are documented in `README.md`.
- [x] The runnable local commands and environment configuration are documented.
- [ ] Capture a fresh four-head observation from a network-connected environment.
- [ ] Publish a fresh snapshot from the funded testnet reporter and add its generated archive and metadata.
- [ ] Confirm the GitHub repository and deployed dashboard are publicly accessible without sign-in.
- [ ] Record and publish a product demo video under three minutes.
- [ ] Export the six-slide copy below as a pitch deck PDF and attach it to the submission. PDF authoring is still pending because the required presentation authoring runtime is not available in this environment.
- [x] Office Hours application submitted.
- [ ] Use Office Hours (Oct 28–29) to validate the target operator, alert thresholds, and next integration.
- [ ] Confirm the current event schedule in DoraHacks or the official Discord before final submission.

The direct testnet WebSocket was unavailable from the editing environment during the October 26 capture attempt (WebSocket close code `1006`). No new chain report has been fabricated; capture and publication remain explicit handoff steps.
