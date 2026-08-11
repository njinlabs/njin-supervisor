import type {
  WorkerErrorMessage,
  WorkerOutboundMessage,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from "@njinlabs/njin/worker";

import { join } from "node:path";
import { env } from "../env";
import { findDomainByHost, findPrimaryHostForClient } from "../db/repositories/domains";
import { getEnvForSlug } from "../db/repositories/env";
import { handleDashboardRequest } from "../dashboard/router";
import { HOSTNAME_RE } from "../util/hostname";
import { discoverClientSlugs, hasClientDir } from "./discovery";
import type { PendingRequest, SupervisorOptions, WorkerHandle } from "./types";

const CLIENTS_ROOT = env.CLIENTS_ROOT;

// Strips a ":port" suffix (real browsers/proxies send one when it's non-default) and validates
// against HOSTNAME_RE — returns null for anything malformed or missing.
export const resolveHost = (rawHost: string | null): string | null => {
  if (!rawHost) return null;
  const host = rawHost.split(":")[0]?.toLowerCase() ?? "";
  return HOSTNAME_RE.test(host) ? host : null;
};

const REQUEST_TIMEOUT_MS = 30_000;
const BOOT_TIMEOUT_MS = 30_000;
// Bun.serve's own per-connection idle timeout defaults to 10s, which is shorter than the
// worst case a request can legitimately wait here (up to BOOT_TIMEOUT_MS for a fresh worker's
// "ready", then up to REQUEST_TIMEOUT_MS for the actual response) — left at the default, Bun
// itself kills the connection (dropping it with no response at all) before dispatch()'s own
// timeouts get a chance to return a proper error. Set with headroom above both combined so
// Bun is never the one that decides a slow-but-legitimate request is dead.
const IDLE_TIMEOUT_SECONDS = Math.ceil((BOOT_TIMEOUT_MS + REQUEST_TIMEOUT_MS) / 1000) + 5;
// Circuit breaker — a host that fails to reach "ready" this many times in a row (a bad
// build, a config error, a DB the client can't reach, ...) stops getting auto-respawned.
// Without this, a broken client crash-loops forever: each attempt still burns CPU/DB
// connections, and since a crashed worker's memory isn't fully reclaimed either (see the
// comment below), an unbounded crash loop is also an unbounded, if slow, leak.
const MAX_CONSECUTIVE_CRASHES = 3;
// No idle-eviction here on purpose — worker.terminate() leaks memory that's never
// reclaimed (confirmed against a minimal, dependency-free Worker too, so it's not
// anything njin/supervisor-specific: https://github.com/oven-sh/bun/issues/5709, still
// reproducible on Bun 1.3.14). A worker that's never routinely terminated never hits that
// path — it just stays resident, which is also the more memory-efficient shape here: one
// process's workers share the same bun.exe binary at the OS level, unlike one full process
// per tenant. Crash-respawn (onerror below) still calls terminate implicitly via the
// worker's own death, but that's an exceptional path, not a routine cycle.

export const startSupervisor = ({ port }: SupervisorOptions) => {
  const workers = new Map<string, WorkerHandle>();
  const pending = new Map<string, PendingRequest>();
  // Tracks an in-flight spawn per host so concurrent callers (dispatch() racing a
  // crash-respawn, two requests racing the very first spawn) share the same spawn instead
  // of each kicking off their own. Currently belt-and-suspenders
  // — spawnWorker() has no `await` in it today, so the whole check-then-set in ensureWorker()
  // below already runs as one synchronous, non-interleavable turn of the event loop. This
  // stops being true (and this map starts actually mattering) the moment spawnWorker() gains
  // any `await` before `new Worker(...)`.
  const spawning = new Map<string, Promise<WorkerHandle>>();
  // Consecutive-failure count per host, reset to 0 the moment that host's worker reaches
  // "ready" — only a *streak* of failed boots trips the breaker, not e.g. one crash after
  // days of healthy uptime followed by a clean respawn.
  const crashCounts = new Map<string, number>();
  // Slugs the breaker has tripped for — ensureWorker() refuses to spawn these until the
  // supervisor itself restarts (the natural point to retry, e.g. after a fixed build has
  // been synced into clients/<slug>/).
  const brokenSlugs = new Set<string>();

  const spawnWorker = (slug: string): WorkerHandle => {
    console.log("Spawning", slug);

    // A worker's env comes ENTIRELY from its own client_env rows (see db/repositories/env.ts)
    // — never from the supervisor process's own env. This is intentional isolation: a client
    // must configure its own DB/storage/etc, and one tenant's secrets are never implicitly
    // visible to another's worker just because they share this process. A client with no
    // env rows yet boots with an empty env and will typically fail to reach its DB — expected
    // until its env is set (via the dashboard, once built, or directly through the env
    // repository).
    const clientDir = join(CLIENTS_ROOT, slug);
    const worker = new Worker(join(clientDir, "worker.js"), {
      env: getEnvForSlug(slug),
    } as WorkerOptions);

    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Never let a rejected readyPromise surface as an unhandled rejection when nobody's
    // awaiting it yet (e.g. a worker that crashes before its first request) — dispatch()
    // still sees the real rejection whenever it does await this.
    readyPromise.catch(() => {});

    const handle: WorkerHandle = { worker, ready: false, inFlight: 0, readyPromise };

    worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
      const msg = event.data;

      if (msg.type === "ready") {
        console.log("READY", slug);
        handle.ready = true;
        crashCounts.delete(slug);
        resolveReady();
        return;
      }

      const req = pending.get(msg.id);
      if (!req) return;
      pending.delete(msg.id);
      clearTimeout(req.timer);
      handle.inFlight--;

      if (msg.type === "response") req.resolve(msg);
      else req.reject(new Error((msg as WorkerErrorMessage).message));
    };

    worker.onerror = (error) => {
      handle.ready = false;
      // Respawn on crash so the pool always keeps a worker alive per client. Only if this
      // handle is still the current one for the slug — a previous crash may have already
      // replaced it, and this stale onerror firing late shouldn't stomp on a newer,
      // already-healthy handle.
      console.log(error);
      rejectReady(new Error(error.message || "worker crashed before becoming ready"));
      if (workers.get(slug) === handle) {
        workers.delete(slug);

        const crashes = (crashCounts.get(slug) ?? 0) + 1;
        crashCounts.set(slug, crashes);

        if (crashes >= MAX_CONSECUTIVE_CRASHES) {
          brokenSlugs.add(slug);
          console.error(`${slug} failed to boot ${crashes} times in a row — circuit breaker tripped, will not auto-respawn`);
        } else {
          void ensureWorker(slug);
        }
      }
    };

    return handle;
  };

  // Single choke point for "give me a worker for this client, spawning one if needed" — every
  // caller (dispatch(), the crash-respawn above) goes through here so at most one spawn is
  // ever in flight per slug at a time. See the `spawning` comment above for why this matters.
  const ensureWorker = (slug: string): Promise<WorkerHandle> | null => {
    const existing = workers.get(slug);
    if (existing) return Promise.resolve(existing);

    if (brokenSlugs.has(slug) || !hasClientDir(slug)) return null;

    let inflight = spawning.get(slug);
    if (!inflight) {
      inflight = (async () => {
        const handle = spawnWorker(slug);
        workers.set(slug, handle);
        return handle;
      })();
      spawning.set(slug, inflight);
      // Always clears, success or failure — a failed spawn shouldn't wedge every future
      // request for this slug behind a promise that already settled.
      inflight.finally(() => {
        if (spawning.get(slug) === inflight) spawning.delete(slug);
      });
    }
    return inflight;
  };

  // Pre-warm every client folder that already exists at startup — purely an optimization
  // (avoids eating the boot latency on each one's first real request); anything dropped into
  // clients/ afterward still works, just spawns lazily on its own first request instead.
  for (const slug of discoverClientSlugs()) workers.set(slug, spawnWorker(slug));

  // For the dashboard's "delete client" action — an explicit teardown, not a crash, so this
  // deliberately doesn't go through the crash-respawn path in onerror (removing from `workers`
  // first means its stale-handle guard sees a mismatch and no-ops). worker.terminate() still
  // leaks memory on Bun (see MAX_CONSECUTIVE_CRASHES's comment above), but leaving a deleted
  // client's worker running forever, unreachable, is worse — this is a rare, deliberate action,
  // not a routine cycle. A no-op if the slug was never resident (never requested, or never
  // spawned successfully).
  const evictWorker = (slug: string): void => {
    const handle = workers.get(slug);
    if (!handle) return;
    workers.delete(slug);
    handle.worker.terminate();
  };

  // For POST /api/deploy/:slug once a new build has been materialized into clients/<slug>/ —
  // spawns a fresh worker against the new build and only swaps it into `workers` (the map every
  // dispatch() call reads from) once it's actually reached "ready". If the new worker never gets
  // there, this rejects and the old handle is left completely untouched — a broken deploy never
  // takes down a client that was working before it, unlike a crash (which has nothing left to
  // fall back to). The old worker, once superseded, gets the same graceful shutdown message as
  // process-wide shutdown() below, then a bounded grace period before terminate().
  const redeployWorker = async (slug: string): Promise<void> => {
    const newHandle = spawnWorker(slug);
    await Promise.race([
      newHandle.readyPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("redeploy boot timed out")), BOOT_TIMEOUT_MS),
      ),
    ]);

    const old = workers.get(slug);
    workers.set(slug, newHandle);

    if (old && old !== newHandle) {
      old.worker.postMessage({ type: "shutdown" });
      setTimeout(() => old.worker.terminate(), 10_500);
    }
  };

  const dispatch = async (
    slug: string,
    msg: WorkerRequestMessage,
  ): Promise<WorkerResponseMessage> => {
    if (brokenSlugs.has(slug)) throw new Error(`${slug} circuit breaker is open — not retrying automatically`);

    const spawnPromise = ensureWorker(slug);

    if (!spawnPromise) throw new Error("no worker available");

    const target = await spawnPromise;

    if (!target.ready) {
      // A fresh Worker still spinning up (boot, DB connect, ensureTables()) shouldn't fail
      // the request that raced its spawn — wait for "ready" instead, bounded so a genuinely
      // stuck/crashed worker doesn't hang the request forever.
      await Promise.race([
        target.readyPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("worker boot timed out")), BOOT_TIMEOUT_MS)),
      ]);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(msg.id);
        target.inFlight--;
        reject(new Error("worker request timed out"));
      }, REQUEST_TIMEOUT_MS);

      pending.set(msg.id, { resolve, reject, timer });
      target.inFlight++;
      target.worker.postMessage(msg, msg.body ? [msg.body] : []);
    });
  };

  const server = Bun.serve({
    port,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    fetch: async (request) => {
      const url = new URL(request.url);
      const rawHostOnly = request.headers.get("host")?.split(":")[0]?.toLowerCase();

      // Caddy's `on_demand_tls` "ask" endpoint (see deploy/caddy/Caddyfile: `ask
      // http://localhost:PORT/api/internal/tls-ask`) — gated on loopback Host, not just
      // pathname, so this can never shadow the same path under a *tenant's* own domain (a
      // tenant's njin app is free to have its own route at this exact path; it'll reach their
      // worker normally, since a request for it arriving on their Host won't match here). 200
      // only for a domain we actually know about (the dashboard host, or a registered `domains`
      // row) — the entire control stopping anyone who points DNS at this server's IP from
      // getting Caddy to mint them a free cert for an arbitrary hostname.
      if (url.pathname === "/api/internal/tls-ask" && (rawHostOnly === "localhost" || rawHostOnly === "127.0.0.1")) {
        const domain = resolveHost(url.searchParams.get("domain"));
        if (!domain) return new Response("Bad Request", { status: 400 });
        const allowed = domain === env.DASHBOARD_HOST || Boolean(findDomainByHost(domain));
        return new Response(null, { status: allowed ? 200 : 403 });
      }

      const host = resolveHost(request.headers.get("host"));
      if (!host) return new Response("Bad Request", { status: 400 });

      // Checked before findDomainByHost() on purpose — the dashboard host is deliberately never
      // a `domains` row, so it must win this precedence to be reachable at all. Keep this branch
      // first if this ordering is ever touched again.
      if (env.DASHBOARD_HOST && host === env.DASHBOARD_HOST)
        return handleDashboardRequest(request, { evictWorker, redeployWorker });

      const domain = findDomainByHost(host);
      if (!domain) return new Response("Not Found", { status: 404 });

      // Alias domain — send the client to its primary domain instead of spawning/dispatching
      // to a worker at all. 308 preserves method/body (safe for POSTs mid-flight) and the
      // redirect target keeps the original path/query/protocol, only the host changes.
      if (!domain.isPrimary) {
        const primaryHost = findPrimaryHostForClient(domain.clientId);
        if (!primaryHost) return new Response("Not Found", { status: 404 });
        const target = new URL(request.url);
        target.host = primaryHost;
        return Response.redirect(target.toString(), 308);
      }

      const id = crypto.randomUUID();
      const body = request.body ? await request.arrayBuffer() : null;
      const headers: [string, string][] = [];
      request.headers.forEach((value, key) => headers.push([key, value]));

      try {
        const res = await dispatch(domain.clientSlug, {
          type: "request",
          id,
          method: request.method,
          url: request.url,
          headers,
          body,
        });
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        });
      } catch (error) {
        console.error(error);
        return new Response("Bad Gateway", { status: 502 });
      }
    },
  });

  const shutdown = async (): Promise<void> => {
    server.stop();
    for (const { worker } of workers.values())
      worker.postMessage({ type: "shutdown" });
    // Give workers a chance to drain before the process exits; worker.ts's own
    // SHUTDOWN_DRAIN_TIMEOUT_MS bounds how long each one takes.
    await Bun.sleep(10_500);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { server, shutdown };
};
