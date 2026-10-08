// The schema, as an ordered list of migrations. Index N migrates user_version N -> N+1.
// Kept as a TS string (not a .sql file) so it bundles into the single executable untouched.
export const SCHEMA: readonly string[] = [
  `
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    caps TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE state (
    item_id TEXT PRIMARY KEY,
    position REAL NOT NULL,
    duration REAL NOT NULL,
    watched INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX state_recent ON state(updated_at);
  CREATE TABLE fs_items (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    rel TEXT NOT NULL,
    parent_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ms REAL NOT NULL DEFAULT 0,
    probe TEXT,
    broken INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL,
    sidecars TEXT,
    scan_id INTEGER NOT NULL DEFAULT 0,
    UNIQUE(root_id, rel)
  );
  CREATE INDEX fs_items_parent ON fs_items(parent_id);
  CREATE INDEX fs_items_added ON fs_items(added_at);
  `,
];
