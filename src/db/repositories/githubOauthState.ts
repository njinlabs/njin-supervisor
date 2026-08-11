import { db } from "../client";

// CSRF state for the GitHub App install flow. TTL is enforced in application code (github/oauth.ts)
// against created_at rather than a dedicated expiry column — consistent with this repo's
// "no migrations" approach to schema.ts.
export const insertOauthState = (state: string): void => {
  db.query("INSERT INTO github_oauth_state (state, created_at) VALUES (?, ?)").run(state, new Date().toISOString());
};

// Single-use: deletes the row regardless of outcome, so a state can never be replayed even if
// the caller decides it's expired.
export const takeOauthState = (state: string): { createdAt: string } | null => {
  const row = db.query("SELECT created_at FROM github_oauth_state WHERE state = ?").get(state) as
    | { created_at: string }
    | null;
  db.query("DELETE FROM github_oauth_state WHERE state = ?").run(state);
  return row ? { createdAt: row.created_at } : null;
};
