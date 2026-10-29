# RIFT self-hosted operator product — implementation plan

## Goal

Turn the current browser demo into an installable single-team product: one command serves the dashboard and API, one server-side collector monitors Portaldot V3, observations survive page reloads and service restarts, and operators can see source health without exposing RPC credentials to the browser.

This is the first internal/pilot product slice. It does not add public signup, team auth, billing, or consensus-proof verification.

## Architecture decisions

- Use Node's built-in SQLite for one self-hosted instance, with retention and an append-only observation history. Require Node 24.15+ for the SQLite API available in the current runtime.
- Run one server-side Portaldot monitor with reconnect/backoff. Persist each observed best/GRANDPA/BEEFY sample and current-session validator counts.
- Serve the built React app and a same-origin, read-only versioned API from the same Node process. Bind to loopback by default because the first release has no authentication.
- Keep the browser RPC adapter for `pnpm dev` fallback; a product server advertises itself through its JSON health route and the app switches to persisted service data when present.
- Do not put reporter signing keys in the service or browser. On-chain publishing remains an explicit operator workflow.

## Task list

### Slice 1 — persistent data contract

- [x] Create the SQLite schema/store, query pagination, retention cleanup, and the versioned API response contract.
- [x] Validate every query parameter at the API boundary; use a consistent `{ error: { code, message } }` shape.
- [x] Keep block heights as decimal text in storage and JSON to avoid precision loss.

### Slice 2 — always-on monitor and service

- [x] Reuse the existing Portaldot tracker/BABE/BEEFY calculations in a Node service.
- [x] Add reconnect with bounded backoff, structured logs, shutdown cleanup, `/api/health`, `/api/v1/current`, and `/api/v1/observations`.
- [x] Serve static production assets safely from the same origin and keep the default bind on `127.0.0.1`.

### Slice 3 — operator dashboard

- [x] Prefer the service API when present and retain direct-RPC behavior for the existing Vite development flow.
- [x] Restore persisted trend/activity history after reload while keeping current validator production clearly session-local.
- [x] Show service status, source freshness, retention, and useful loading/error states.

### Slice 4 — make it runnable

- [x] Add a `pnpm product` command and required Node version.
- [x] Document setup, safe LAN/reverse-proxy exposure, storage/retention, and limits in the README/product guide.

## Checkpoint and verification

- [x] Vite production build succeeds when directed to a writable output directory.
- [x] Start the built product and confirm the health endpoint and invalid-query response use the documented JSON shapes.
- [x] Confirm 12 observations persisted across a service restart and rendered in the dashboard's chart, finality cards, and activity table.
- [x] Confirm the restarted service reports a connecting source while showing the timestamp of its last saved observation.
- [x] Inspect logs and API output for credentials or full RPC URLs; endpoint paths are redacted.

## Risks

- Node's built-in SQLite API is a recent addition. Pin the runtime floor and keep the storage adapter narrow so a mature SQLite package or Postgres can replace it later.
- The browser currently has a direct RPC path. Product mode must be selected only when the same-origin API proves available, or local development can appear broken.
- No authentication is included. The server must bind to loopback by default and must not be exposed to the public internet as-is.
- RPC observations and archive consistency are not consensus-proof validation.
