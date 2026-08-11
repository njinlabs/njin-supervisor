import { db } from "../client";

export type ClientRow = {
  id: number;
  slug: string;
  repo_full_name: string | null;
  installation_id: number | null;
  status: string;
  source: string;
  deploy_token_hash: string | null;
  default_branch: string | null;
  created_at: string;
  updated_at: string;
};

export const listClients = (): ClientRow[] => db.query("SELECT * FROM clients ORDER BY slug").all() as ClientRow[];

export const findClientBySlug = (slug: string): ClientRow | null =>
  (db.query("SELECT * FROM clients WHERE slug = ?").get(slug) as ClientRow | null) ?? null;

export const findClientById = (id: number): ClientRow | null =>
  (db.query("SELECT * FROM clients WHERE id = ?").get(id) as ClientRow | null) ?? null;

// slug is the client's permanent identity (also the clients/<slug>/ directory name) — never a
// domain, since a client can have several domains pointing at it.
export const createClient = (
  slug: string,
  opts: {
    status?: string;
    source?: string;
    repoFullName?: string;
    installationId?: number;
    defaultBranch?: string;
    deployTokenHash?: string;
  } = {},
): ClientRow => {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO clients
       (slug, status, source, repo_full_name, installation_id, default_branch, deploy_token_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    slug,
    opts.status ?? "active",
    opts.source ?? "manual",
    opts.repoFullName ?? null,
    opts.installationId ?? null,
    opts.defaultBranch ?? null,
    opts.deployTokenHash ?? null,
    now,
    now,
  );
  return findClientBySlug(slug)!;
};

// Just this table's own row — callers needing the full cascade (domains, client_env, the worker,
// the on-disk build) go through deleteClientCascade in dashboard/clients.ts instead.
export const deleteClientById = (id: number): void => {
  db.query("DELETE FROM clients WHERE id = ?").run(id);
};

// Used by the "re-inject workflow" dashboard action: the raw deploy token is never stored (only
// its hash), so re-injecting the repo secret means minting a fresh token and rotating the stored
// hash to match — the old token (and any repo secret still holding it) stops verifying the
// moment this runs.
export const updateDeployTokenHash = (id: number, deployTokenHash: string): void => {
  db.query("UPDATE clients SET deploy_token_hash = ?, updated_at = ? WHERE id = ?").run(
    deployTokenHash,
    new Date().toISOString(),
    id,
  );
};
