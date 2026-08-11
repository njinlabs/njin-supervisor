import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "../env";

const CLIENTS_ROOT = env.CLIENTS_ROOT;

// A "known" client is just a folder with a worker.js in it — no separate registry to keep in
// sync. Drop a new clients/<slug>/ (from the same build+sync flow as any other client) and it's
// spawnable on its very next request, no supervisor restart needed. The directory is named by
// the client's slug, never by a domain — which domain(s) route to it is entirely a DB concern
// (see db/repositories/domains.ts), resolved per-request in supervisor.ts.
export const hasClientDir = (slug: string): boolean => existsSync(join(CLIENTS_ROOT, slug, "worker.js"));

// The on-disk directory for a client's build output — the one thing a "delete client" dashboard
// action needs to know how to remove, alongside its DB rows and any resident worker.
export const getClientDir = (slug: string): string => join(CLIENTS_ROOT, slug);

// Every directory under CLIENTS_ROOT that currently has a worker.js — used for the pre-warm loop
// at boot, for seeding the control-plane clients table, and for the dashboard to tell a stale
// clients row (its clients/<slug>/ deleted from disk, but the DB row and any client_env/domains
// rows were never cleaned up — nothing does that automatically) apart from a real, live one.
export const discoverClientSlugs = (): string[] =>
  readdirSync(CLIENTS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && hasClientDir(entry.name))
    .map((entry) => entry.name);
