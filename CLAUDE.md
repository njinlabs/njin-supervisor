# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A multi-tenant HTTP supervisor for [njin](https://github.com/njinlabs/njin) sites. One Bun process
listens on a single port, reads the `Host` header of each incoming request, resolves it to a
**client** via the control-plane SQLite DB, and routes it to a per-client Bun `Worker` running that
tenant's pre-built njin app (`clients/<slug>/worker.js`). There is no per-tenant process — tenants
are isolated as worker threads inside one process.

A client's identity is an opaque **slug** (also the `clients/<slug>/` directory name) — never a
domain. Domains are a separate DB concern (a client can have several; see Multidomain below), and
env vars are also a separate per-client DB concern (see Per-client env below). This is the result
of a refactor away from the original MVP, where the directory name, the domain, and the env were
all just "the host" — see `README.md`'s Roadmap section for the milestone history if you need the
"why" behind a specific piece.

The actual framework (`@njinlabs/njin`, models, Elysia routes, EdgeJS views, the CLI that builds
`worker.js` bundles) lives in a **separate sibling repo**, linked here via `node_modules/@njinlabs/njin`
(see `bun.lock`: `"@njinlabs/njin": "link:@njinlabs/njin"`, resolving to `/d/private/njin` locally).
There is no framework source to read inside this repo — if you need to understand njin internals
(models, worker wire protocol, admin panel generation, etc.), look in that sibling repo, e.g.
`src/core/worker.ts` for the message types imported here as `@njinlabs/njin/worker`.

## Running

```bash
bun install
bun run start   # or: bun run dev (watch mode)
```

Entrypoint is `src/index.ts`: ensures the control-plane schema exists, seeds any un-registered
`clients/<slug>/` directory (bootstrapping its own name as a primary domain), then calls
`startSupervisor({ port })` from `src/supervisor/supervisor.ts`.

There are no lint/test/build scripts defined in `package.json` for this repo.

## Architecture

- `src/env.ts` — centralized `process.env` parsing (zod) for the **supervisor's own** config
  only (`PORT`, `CLIENTS_ROOT`, `CONTROL_DB_PATH`). Deliberately does not parse or expose any
  tenant-facing vars (`DB_*`, `S3_*`, ...) — those no longer belong to the supervisor process at
  all, see Per-client env below.
- `src/db/` — control-plane storage, `bun:sqlite` at `CONTROL_DB_PATH` (default
  `data/supervisor.db`, gitignored). `schema.ts` defines all tables (idempotent `CREATE TABLE IF
  NOT EXISTS`, run at every boot — there is no migration system; a schema change means editing the
  `CREATE TABLE` statement in place and, for local dev, deleting the gitignored DB file so
  `ensureSchema()` recreates it with the new columns). `repositories/` holds one file per table's
  query surface (`clients.ts`, `domains.ts`, `env.ts`, `deploys.ts`, `githubOauthState.ts`,
  `admins.ts`, `sessions.ts`).
- `src/dashboard/` — the admin dashboard's HTTP surface and business logic (see **Dashboard**
  below) and `src/github/` + `src/deploy/` — GitHub App integration and build upload/materialize
  (see **GitHub integration & deploy** below).
