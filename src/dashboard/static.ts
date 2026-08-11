import { existsSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

// dashboard-ui is a standalone Vite project (own package.json, not part of this package's own
// dependency graph) — its build output lives here regardless of which package.json triggered it.
const DIST_DIR = join(import.meta.dir, "..", "..", "dashboard-ui", "dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

type Asset = { body: Uint8Array; contentType: string };

let assets: Map<string, Asset> | null = null;
let indexHtml: Asset | null = null;

const contentTypeFor = (path: string): string => CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

// Loaded once, lazily, on the first dashboard request after boot — not at boot itself, so
// `bun run dev` without a prior `vite build` still starts cleanly (isDashboardBuilt() below is
// what the router uses to fail loudly instead). A Vite build output is immutable between
// supervisor restarts, exactly like a tenant's worker.js is immutable between deploys, so there's
// no need to re-read from disk on every request.
const loadAssets = async (): Promise<void> => {
  assets = new Map();
  if (!existsSync(DIST_DIR)) {
    console.warn(`dashboard-ui not built — ${DIST_DIR} does not exist (run "bun run dashboard:build")`);
    return;
  }
  for (const file of walk(DIST_DIR)) {
    const pathname = "/" + relative(DIST_DIR, file).split(sep).join("/");
    const asset: Asset = { body: new Uint8Array(await Bun.file(file).arrayBuffer()), contentType: contentTypeFor(file) };
    assets.set(pathname, asset);
    if (pathname === "/index.html") indexHtml = asset;
  }
};

let loading: Promise<void> | null = null;
const ensureLoaded = async (): Promise<void> => {
  if (assets !== null) return;
  if (!loading) loading = loadAssets();
  await loading;
};

export const getAsset = async (pathname: string): Promise<Asset | null> => {
  await ensureLoaded();
  return assets?.get(pathname) ?? null;
};

export const getIndexHtml = async (): Promise<Asset | null> => {
  await ensureLoaded();
  return indexHtml;
};

export const isDashboardBuilt = (): boolean => existsSync(DIST_DIR);
