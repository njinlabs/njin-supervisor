import { db } from "../client";

export type DeployRow = {
  id: number;
  client_id: number;
  status: string;
  triggered_by: string;
  commit_sha: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
};

export const createDeploy = (clientId: number, triggeredBy: string, commitSha: string | null): DeployRow => {
  const now = new Date().toISOString();
  const { lastInsertRowid } = db
    .query(`INSERT INTO deploys (client_id, status, triggered_by, commit_sha, started_at) VALUES (?, ?, ?, ?, ?)`)
    .run(clientId, "running", triggeredBy, commitSha, now);
  return db.query("SELECT * FROM deploys WHERE id = ?").get(lastInsertRowid) as DeployRow;
};

export const updateDeployStatus = (id: number, status: string, errorMessage?: string): void => {
  db.query("UPDATE deploys SET status = ?, error_message = ?, finished_at = ? WHERE id = ?").run(
    status,
    errorMessage ?? null,
    new Date().toISOString(),
    id,
  );
};

// Not surfaced in any UI yet (M5 territory — client-detail page) but available for it.
export const listDeploysForClient = (clientId: number): DeployRow[] =>
  db.query("SELECT * FROM deploys WHERE client_id = ? ORDER BY started_at DESC").all(clientId) as DeployRow[];
