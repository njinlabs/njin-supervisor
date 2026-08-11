# njin-supervisor

A multi-tenant HTTP supervisor for [njin](https://github.com/njinlabs/njin) sites. One Bun process
listens on a single port, reads the `Host` header of each incoming request, resolves it to a
client via the control-plane DB, and routes it to a per-client Bun `Worker` running that tenant's
pre-built njin app (`clients/<slug>/worker.js`). There is no per-tenant process — tenants are
isolated as worker threads inside one process.

A client's identity is its **slug**, never a domain — a client can have several domains pointing
at it (multidomain support, see below), so the domain↔client mapping lives in the DB, not in the
filesystem layout.

See [CLAUDE.md](./CLAUDE.md) for a deeper architecture writeup (worker pool, crash handling,
shutdown draining, etc).

## Requirements

- [Bun](https://bun.com) v1.3+
- A running SurrealDB instance — reachable via whatever `DB_*` values each client is configured
  with (see **Per-client environment variables** below; this is no longer the supervisor's own
  `.env`)

## Setup

```bash
bun install
```

Copy `.env` (not committed) — this is the supervisor's own config only, not passed to any tenant
worker:

```
PORT=3000
```

## Running

```bash
bun run start
```

(or `bun run dev` for watch mode)

The entrypoint is `src/index.ts`. On boot it:
1. Ensures the control-plane SQLite schema exists (`data/supervisor.db`, gitignored).
2. Registers every existing `clients/<slug>/` directory as a `clients` row (idempotent) and, if it
   has no domain yet, bootstraps its own directory name as its primary domain.
3. Starts the supervisor: pre-warms a worker per existing tenant, then serves `Bun.serve()`,
   resolving each request's `Host` header against the `domains` table and dispatching to that
   client's worker (or redirecting, for an alias domain — see **Multidomain support** below).

## Dashboard

Set `DASHBOARD_HOST`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` in `.env`, build the SPA once
(`bun run dashboard:build`), then `bun run start`/`bun run dev` as usual — visiting
`DASHBOARD_HOST` now serves a login page, and the seeded admin can sign in to see a read-only list
of every registered client and its domains. `bun run dashboard:dev` runs the SPA under Vite's own
dev server separately, for frontend-only iteration. See **M2** in the Roadmap below for what this
covers today (read-only) versus what M3+ adds (managing clients/env/deploys from here).

## Multidomain support

A client (`clients` row) can have several domains pointing at it — one **primary** (the domain
its worker actually serves under) and any number of **aliases**, which get a `308 Permanent
Redirect` to the primary domain instead of being dispatched to a worker (path, query string, and
request method/body are all preserved; only the host changes). This means:

- `clients/<slug>/` directories are keyed by the client's **slug**, an opaque, permanent
  identifier — never by a domain, since a domain can be swapped or a second one added without
  touching the worker, its build, or its config at all.
- A request for an unregistered domain (no `domains` row) gets `404` immediately, without ever
  reaching the worker pool.
- Enforced at the DB level: `domains` has a partial unique index so a client can never end up with
  two primary domains at once (`idx_domains_one_primary_per_client` in `src/db/schema.ts`).

Today, adding a domain to a client is a direct DB operation (`addDomain` in
`src/db/repositories/domains.ts`); a dashboard UI for managing this is planned (see **Roadmap**).

## Per-client environment variables

A worker's env comes **entirely** from its own `client_env` rows — it does **not** inherit the
supervisor process's `.env` at all (previously it did, via `{...process.env}`). This means:

- Each client configures its own `DB_PATH`/`DB_NAMESPACE`/`DB_DATABASE`/`DB_USERNAME`/
  `DB_PASSWORD`, `FILE_DIR` or `S3_*`, `IMG_HOSTS`, etc. independently — nothing is shared or
  implied between tenants just because they run in the same supervisor process.
- A client with no `client_env` rows yet boots with an **empty** env and will typically fail to
  reach its DB — this is expected, not a bug, until its env is configured.
- `DB_NAMESPACE` is no longer auto-injected by the supervisor — each client must set its own
  (conventionally its own slug, but nothing enforces that anymore; a client could point at any
  namespace it configures).

Set from the dashboard's per-client "Env" dialog (`GET`/`POST /api/dashboard/clients/:slug/env`,
`DELETE .../env/:key` — backed by `setEnvVar`/`deleteEnvVar`/`listEnvForClient` in
`src/db/repositories/env.ts`). A var only takes effect at worker spawn time, so setting or
deleting one evicts that client's resident worker — the next request respawns it with the change
applied instead of silently continuing on stale env.

## Adding a tenant (current, manual flow)

Tenants are onboarded by building a `worker.js` bundle in the sibling
[`njin`](https://github.com/njinlabs/njin) repo (`njin build:worker`) and copying the output
(`worker.js`, `public/`, `src/views/`, `_admin/`) into `clients/<slug>/` here. No supervisor
restart is needed — a new `clients/<slug>/` with a `worker.js` in it is spawnable on its next
request, once it (and at least one domain pointing at it) exists in the control-plane DB.

A dashboard-based, GitHub-connected onboarding flow (pick a repo, auto-build via GitHub Actions,
auto-deploy) is in progress — see **Roadmap** below.

## Project layout

```
src/
  index.ts              # entrypoint: ensure schema, seed clients, seed admin, start supervisor
  env.ts                 # centralized process.env parsing (zod)
  supervisor/
    supervisor.ts         # worker pool, domain resolution/redirect, crash/circuit-breaker handling
    types.ts
  db/
    client.ts             # bun:sqlite connection (data/supervisor.db)
    schema.ts              # control-plane table definitions
    repositories/
      clients.ts            # clients table CRUD (slug-keyed)
      domains.ts             # domains table CRUD (host -> client resolution, primary lookup)
      env.ts                  # per-client env vars (what a worker actually gets spawned with)
      admins.ts                # admin_users table CRUD
      sessions.ts               # sessions table CRUD (dashboard login sessions)
  dashboard/
    router.ts              # dashboard HTTP routes: login/logout/clients list+delete + static/SPA
    auth.ts                 # admin seeding, login, session cookie helpers
    static.ts                # lazy in-memory loader for dashboard-ui/dist
    clients.ts                # deleteClientCascade: DB rows + worker eviction + on-disk cleanup
dashboard-ui/
  src/                    # Preact SPA source (login page, client-list page)
  dist/                    # build output (gitignored), served by src/dashboard/static.ts
clients/
  <slug>/                 # build output per tenant (worker.js, public/, src/views/, _admin/)
```

## Roadmap: dashboard-based platform

This project started as an MVP (manual `clients/<host>/` drops). The goal is to grow it into a
dashboard where you connect GitHub and pick a repo to onboard a tenant (Vercel-style import), with
builds running in GitHub Actions on the tenant repo and auto-deploying via an upload API. Full
design lives in the planning history; tracked here as a milestone checklist, each of which leaves
the system fully working:

- [x] **M1 — Refactor + control-plane storage + tenant migration**
  Broke `src/index.ts` into `supervisor/`, `env.ts`, `db/`; added `bun:sqlite` control-plane
  storage (`clients`, `deploys`, `admin_users`, `sessions`, `github_oauth_state` tables); seeded
  the 4 existing tenants into the `clients` table. No UI, no GitHub yet — pure refactor, verified
  against the running supervisor with all 4 tenants routing identically.

- [x] **M1.1 — Multidomain support**
  Split domain identity out of client identity: `clients` is now keyed by an opaque `slug`
  (the `clients/<slug>/` directory name), and a new `domains` table maps N hosts to one client,
  exactly one marked primary. The `Bun.serve` fetch handler resolves the request `Host` against
  `domains` and either dispatches (primary) or issues a `308` redirect to the primary domain
  (alias), preserving path/query/method. Verified: primary domains route as before, an alias
  domain redirects correctly with path+query intact, a second primary is rejected by the DB's
  partial unique index, and an unregistered host now gets a clean `404` instead of falling
  through to the worker pool.

- [x] **M1.2 — Per-client environment variables**
  Added a `client_env` table (`src/db/repositories/env.ts`) and cut over `spawnWorker` in
  `supervisor.ts` to build a worker's env entirely from its own client's rows — the previous
  `{...process.env}` passthrough (and the auto-injected `DB_NAMESPACE`) is gone. Verified: a
  client with no env rows boots with an empty env (and predictably fails to reach a real DB —
  by design), and a client with its own `DB_*` vars set boots and serves normally, isolated from
  the supervisor's own `.env` and from every other client.

- [x] **M1.3 — Fix `Bun.serve` idle timeout vs. worker boot/request timeouts**
  A client stuck waiting on a DB it can't reach (e.g. no env configured yet, per M1.2) can
  legitimately take up to `BOOT_TIMEOUT_MS` + `REQUEST_TIMEOUT_MS` (60s) to resolve, but
  `Bun.serve`'s own default `idleTimeout` (10s) was killing the connection first — the client got
  an abrupt dropped connection instead of a clean `502`. Set `idleTimeout` on `Bun.serve` with
  headroom above both timeouts combined (`IDLE_TIMEOUT_SECONDS` in `supervisor.ts`). Verified: a
  request to a client with no env now waits out the full boot timeout and gets a proper
  `502 Bad Gateway` instead of a dropped connection.

- [x] **M2 — Dashboard SPA + auth, read-only client list**
  Added a `dashboard-ui/` Preact+Vite SPA (own `package.json`, built via `bun run
  dashboard:build`) whose `dist/` output is read lazily into memory and served by a new
  `src/dashboard/{router,static,auth}.ts`. A new `DASHBOARD_HOST` env var gives the dashboard its
  own Host, checked in the `Bun.serve` fetch handler *before* `findDomainByHost` so it's reachable
  without ever being a `domains` row. Auth is username/password against an `admin_users` row
  seeded once at boot from `ADMIN_EMAIL`/`ADMIN_PASSWORD` (idempotent — only seeds if no admin
  exists yet), backed by opaque DB-stored sessions (`sessions` table) in an `HttpOnly`/`SameSite=
  Lax` cookie (`Bun.password.hash`/`verify`, `Bun.CookieMap` — no new dependency, no session
  secret to manage since the cookie value is meaningless without its DB row). Verified: dashboard
  host routes to the SPA without disturbing tenant routing; `GET /api/dashboard/clients` is `401`
  without a valid session and `200` with the seeded 4 tenants' slug/status/domains once logged in;
  wrong password and expired/garbage session cookies are rejected; logout clears both the cookie
  and its session row; a missing `dashboard-ui/dist` build fails loudly with `503` instead of a
  crash or blank `404`.

  Extended past its original read-only scope: `DELETE /api/dashboard/clients/:slug`
  (`deleteClientCascade` in `src/dashboard/clients.ts`) fully tears a client down — terminates its
  worker if resident (an explicit, deliberate eviction, not a crash, so it doesn't trip the
  circuit breaker), deletes its `domains`/`client_env`/`deploys`/`clients` rows in one transaction
  (no `ON DELETE CASCADE` in `schema.ts`, so this is explicit), and removes `clients/<slug>/` from
  disk. This closes a gap where a manually-deleted `clients/<slug>/` directory left a stale
  `clients` row the dashboard kept showing as `active` forever — the client list now also reports
  `buildPresent` per client (whether `clients/<slug>/worker.js` actually still exists on disk) and
  the SPA shows a "missing build" badge instead of trusting the DB's `status` column blindly.

- [x] **M3+M4 — GitHub App integration, auto-injected deploy workflow, deploy endpoint, worker hot-swap**
  GitHub is the *only* way to create a client from the dashboard — there is no manual
  slug/domain-only form. Registering a client also auto-commits a deploy workflow into the
  connected repo, so the tenant never has to write their own GitHub Actions file.
  - GitHub App (external, one-time setup — see **Configuration** below for the
    5 `GH_APP_*` vars this produces) with `Contents: Read and write`, `Workflows: Read and write`,
    `Secrets: Read and write`, `Metadata: Read-only` permissions
  - `src/github/{app,oauth,installation,workflow}.ts` + dashboard endpoints: `install-url`,
    `oauth/callback`, `installations`, `repos`
  - `POST /api/dashboard/clients` — body `{domain, repoFullName, installationId, defaultBranch}`;
    the slug is *derived* from the repo name (`slugifyRepoName`/`uniqueSlugFor` in
    `src/dashboard/clients.ts`, auto-suffixed on collision), never admin-entered. Also generates a
    per-client deploy token, commits `.github/workflows/deploy-njin.yml` to the repo
    (`commitWorkflowFile`) and sets it as a repo Actions secret (`setDeploySecret`, encrypted with
    `libsodium-wrappers` per GitHub's required `crypto_box_seal` scheme — the one dependency added
    for this, since `node:crypto` has no equivalent). If the commit/secret step fails (e.g.
    insufficient permissions), the client is still created — the response reports
    `workflowInjected: false` instead of failing the whole registration.
    `POST /api/dashboard/clients/:slug/domains` attaches additional alias domains to an existing
    client.
  - `src/deploy/{upload,materialize}.ts` + `POST /api/deploy/:slug` (bearer deploy-token auth, not
    the dashboard session cookie — this is called by the tenant's own GitHub Actions run):
    extracts the uploaded build tarball (via the system `tar` binary) atomically into
    `clients/<slug>/`
  - `redeployWorker(slug)` in `supervisor.ts`: spawns a new worker for the client, waits for it to
    become ready, only then swaps it into the dispatch table and gracefully shuts down the old one
    (zero-downtime hot-swap, no supervisor restart) — a build that never boots leaves the
    previously-working worker untouched and the deploy recorded as `failed` in the `deploys` table
  - Deploy history (`deploys` table, `src/db/repositories/deploys.ts`) is recorded but not yet
    surfaced in the SPA — a client-detail page showing it is still open (M5-ish polish, not
    blocking)

- [ ] **M5 — Deploy history UI + first real GitHub-driven tenant**
  The deploy workflow itself is already auto-committed per-repo by M3+M4 above (`src/github/workflow.ts`)
  — this milestone is about polish and validation, not building the workflow mechanism:
  - [x] Per-client "Deploys" dialog in the SPA (`GET /api/dashboard/clients/:slug/deploys`,
    `dashboard-ui/src/components/DeployHistoryDialog.tsx`) — status, commit sha, error, timestamps
    per deploy attempt
  - [x] "Re-inject workflow" action (`POST /api/dashboard/clients/:slug/reinject-workflow`) for a
    client whose `workflowInjected` came back `false` at creation time (or whose secret/workflow
    needs rotating) — mints a fresh deploy token, rotates `clients.deploy_token_hash`, re-commits
    the workflow file and resets the repo secret, all from the dashboard instead of a manual commit
  - [x] `CLAUDE.md`/this README updated with the finished architecture
  - [ ] Validate the full loop end-to-end on one real connected repo (an actual `git push` →
    Actions run → `POST /api/deploy/:slug` → hot-swap, observed working) — client registration and
    workflow auto-injection are confirmed working against real GitHub repos, but a real deploy
    hasn't been exercised yet. The old manual-copy flow keeps working throughout as a fallback.

## Configuration

The supervisor's own `.env` (not committed) is now deliberately minimal — it configures the
supervisor process only, never a tenant worker:

- `PORT` — HTTP port the supervisor listens on (default `11005`)
- `CLIENTS_ROOT` — override for where `clients/` lives (default: sibling of `src/`)
- `CONTROL_DB_PATH` — override for the control-plane SQLite file (default `data/supervisor.db`)
- `DASHBOARD_HOST` — Host the dashboard SPA is served under; unset disables dashboard routing
  entirely (see **M2** below)
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — seed the one initial dashboard admin at boot, only if
  `admin_users` is still empty; must both be set together or both left unset
- `DASHBOARD_COOKIE_SECURE` — whether the session cookie gets the `Secure` flag (default `true`;
  set to `false` for local HTTP `*.test` development only)
- `GH_APP_ID` / `GH_APP_PRIVATE_KEY` / `GH_APP_CLIENT_ID` / `GH_APP_CLIENT_SECRET` / `GH_APP_SLUG`
  — GitHub App credentials for the "Add Client" flow (see **M3+M4** above); all optional, but
  must be set together or all left unset (unset disables `/api/dashboard/github/*` and
  `/api/deploy/:slug`, returning `503`, without affecting anything else). `GH_APP_PRIVATE_KEY` is
  **base64 of the App's downloaded `.pem`** (`base64 -w0 private-key.pem`), not the raw PEM — a
  multi-line PEM in a `.env` value is fragile across shells/parsers. Register the App at
  `https://github.com/settings/apps/new` with `Contents: Read and write`, `Workflows: Read and
  write`, `Secrets: Read and write`, `Metadata: Read-only` permissions, "Request user
  authorization (OAuth) during installation" enabled, and callback URL
  `https://<DASHBOARD_HOST>/api/dashboard/github/oauth/callback`.

Everything a tenant needs (`DB_PATH`/`DB_NAMESPACE`/`DB_DATABASE`/`DB_USERNAME`/`DB_PASSWORD`,
`FILE_DIR` or `S3_*`, `IMG_HOSTS`, etc.) is configured per client — see **Per-client environment
variables** above — not here.

The production host also needs a `tar` binary on `PATH` — `POST /api/deploy/:slug` shells out to
it to extract uploaded build tarballs (near-universal on Linux; not a new dependency, but worth
confirming for whatever host actually runs this).
