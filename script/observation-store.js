import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const schema = `
  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    best_height TEXT NOT NULL,
    grandpa_height TEXT,
    beefy_height TEXT,
    best_hash TEXT,
    grandpa_lag INTEGER,
    beefy_lag INTEGER,
    slot_gaps INTEGER NOT NULL,
    metrics_json TEXT NOT NULL,
    validators_json TEXT NOT NULL,
    alerts_json TEXT NOT NULL,
    details_json TEXT NOT NULL,
    observed INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS observations_at_id ON observations(at, id);
`;

function decodeRow(row) {
  return {
    id: String(row.id),
    at: row.at,
    best: row.best_height,
    bestHash: row.best_hash,
    grandpa: row.grandpa_height,
    beefy: row.beefy_height,
    grandpaLag: row.grandpa_lag,
    beefyLag: row.beefy_lag,
    slotGaps: row.slot_gaps,
    metrics: JSON.parse(row.metrics_json),
    validators: JSON.parse(row.validators_json),
    alerts: JSON.parse(row.alerts_json),
    details: JSON.parse(row.details_json),
    observed: row.observed,
  };
}

export function openObservationStore(filePath, retentionDays) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(schema);

  const insert = db.prepare(`
    INSERT INTO observations (
      at, best_height, grandpa_height, beefy_height, best_hash,
      grandpa_lag, beefy_lag, slot_gaps, metrics_json, validators_json,
      alerts_json, details_json, observed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getLatest = db.prepare("SELECT * FROM observations ORDER BY id DESC LIMIT 1");
  const count = db.prepare("SELECT COUNT(*) AS total FROM observations");

  return {
    append(state) {
      const { metrics } = state;
      if (metrics.best == null || !Number.isSafeInteger(state.connection.updatedAt)) {
        throw new Error("observation requires a best height and timestamp");
      }
      const result = insert.run(
        state.connection.updatedAt,
        String(metrics.best),
        metrics.grandpa == null ? null : String(metrics.grandpa),
        metrics.beefy == null ? null : String(metrics.beefy),
        metrics.bestHash || null,
        Number.isSafeInteger(metrics.grandpaLag) ? metrics.grandpaLag : null,
        Number.isSafeInteger(metrics.beefyLag) ? metrics.beefyLag : null,
        Number.isSafeInteger(metrics.slotGaps) ? metrics.slotGaps : 0,
        JSON.stringify(metrics),
        JSON.stringify(state.validators || []),
        JSON.stringify(state.alerts || []),
        JSON.stringify(state.details || []),
        Number.isSafeInteger(state.observed) ? state.observed : 0,
      );
      return String(result.lastInsertRowid);
    },

    latest() {
      const row = getLatest.get();
      return row ? decodeRow(row) : null;
    },

    count() {
      return count.get().total;
    },

    list({ limit, since, until, before, after }) {
      const clauses = [];
      const values = [];
      if (since != null) { clauses.push("at >= ?"); values.push(since); }
      if (until != null) { clauses.push("at <= ?"); values.push(until); }
      if (before != null) { clauses.push("id < ?"); values.push(before); }
      if (after != null) { clauses.push("id > ?"); values.push(after); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const descending = before != null || (before == null && after == null);
      const order = descending ? "DESC" : "ASC";
      const statement = db.prepare(`SELECT * FROM observations ${where} ORDER BY id ${order} LIMIT ?`);
      const rows = statement.all(...values, limit + 1);
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      if (descending) pageRows.reverse();
      const observations = pageRows.map(decodeRow);
      return {
        observations,
        page: {
          limit,
          hasMore,
          nextBefore: hasMore && descending && observations.length ? observations[0].id : null,
          nextAfter: hasMore && !descending && observations.length ? observations.at(-1).id : null,
        },
      };
    },

    prune() {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      return db.prepare("DELETE FROM observations WHERE at < ?").run(cutoff).changes;
    },

    close() {
      db.close();
    },
  };
}