- `src/supervisor/supervisor.ts` — the worker pool and request dispatch, exported as
  `startSupervisor({ port })`:
  - **Domain resolution**: the `Bun.serve` fetch handler resolves the request `Host` header via
    `HOSTNAME_RE` + `resolveHost()`, then looks it up in the `domains` table
    (`findDomainByHost`). No match → `404`. A non-primary (alias) domain → `308` redirect to that
    client's primary domain (path/query/method preserved), no worker touched. A primary domain →
    proceeds to dispatch, keyed by the resolved client's **slug**, not the domain string.
  - **`GET /api/internal/tls-ask`**: Caddy's `on_demand_tls` "ask" endpoint — gated on the
    request's own `Host` being `localhost`/`127.0.0.1` (how `deploy/caddy/Caddyfile`'s `ask` URL
    is configured), checked *before* pathname would otherwise fall through to tenant dispatch.
    This loopback gate matters: without it, a tenant whose own njin app happens to route this
    exact path would have it shadowed by the supervisor instead of reaching their worker. `200`
    only if `?domain=` is `DASHBOARD_HOST` or a registered `domains` row, `403` otherwise — the
    entire control stopping an arbitrary hostname pointed at the server's IP from getting a free
    cert issued for it.
  - **Worker pool**: one `Worker` per client slug, kept in the `workers` map, started lazily on
    first request (`ensureWorker`) and pre-warmed for every `clients/*` directory at startup
    (`discoverClientSlugs`). `spawning` dedupes concurrent spawns for the same slug racing each
    other.
  - **Per-client env isolation**: `spawnWorker` builds a worker's `env` **entirely** from
    `getEnvForSlug(slug)` (`db/repositories/env.ts`) — it does **not** spread the supervisor
    process's own `process.env`, and does **not** auto-inject `DB_NAMESPACE` or anything else. A
    client with no `client_env` rows boots with an empty env and will typically fail to reach its
    DB — expected, not a bug, until that client's env is configured. Settable from the dashboard's
    per-client "Env" dialog (`GET`/`POST /api/dashboard/clients/:slug/env`,
    `DELETE .../env/:key`) — since env only applies at spawn time, setting or deleting a var
    evicts that client's resident worker so the *next* request respawns with the change applied,
    rather than silently continuing on stale env.
  - **Request dispatch**: each HTTP request becomes a `WorkerRequestMessage` posted to the
    resolved client's worker (`type: "request"`, arraybuffer body transferred, not copied) and is
    matched back to its response via a UUID `id` in the `pending` map. Timeouts:
    `REQUEST_TIMEOUT_MS` (30s) per request, `BOOT_TIMEOUT_MS` (30s) waiting for a fresh worker's
    `"ready"` message. Full message protocol (`WorkerRequestMessage`/`WorkerResponseMessage`/
    `WorkerErrorMessage`/`WorkerReadyMessage`) is defined in the njin sibling repo
    (`src/core/worker.ts`) and imported here as types only.
  - **Crash handling / circuit breaker**: a crashed worker is respawned automatically
    (`worker.onerror`); after `MAX_CONSECUTIVE_CRASHES` (3) consecutive failed boots for the same
    slug, that slug is added to `brokenSlugs` and stops being auto-respawned until the supervisor
    process itself restarts. This exists to stop a permanently-broken client (bad build,
    unreachable DB, missing env) from crash-looping forever.
  - **No idle eviction by design**: workers are never terminated just for being idle —
    intentional, because `worker.terminate()` leaks memory on Bun (see the comment above
    `MAX_CONSECUTIVE_CRASHES` in `supervisor.ts` for the tracked upstream issue). Workers stay
    resident once spawned; only crash-respawn tears one down, and that's an exceptional path, not
    routine cleanup.
  - **Shutdown**: `SIGTERM`/`SIGINT` stop accepting new connections, broadcast
    `{type: "shutdown"}` to every worker, then sleep 10.5s to let in-flight requests drain before
    the process exits.
  - **Hot-swap redeploy**: `redeployWorker(slug)`, called by `POST /api/deploy/:slug` (see
    **GitHub integration & deploy** below) after a new build has been materialized into
    `clients/<slug>/`. Spawns a fresh worker, waits (bounded by `BOOT_TIMEOUT_MS`) for it to reach
    `"ready"`, and only then swaps it into the `workers` map that `dispatch()` reads from — a
    build that never boots leaves the previously-resident worker completely untouched, so a bad
    deploy never takes down a client that was already working. The superseded worker gets the same
    `{type:"shutdown"}` + bounded grace period as process-wide `shutdown()`, then `.terminate()`.
    Same Bun `worker.terminate()` memory-leak caveat as above applies here too — repeated deploys
    trend a process's RSS upward over its lifetime; see `deploy/systemd/` for a proactive,
    graceful-restart mitigation via a memory-threshold timer (not a code-level fix, since there
    isn't one upstream yet).

## Dashboard

`src/dashboard/router.ts` (`handleDashboardRequest`) is the entire HTTP surface — no framework,
same terse manual `if (url.pathname === ...)` branching style as `supervisor.ts`'s own fetch
handler; each protected route inline-checks `getSessionFromRequest(request)` rather than going
through a middleware wrapper. Wired into `Bun.serve` in `supervisor.ts`, gated by
`env.DASHBOARD_HOST` and checked *before* `findDomainByHost()` so the dashboard host is reachable
without ever being a `domains` row.

- `src/dashboard/auth.ts` — username/password against a single seeded `admin_users` row, opaque
  DB-backed sessions (`sessions` table) in an `HttpOnly`/`SameSite=Lax` cookie.
- `src/dashboard/clients.ts` — business logic above the repository layer:
  `deleteClientCascade` (full teardown: evict worker, cascade-delete DB rows, remove
  `clients/<slug>/` from disk) and `createClientWithPrimaryDomain` (the inverse — see below).
- `dashboard-ui/` — a Preact+Vite SPA, no client-side router (a single boolean/enum view-state is
  enough for its current scope — see `main.tsx`'s own comment on why). Built via
  `bun run dashboard:build`, served lazily from memory by `src/dashboard/static.ts` with an
  exact-asset-match-else-`index.html` SPA fallback. Per-client actions live behind small dialogs
  on the flat client list rather than a routed detail page (`AddDomainDialog`, `EnvDialog`,
  `DeployHistoryDialog`), consistent with the no-router approach.

**Client creation is GitHub-only** — there is no manual slug/domain form in the dashboard. See
**GitHub integration & deploy** below for the full connect → register → deploy pipeline.

## GitHub integration & deploy

Registering a client happens exclusively by connecting a GitHub App installation and picking a
repo (`POST /api/dashboard/clients`) — the slug is *derived* from the repo name
(`slugifyRepoName`/`uniqueSlugFor` in `dashboard/clients.ts`, auto-suffixed on collision), never
admin-entered. This also auto-commits a deploy workflow into the connected repo so the tenant
never writes their own GitHub Actions file:

- `src/github/app.ts` — GitHub App JWT minting (hand-rolled RS256 via `node:crypto`, no JWT
  library) and installation access token exchange (cached in-memory, refreshed ~60s before
  GitHub's ~1h expiry).
- `src/github/installation.ts` — list installations / list a given installation's repos.
- `src/github/oauth.ts` + `db/repositories/githubOauthState.ts` — CSRF `state` for the install
  flow; TTL enforced in app code against the existing `github_oauth_state.created_at` column
  (no dedicated expiry column — consistent with this repo's no-migrations schema style).
- `src/github/workflow.ts` — `commitWorkflowFile` (PUT via GitHub's Contents API) and
  `setDeploySecret` (encrypts a per-client deploy token with `libsodium-wrappers`'
  `crypto_box_seal`, the one dependency this needed since `node:crypto` has no equivalent, then
  PUTs it as a repo Actions secret named `NJIN_DEPLOY_TOKEN`). Failure here does **not** fail
  client creation — the response just reports `workflowInjected: false`, and
  `POST /api/dashboard/clients/:slug/reinject-workflow` (mints a *fresh* token, rotating
  `clients.deploy_token_hash` — the raw token is never stored) retries it later from the dashboard.
- `src/deploy/upload.ts` / `materialize.ts` — `POST /api/deploy/:slug` authenticates via a bearer
  deploy token (`verifyDeployToken`, constant-time hash compare — **not** the dashboard session
  cookie, since the caller is the tenant's own GitHub Actions run, not a logged-in admin) and
  extracts the uploaded build tarball (via the system `tar` binary — no tar library dependency)
  atomically into `clients/<slug>/` before handing off to `redeployWorker` (see above).
- `db/repositories/deploys.ts` — one row per deploy attempt (`status`, `commit_sha`,
  `error_message`, timestamps), surfaced read-only in the dashboard via a per-client "Deploys"
  dialog (`GET /api/dashboard/clients/:slug/deploys`).

All of the above degrades gracefully when unconfigured: the 5 `GH_APP_*` env vars
(see **Configuration**) are optional but all-or-nothing (zod `.refine()`, same pattern as
`ADMIN_EMAIL`/`ADMIN_PASSWORD`) — unset, the supervisor still boots fine and the GitHub/deploy
endpoints just return `503`.

A GitHub App must be registered externally (one-time, human step, not code) with
`Contents: Read and write`, `Workflows: Read and write`, `Secrets: Read and write`, and
`Metadata: Read-only` repository permissions, and "Request user authorization (OAuth) during
installation" enabled — see `README.md`'s **M3+M4** roadmap entry for the full registration
walkthrough.

## Multidomain

A client can have several `domains` rows, exactly one `is_primary` (DB-enforced via a partial
unique index, `idx_domains_one_primary_per_client`). Only the primary domain's worker actually
serves traffic; every other domain pointing at that client just redirects to the primary. See
`README.md`'s "Multidomain support" section for the request-level behavior.

## `clients/` directory

Each `clients/<slug>/` is the **build output** of a njin project (source of truth for that project
lives elsewhere) — treat these as generated artifacts, not hand-edited source. The directory name
is the client's slug — it is not necessarily a domain, though for the current dummy tenants the
slug happens to equal their bootstrap primary domain string.

- `worker.js` — bundled njin app entrypoint, spawned directly by the supervisor as a Bun `Worker`.
- `public/` — static assets served by the njin app.
- `src/views/` — EdgeJS templates (`layouts/`, `pages/` file-based routes, `components/`) — these
  are checked in for reference/diffing but are compiled into `worker.js`; editing them here does
  not change runtime behavior without a rebuild+resync from the source project.
- `_admin/` — a pre-built admin panel SPA (static `index.html` + assets), served by the njin app.

The original 4 dummy/reference tenants (`j3companyid.test`, `jadiweb.test`, `njin.test`,
`zava.test`) may still be present locally, alongside whatever real clients get onboarded through
the dashboard's GitHub flow — both are ordinary `clients` rows, there's no code-level distinction
between "dummy" and "real" tenants.

## Configuration

The supervisor's own `.env` (not committed) covers the supervisor process only, never forwarded to
a tenant worker: `PORT`, `CLIENTS_ROOT` (optional), `CONTROL_DB_PATH` (optional),
`DASHBOARD_HOST`/`ADMIN_EMAIL`/`ADMIN_PASSWORD`/`DASHBOARD_COOKIE_SECURE` (dashboard), and the 5
`GH_APP_*` vars (GitHub App credentials — optional but all-or-nothing, see **GitHub integration &
deploy** above). See `README.md`'s **Configuration** section for the full list with defaults and
exact setup steps (including the GitHub App registration walkthrough). Each client's own
`DB_PATH`/`DB_NAMESPACE`/`DB_DATABASE`/`DB_USERNAME`/`DB_PASSWORD` (SurrealDB), `FILE_DIR` or
`S3_*` (file storage), `IMG_HOSTS`, etc. live in that client's `client_env` rows instead — see
`src/db/repositories/env.ts`.

## Roadmap

See `README.md` for the full milestone checklist. M1 through M4 are done: control-plane storage,
multidomain, per-client env, the dashboard SPA, and the GitHub-connect → auto-inject-workflow →
deploy → hot-swap pipeline described above. M5 (deploy-history UI, re-inject-workflow action) is
also built; what's left there is validating the complete loop end-to-end against one real,
continuously-used tenant repo, and general polish.
