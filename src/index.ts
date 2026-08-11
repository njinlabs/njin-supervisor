import { startSupervisor } from "./supervisor/supervisor";
import { discoverClientSlugs } from "./supervisor/discovery";
import { env } from "./env";
import { ensureSchema } from "./db/schema";
import { createClient, findClientBySlug } from "./db/repositories/clients";
import { addDomain } from "./db/repositories/domains";
import { seedAdminIfNeeded } from "./dashboard/auth";

ensureSchema();
await seedAdminIfNeeded();

// A clients/<slug>/ directory with no client row yet gets one, bootstrapped with its own
// directory name as its (only, primary) domain — a starting point for the old manual-copy flow;
// more domains can be attached later via the dashboard without touching the directory at all.
// Only genuinely new directories are touched here — an *already-registered* client (manual or,
// increasingly, GitHub-sourced with a real chosen domain that has nothing to do with its slug)
// is skipped entirely. Checking "does a domain row equal to the slug exist" instead of "does
// this client already have a primary domain" was the previous (wrong) approach: a GitHub client
// whose slug differs from its actual domain would keep failing this check every boot and try to
// insert a second primary domain, tripping the partial unique index and crash-looping the whole
// process — see idx_domains_one_primary_per_client in db/schema.ts.
for (const slug of discoverClientSlugs()) {
  if (findClientBySlug(slug)) continue;
  const client = createClient(slug, { source: "manual" });
  addDomain(client.id, slug, true);
}

startSupervisor({ port: env.PORT });
