import { startSupervisor } from "./supervisor/supervisor";
import { discoverClientSlugs } from "./supervisor/discovery";
import { env } from "./env";
import { ensureSchema } from "./db/schema";
import { createClient, findClientBySlug } from "./db/repositories/clients";
import { addDomain, findDomainByHost } from "./db/repositories/domains";
import { seedAdminIfNeeded } from "./dashboard/auth";

ensureSchema();
await seedAdminIfNeeded();

// Existing clients/<slug>/ directories are registered in the control-plane DB so they show up
// in the dashboard immediately — idempotent, safe to run on every boot. A directory with no
// client row yet gets one, bootstrapped with its own name as its (only, primary) domain — this
// is just a starting point; more domains can be attached to the same client later via the
// dashboard without touching the directory at all.
for (const slug of discoverClientSlugs()) {
  const client = findClientBySlug(slug) ?? createClient(slug, { source: "manual" });
  if (!findDomainByHost(slug)) addDomain(client.id, slug, true);
}

startSupervisor({ port: env.PORT });
