# RIFT self-hosted monitor

RIFT can run as a small, always-on operator service. It reads the Portaldot V3 Substrate WebSocket from the server, stores observed heads and finality readings in SQLite, and serves the dashboard and a read-only API from one origin.

This is a single-instance pilot for a trusted operator workstation. It has no user accounts, team permissions, billing, or consensus-proof verification. The on-chain registry still stores reporter-submitted observations; it does not verify GRANDPA justifications or BEEFY signatures.

## Requirements

- Node.js 24.15 or newer
- pnpm 12 or newer
- Network access from the host to the configured Portaldot V3 WebSocket endpoint

## Start the product

```bash
pnpm install
cp .env.example .env
# Set SUBSTRATE_WS if you use a different endpoint for this Portaldot V3 network.
pnpm product
```

The command builds the dashboard, starts the monitor, and serves it at [http://127.0.0.1:4179](http://127.0.0.1:4179). Keep the process running while you want RIFT to collect observations. Use `pnpm dev` for frontend development; that mode continues to read directly from the browser.

The product service verifies the endpoint's chain name, runtime spec, and configured Portaldot V3 genesis hash before collecting data. It does not need a signing key. Do not add reporter keys to the monitor service configuration.

## Service configuration

| Variable | Default | Purpose |
|---|---:|---|
| `SUBSTRATE_WS` | `wss://test-node-v3.portaldot.dev` | Portaldot V3 Substrate WebSocket, read by the server |
| `GRANDPA_LAG_THRESHOLD` | `6` | GRANDPA lag warning threshold in blocks |
| `BEEFY_LAG_THRESHOLD` | `24` | BEEFY lag warning threshold in blocks |
| `RIFT_HOST` | `127.0.0.1` | HTTP bind address |
| `RIFT_PORT` | `4179` | HTTP port |
| `RIFT_DATA_DIR` | `.data` | Directory for the SQLite database |
| `RIFT_BUILD_DIR` | `dist` | Dashboard build output and static serving directory |
| `RIFT_HISTORY_DAYS` | `30` | Observation retention, from 1 to 3650 days |
| `RIFT_STALE_AFTER_SECONDS` | `30` | Head freshness threshold, from 1 to 3600 seconds |
| `RIFT_CORS_ORIGINS` | empty | Comma-separated exact browser origins allowed to read the API |

To keep the database outside the repository, set `RIFT_DATABASE` to its full path. If unset, the database is `.data/rift.sqlite` under the project directory. Local database files are gitignored. Retention cleanup runs at startup and after new observations.

The service binds to loopback by default and has no authentication. The Fly deployment binds publicly and exposes the read-only API. Do not put secrets or private operational data in observations. For shared or sensitive team operations, put the service behind an authenticated private network or reverse proxy and add user access controls.

## Read-only API

API responses are JSON and use `{ "error": { "code", "message" } }` for errors. Same-origin requests work by default. To host the dashboard separately (for example, on Vercel), set `VITE_API_BASE_URL` to the RIFT API origin in the Vercel project environment, then set `RIFT_CORS_ORIGINS` on Fly to the exact Vercel origin (for example, `https://rift.example.com`). The local `.env` is ignored by Git and is not uploaded during a Vercel cloud build.

- `GET /api/health` — service and source-monitor status
- `GET /api/v1/current` — current readings, session validator counts, and storage metadata
- `GET /api/v1/observations?limit=200&since=<epoch-ms>&until=<epoch-ms>` — retained history
- `GET /api/v1/observations?before=<id>&limit=200` — older page
- `GET /api/v1/observations?after=<id>&limit=200` — observations after a cursor

The `limit` is 1–500. Block heights are decimal strings in the API and SQLite. Observation timestamps are Unix milliseconds. `before` and `after` are mutually exclusive. The dashboard loads the latest 500 observations and keeps its in-memory chart window to 600 points; the database retains the configured history window.

## What the readings mean

RIFT records best heads, GRANDPA finalized heads, BEEFY finalized checkpoints, observed finality lag, and BABE slot gaps between delivered WebSocket heads. A disconnected WebSocket can make delivered-head slot gaps differ from protocol-level missed production. Validator author counts are local to the current monitor process and reset when that process restarts. The time-series history is retained separately.

The monitor reports what its configured RPC endpoint returned. The database makes those readings durable and inspectable; it does not turn them into consensus proofs or independently validate the endpoint's answers.

## Product boundary

This release makes RIFT usable by an operator who can run a trusted single-instance service. A paid multi-team product still needs account and role management, authenticated deployment, alert delivery, managed retention, backups, support, and a clear service-level promise. Those features should follow a pilot with a real validator or network operations team rather than being implied by the hackathon demo.
