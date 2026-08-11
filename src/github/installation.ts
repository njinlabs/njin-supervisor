import { getAppJwt, getInstallationToken } from "./app";

export type GithubInstallation = { id: number; accountLogin: string };

export const listInstallations = async (): Promise<GithubInstallation[]> => {
  const res = await fetch("https://api.github.com/app/installations?per_page=100", {
    headers: {
      authorization: `Bearer ${getAppJwt()}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub API error listing installations: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as Array<{ id: number; account: { login: string } | null }>;
  return body.map((installation) => ({ id: installation.id, accountLogin: installation.account?.login ?? "unknown" }));
};

export type GithubRepo = { id: number; fullName: string; private: boolean; defaultBranch: string };

export const listRepositoriesForInstallation = async (installationId: number): Promise<GithubRepo[]> => {
  const token = await getInstallationToken(installationId);
  const res = await fetch("https://api.github.com/installation/repositories?per_page=100", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub API error listing repositories: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as {
    repositories: Array<{ id: number; full_name: string; private: boolean; default_branch: string }>;
  };
  return body.repositories.map((repo) => ({
    id: repo.id,
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch,
  }));
};
