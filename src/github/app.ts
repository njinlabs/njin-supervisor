import { createSign } from "node:crypto";
import { env } from "../env";

export const isGithubAppConfigured = (): boolean => Boolean(env.GH_APP_ID);

const base64url = (input: Buffer | string): string =>
  (Buffer.isBuffer(input) ? input : Buffer.from(input)).toString("base64url");

// GH_APP_PRIVATE_KEY is stored as base64 of the App's downloaded .pem (raw multi-line PEM in a
// .env value is fragile across shells/parsers) — decode it back to PEM here, at use time.
const getPrivateKeyPem = (): string => Buffer.from(env.GH_APP_PRIVATE_KEY!, "base64").toString("utf8");

// Short-lived JWT identifying the App itself (not an installation) — required for App-level
// endpoints like listing installations, and to mint an installation access token.
export const getAppJwt = (): string => {
  if (!isGithubAppConfigured()) throw new Error("GitHub App is not configured");

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat backdated 60s for clock drift between this host and GitHub's, per GitHub's own docs.
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: env.GH_APP_ID }));
  const signature = base64url(createSign("RSA-SHA256").update(`${header}.${payload}`).sign(getPrivateKeyPem()));

  return `${header}.${payload}.${signature}`;
};

type CachedToken = { token: string; expiresAtMs: number };
const installationTokenCache = new Map<number, CachedToken>();
// Refresh this far ahead of GitHub's own expiry so an in-flight request never gets handed a
// token that expires mid-call.
const TOKEN_REFRESH_SKEW_MS = 60_000;

// forceRefresh bypasses the cache — an installation token's repository access is fixed at the
// moment it's minted, not re-evaluated live per-request, so a token cached from before a repo was
// added to the installation would keep "hiding" that repo from GET /installation/repositories
// for up to an hour otherwise. Only the repo-listing call (where staleness is directly visible to
// the admin picking a repo) needs this; the more frequent workflow-commit/secret-set calls during
// actual client creation are fine reusing a token that's at most a few minutes old.
export const getInstallationToken = async (installationId: number, opts: { forceRefresh?: boolean } = {}): Promise<string> => {
  const cached = installationTokenCache.get(installationId);
  if (!opts.forceRefresh && cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) return cached.token;

  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${getAppJwt()}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`Failed to mint installation token: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as { token: string; expires_at: string };
  installationTokenCache.set(installationId, { token: body.token, expiresAtMs: Date.parse(body.expires_at) });
  return body.token;
};
