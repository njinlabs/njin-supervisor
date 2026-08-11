import { rmSync } from "node:fs";
import { db } from "../db/client";
import { createClient, deleteClientById, findClientBySlug, type ClientRow } from "../db/repositories/clients";
import { addDomain, deleteDomainsForClient } from "../db/repositories/domains";
import { deleteEnvForClient } from "../db/repositories/env";
import { getClientDir } from "../supervisor/discovery";

export type EvictWorker = (slug: string) => void;
export type RedeployWorker = (slug: string) => Promise<void>;

// Full teardown for a "delete this client" dashboard action: terminates its resident worker (if
// any — so it isn't left running, unreachable, forever, per supervisor.ts's "no idle eviction"
// policy which only ever applies to routine operation, not an explicit delete), removes every DB
// row that references it (schema.ts has no ON DELETE CASCADE, so this is explicit and
// transactional), and deletes clients/<slug>/ from disk. Returns false if the slug isn't a
// registered client at all.
export const deleteClientCascade = (slug: string, evictWorker: EvictWorker): boolean => {
  const client = findClientBySlug(slug);
  if (!client) return false;

  evictWorker(slug);

  const cascade = db.transaction(() => {
    db.query("DELETE FROM deploys WHERE client_id = ?").run(client.id);
    deleteEnvForClient(client.id);
    deleteDomainsForClient(client.id);
    deleteClientById(client.id);
  });
  cascade();

  rmSync(getClientDir(slug), { recursive: true, force: true });

  return true;
};

// Takes the "repo-name" portion of "owner/repo-name", lowercases it, collapses any run of
// non [a-z0-9] characters to a single "-", and trims leading/trailing "-". Collisions (two repos
// whose names slugify the same, possibly across different installations) are handled by
// uniqueSlugFor below, not here.
export const slugifyRepoName = (repoFullName: string): string => {
  const repoName = repoFullName.split("/").pop() ?? repoFullName;
  return repoName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

export const uniqueSlugFor = (repoFullName: string): string => {
  const base = slugifyRepoName(repoFullName) || "client";
  if (!findClientBySlug(base)) return base;

  let suffix = 2;
  while (findClientBySlug(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
};

export type CreateClientInput = {
  domain: string;
  repoFullName: string;
  installationId: number;
  defaultBranch: string;
  deployTokenHash: string;
};

// GitHub is the only way to create a client from the dashboard (see M3+M4 plan) — slug is always
// derived from the repo, never admin-entered. Wrapped in one transaction so a domain UNIQUE
// violation (checked by the router before calling this, but still possible under a race) can't
// leave an orphaned clients row.
export const createClientWithPrimaryDomain = (input: CreateClientInput): ClientRow => {
  const slug = uniqueSlugFor(input.repoFullName);

  const run = db.transaction(() => {
    const client = createClient(slug, {
      source: "github",
      repoFullName: input.repoFullName,
      installationId: input.installationId,
      defaultBranch: input.defaultBranch,
      deployTokenHash: input.deployTokenHash,
    });
    addDomain(client.id, input.domain, true);
    return client;
  });

  return run();
};
