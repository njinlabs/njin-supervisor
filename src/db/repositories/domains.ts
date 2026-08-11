import { db } from "../client";

export type ResolvedDomain = {
  host: string;
  isPrimary: boolean;
  clientId: number;
  clientSlug: string;
};

type DomainJoinRow = {
  host: string;
  is_primary: number;
  client_id: number;
  client_slug: string;
};

// Single lookup a request needs: is this host known, is it the primary domain for its client
// (serve it) or an alias (redirect it), and which client (slug) does it belong to.
export const findDomainByHost = (host: string): ResolvedDomain | null => {
  const row = db
    .query(
      `SELECT domains.host as host, domains.is_primary as is_primary,
              domains.client_id as client_id, clients.slug as client_slug
       FROM domains
       JOIN clients ON clients.id = domains.client_id
       WHERE domains.host = ?`,
    )
    .get(host) as DomainJoinRow | null;

  if (!row) return null;
  return {
    host: row.host,
    isPrimary: row.is_primary === 1,
    clientId: row.client_id,
    clientSlug: row.client_slug,
  };
};

export const findPrimaryHostForClient = (clientId: number): string | null => {
  const row = db.query("SELECT host FROM domains WHERE client_id = ? AND is_primary = 1").get(clientId) as
    | { host: string }
    | null;
  return row?.host ?? null;
};

export const listDomainsForClient = (clientId: number): { host: string; isPrimary: boolean }[] =>
  (db.query("SELECT host, is_primary FROM domains WHERE client_id = ? ORDER BY is_primary DESC, host").all(clientId) as {
    host: string;
    is_primary: number;
  }[]).map((row) => ({ host: row.host, isPrimary: row.is_primary === 1 }));

// The partial unique index (idx_domains_one_primary_per_client) enforces at most one primary
// per client at the DB level — this just fails loudly if a caller tries to add a second one
// without first demoting the existing primary.
export const addDomain = (clientId: number, host: string, isPrimary: boolean): void => {
  db.query(
    `INSERT INTO domains (client_id, host, is_primary, created_at) VALUES (?, ?, ?, ?)`,
  ).run(clientId, host, isPrimary ? 1 : 0, new Date().toISOString());
};

export const deleteDomainsForClient = (clientId: number): void => {
  db.query("DELETE FROM domains WHERE client_id = ?").run(clientId);
};
