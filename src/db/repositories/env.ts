import { db } from "../client";

export type ClientEnvVar = { key: string; value: string };

// Resolves a client's full env directly by slug (join through clients) — this is what
// spawnWorker() calls, so a worker's entire env comes from here, never from process.env.
export const getEnvForSlug = (slug: string): Record<string, string> => {
  const rows = db
    .query(
      `SELECT client_env.key as key, client_env.value as value
       FROM client_env
       JOIN clients ON clients.id = client_env.client_id
       WHERE clients.slug = ?`,
    )
    .all(slug) as ClientEnvVar[];
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
};

export const listEnvForClient = (clientId: number): ClientEnvVar[] =>
  db.query("SELECT key, value FROM client_env WHERE client_id = ? ORDER BY key").all(clientId) as ClientEnvVar[];

export const setEnvVar = (clientId: number, key: string, value: string): void => {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO client_env (client_id, key, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(client_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(clientId, key, value, now, now);
};

export const deleteEnvVar = (clientId: number, key: string): void => {
  db.query("DELETE FROM client_env WHERE client_id = ? AND key = ?").run(clientId, key);
};

export const deleteEnvForClient = (clientId: number): void => {
  db.query("DELETE FROM client_env WHERE client_id = ?").run(clientId);
};
