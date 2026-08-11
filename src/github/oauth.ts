import { env } from "../env";
import { insertOauthState, takeOauthState } from "../db/repositories/githubOauthState";

const STATE_TTL_MS = 15 * 60 * 1000;

export const createInstallState = (): string => {
  const state = crypto.randomUUID();
  insertOauthState(state);
  return state;
};

export const buildInstallUrl = (state: string): string =>
  `https://github.com/apps/${env.GH_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`;

// false if the state is unknown (never issued, or already consumed) or older than STATE_TTL_MS —
// either way the caller should treat the callback as untrusted.
export const consumeInstallState = (state: string): boolean => {
  const row = takeOauthState(state);
  if (!row) return false;
  return Date.now() - Date.parse(row.createdAt) <= STATE_TTL_MS;
};

// Validates the App's OAuth config end-to-end (not persisted/used elsewhere in M3+M4) — fails
// loudly here rather than silently accepting a misconfigured Client ID/secret.
export const exchangeOauthCode = async (code: string): Promise<void> => {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.GH_APP_CLIENT_ID, client_secret: env.GH_APP_CLIENT_SECRET, code }),
  });
  const body = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!res.ok || !body?.access_token) throw new Error("GitHub OAuth code exchange failed");
};
