import { getAppJwt, getInstallationToken } from "./app";

const PER_PAGE = 100;

// Paginates a GitHub REST endpoint by following `page=` until a page comes back with fewer than
// PER_PAGE items — used for both endpoints below, since either an account's installation count
// or an installation's repo count can plausibly exceed a single page (confirmed the hard way: an
// account with 100+ repos silently lost anything past the first page before this existed).
const fetchAllPages = async <T>(
  urlBase: string,
  headers: Record<string, string>,
  getItems: (body: unknown) => T[],
): Promise<T[]> => {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${urlBase}${urlBase.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`, {
      headers,
    });
    if (!res.ok) throw new Error(`GitHub API error (page ${page}): ${res.status} ${await res.text()}`);

    const items = getItems(await res.json());
    all.push(...items);
    if (items.length < PER_PAGE) return all;
  }
};

export type GithubInstallation = { id: number; accountLogin: string };

export const listInstallations = async (): Promise<GithubInstallation[]> => {
  const headers = {
    authorization: `Bearer ${getAppJwt()}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  const installations = await fetchAllPages<{ id: number; account: { login: string } | null }>(
    "https://api.github.com/app/installations",
    headers,
    (body) => body as Array<{ id: number; account: { login: string } | null }>,
  );
  return installations.map((installation) => ({
    id: installation.id,
    accountLogin: installation.account?.login ?? "unknown",
  }));
};

export type GithubRepo = { id: number; fullName: string; private: boolean; defaultBranch: string };

export const listRepositoriesForInstallation = async (installationId: number): Promise<GithubRepo[]> => {
  // forceRefresh: a cached token's repo access is snapshotted at mint time — without this, a
  // repo added to the installation after the last cached token was issued wouldn't show up here
  // for up to an hour. See the comment on getInstallationToken in github/app.ts.
  const token = await getInstallationToken(installationId, { forceRefresh: true });
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  const repos = await fetchAllPages<{ id: number; full_name: string; private: boolean; default_branch: string }>(
    "https://api.github.com/installation/repositories",
    headers,
    (body) => (body as { repositories: Array<{ id: number; full_name: string; private: boolean; default_branch: string }> })
      .repositories,
  );
  return repos.map((repo) => ({
    id: repo.id,
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch,
  }));
};
