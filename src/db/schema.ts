import { db } from "./client";

// Idempotent — same "ensure tables at startup" pattern njin itself uses per-tenant, just for
// the supervisor's own control-plane data. Safe to call on every boot.
export const ensureSchema = (): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      repo_full_name TEXT,
      installation_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'manual',
      -- Hash of the per-client deploy token (SHA-256 hex) presented by that client's GitHub
      -- Actions workflow on POST /api/deploy/:slug — null until the client is connected via
      -- GitHub. Never store the raw token; it's shown once and set as a repo Actions secret.
      deploy_token_hash TEXT,
      -- Default branch of the connected repo at connect time, used both to commit the workflow
      -- file and to know which branch's pushes are expected to deploy.
      default_branch TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- A client can have several domains pointing at it; exactly one is primary (the canonical
    -- host workers actually serve under) and the rest redirect to it. The client's identity is
    -- its slug (clients.slug, also the clients/<slug>/ directory name), never a domain — a
    -- domain is just a pointer to a client, so it can be swapped/added without touching the
    -- worker/deploy pipeline at all.
    CREATE TABLE IF NOT EXISTS domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      host TEXT UNIQUE NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- Enforces at most one primary domain per client (SQLite partial unique index).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_one_primary_per_client
      ON domains(client_id) WHERE is_primary = 1;

    -- Per-client env vars, injected into that client's worker instead of the supervisor
    -- process's own env — a worker never inherits the supervisor's .env. Editable per client
    -- from the dashboard (not built yet); until a client has rows here, its worker boots with
    -- an empty env and will likely fail to reach its DB/storage, which is expected.
    CREATE TABLE IF NOT EXISTS client_env (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_client_env_unique_key ON client_env(client_id, key);

    CREATE TABLE IF NOT EXISTS deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      status TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      commit_sha TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      admin_user_id INTEGER NOT NULL REFERENCES admin_users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS github_oauth_state (
      state TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
  `);
};
