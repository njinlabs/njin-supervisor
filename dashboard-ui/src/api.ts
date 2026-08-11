export type ClientListItem = {
  slug: string;
  status: string;
  source: string;
  buildPresent: boolean;
  domains: { host: string; isPrimary: boolean }[];
};

class UnauthorizedError extends Error {}

const request = async (path: string, init?: RequestInit): Promise<Response> => {
  const res = await fetch(path, { ...init, credentials: "include" });
  if (res.status === 401) throw new UnauthorizedError();
  return res;
};

export const login = async (email: string, password: string): Promise<boolean> => {
  const res = await request("/api/dashboard/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).catch(() => null);
  return res?.ok ?? false;
};

export const logout = async (): Promise<void> => {
  await request("/api/dashboard/logout", { method: "POST" }).catch(() => {});
};

export const getClients = async (): Promise<ClientListItem[]> => {
  const res = await request("/api/dashboard/clients");
  if (!res.ok) throw new Error(`Failed to load clients: ${res.status}`);
  return (await res.json()) as ClientListItem[];
};

// Deletes the client's DB rows (domains, client_env, deploys, the clients row itself),
// terminates its worker if resident, and removes clients/<slug>/ from disk — see
// deleteClientCascade in src/dashboard/clients.ts for the full teardown.
export const deleteClient = async (slug: string): Promise<void> => {
  const res = await request(`/api/dashboard/clients/${encodeURIComponent(slug)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete client: ${res.status}`);
};

export const getGithubInstallUrl = async (): Promise<string> => {
  const res = await request("/api/dashboard/github/install-url");
  if (!res.ok) throw new Error(`Failed to get GitHub install URL: ${res.status}`);
  return ((await res.json()) as { url: string }).url;
};

export type GithubInstallation = { id: number; accountLogin: string };

export const listGithubInstallations = async (): Promise<GithubInstallation[]> => {
  const res = await request("/api/dashboard/github/installations");
  if (!res.ok) throw new Error(`Failed to list GitHub installations: ${res.status}`);
  return (await res.json()) as GithubInstallation[];
};

export type GithubRepo = { id: number; fullName: string; private: boolean; defaultBranch: string };

export const listGithubRepos = async (installationId: number): Promise<GithubRepo[]> => {
  const res = await request(`/api/dashboard/github/repos?installation_id=${installationId}`);
  if (!res.ok) throw new Error(`Failed to list GitHub repos: ${res.status}`);
  return (await res.json()) as GithubRepo[];
};

export type CreateClientInput = {
  domain: string;
  repoFullName: string;
  installationId: number;
  defaultBranch: string;
};

export type CreateClientResult = { slug: string; domain: string; workflowInjected: boolean; workflowError?: string };

// GitHub is the only path to create a client from the dashboard — the server derives the slug
// from the repo name, it isn't chosen here.
export const createClient = async (input: CreateClientInput): Promise<CreateClientResult> => {
  const res = await request("/api/dashboard/clients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to create client: ${res.status}`);
  return (await res.json()) as CreateClientResult;
};

export const addDomain = async (slug: string, host: string): Promise<void> => {
  const res = await request(`/api/dashboard/clients/${encodeURIComponent(slug)}/domains`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ host }),
  });
  if (!res.ok) throw new Error(`Failed to add domain: ${res.status}`);
};

export type DeployListItem = {
  status: string;
  triggeredBy: string;
  commitSha: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export const listDeploys = async (slug: string): Promise<DeployListItem[]> => {
  const res = await request(`/api/dashboard/clients/${encodeURIComponent(slug)}/deploys`);
  if (!res.ok) throw new Error(`Failed to load deploy history: ${res.status}`);
  return (await res.json()) as DeployListItem[];
};

export type ReinjectWorkflowResult = { workflowInjected: boolean; workflowError?: string };

// Mints a fresh deploy token, re-commits the workflow file, and resets the repo's deploy
// secret — the old token stops working the moment this succeeds, even if the GitHub calls
// that follow it fail (see updateDeployTokenHash in src/db/repositories/clients.ts).
export const reinjectWorkflow = async (slug: string): Promise<ReinjectWorkflowResult> => {
  const res = await request(`/api/dashboard/clients/${encodeURIComponent(slug)}/reinject-workflow`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to re-inject workflow: ${res.status}`);
  return (await res.json()) as ReinjectWorkflowResult;
};

export type EnvVar = { key: string; value: string };

export const listEnv = async (slug: string): Promise<EnvVar[]> => {
  const res = await request(`/api/dashboard/clients/${encodeURIComponent(slug)}/env`);
  if (!res.ok) throw new Error(`Failed to load env vars: ${res.status}`);
  return (await res.json()) as EnvVar[];
};

// Takes effect on the client's *next* request, not immediately — setting or deleting a var
// evicts the resident worker server-side so it respawns fresh with the updated env.
export const setEnv = async (slug: string, key: string, value: string): Promise<void> => {
  const res = await request(`/api/dashboard/clients/${encodeURIComponent(slug)}/env`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error(`Failed to set env var: ${res.status}`);
};

export const deleteEnv = async (slug: string, key: string): Promise<void> => {
  const res = await request(
    `/api/dashboard/clients/${encodeURIComponent(slug)}/env/${encodeURIComponent(key)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`Failed to delete env var: ${res.status}`);
};

export { UnauthorizedError };
