import { z } from "zod";
import { findClientBySlug, listClients, updateDeployTokenHash } from "../db/repositories/clients";
import {
  addDomain,
  deleteDomain,
  findDomainByHost,
  findPrimaryHostForClient,
  listDomainsForClient,
  setPrimaryDomain,
} from "../db/repositories/domains";
import { findMailDomainForClient, upsertMailDomain } from "../db/repositories/mailDomains";
import { createDeploy, listDeploysForClient, updateDeployStatus } from "../db/repositories/deploys";
import { deleteEnvVar, listEnvForClient, setEnvVar } from "../db/repositories/env";
import { hasClientDir } from "../supervisor/discovery";
import {
  buildClearCookieHeaders,
  buildSessionCookieHeaders,
  getSessionFromRequest,
  login,
  logout,
} from "./auth";
import {
  createClientWithPrimaryDomain,
  deleteClientCascade,
  type EvictWorker,
  type RedeployWorker,
} from "./clients";
import { getAsset, getIndexHtml, isDashboardBuilt } from "./static";
import { isGithubAppConfigured } from "../github/app";
import { listInstallations, listRepositoriesForInstallation } from "../github/installation";
import { buildInstallUrl, consumeInstallState, createInstallState, exchangeOauthCode } from "../github/oauth";
import { commitWorkflowFile, setDeploySecret } from "../github/workflow";
import { generateDeployToken, hashDeployToken, verifyDeployToken } from "../deploy/upload";
import { materializeBuild } from "../deploy/materialize";
import { HOSTNAME_RE } from "../util/hostname";
import { createDomain as createMailDomain, isMailConfigured, refreshDnsZoneFile } from "../mail/stalwart";
import { env } from "../env";

const loginBodySchema = z.object({ email: z.string(), password: z.string() });

const createClientBodySchema = z.object({
  domain: z.string(),
  repoFullName: z.string(),
  installationId: z.number(),
  defaultBranch: z.string(),
});

const addDomainBodySchema = z.object({ host: z.string() });

// Conventional env-var naming (DB_PATH, S3_*, IMG_HOSTS, ...) — matches what spawnWorker() ends
// up passing straight to a Bun Worker's env, so anything else would be a plausible but useless
// key nothing in the njin app would ever read.
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const setEnvBodySchema = z.object({ key: z.string(), value: z.string() });

const withSetCookies = (response: Response, headers: string[]): Response => {
  for (const header of headers) response.headers.append("set-cookie", header);
  return response;
};

const githubUnavailable = (): Response => Response.json({ error: "GitHub App not configured" }, { status: 503 });
const mailUnavailable = (): Response => Response.json({ error: "Mail hosting is not configured" }, { status: 503 });

// Response.redirect() resolves its target against a base URL per the Fetch spec — there's no
// implicit "document" base on the server, so every redirect target here is resolved against the
// incoming request's own URL to get a valid absolute URL.
const redirectTo = (request: Request, path: string): Response =>
  Response.redirect(new URL(path, request.url).toString(), 302);

// No HTTP framework here (mirrors the terse branching style already used in supervisor.ts's
// fetch handler) — the scope doesn't justify adding one.
export const handleDashboardRequest = async (
  request: Request,
  deps: { evictWorker: EvictWorker; redeployWorker: RedeployWorker },
): Promise<Response> => {
  const url = new URL(request.url);

  // Deploy uploads come from a GitHub Actions runner, not a browser — authenticated by a
  // per-client bearer token (not the dashboard session cookie), and must work even if the
  // dashboard-ui SPA itself hasn't been built (unrelated concerns), so this is checked before
  // the isDashboardBuilt() gate below.
  const deployMatch = url.pathname.match(/^\/api\/deploy\/([^/]+)$/);
  if (deployMatch && request.method === "POST") {
    const slug = decodeURIComponent(deployMatch[1]!);
    const authHeader = request.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
    if (!token) return new Response("Unauthorized", { status: 401 });

    const client = verifyDeployToken(slug, token);
    if (!client) return new Response("Unauthorized", { status: 401 });

    const commitSha = request.headers.get("x-commit-sha");
    const deploy = createDeploy(client.id, "github-actions", commitSha);

    try {
      const tarBytes = await request.arrayBuffer();
      await materializeBuild(slug, tarBytes);
    } catch (error) {
      updateDeployStatus(deploy.id, "failed", error instanceof Error ? error.message : String(error));
      return new Response("Bad Gateway", { status: 502 });
    }

    // Extraction succeeding is what the caller (a `curl` step in the tenant's own CI run) cares
    // about — respond now instead of also blocking on the worker hot-swap, which can legitimately
    // take up to BOOT_TIMEOUT_MS and would otherwise make the CI step hang, or fail outright if
    // the new worker is merely slow rather than actually broken. The swap still happens right
    // after, just without the HTTP response waiting on it; its real outcome updates this same
    // deploy row (visible in the dashboard's "Deploys" dialog) instead of being reported here.
    void deps
      .redeployWorker(slug)
      .then(() => updateDeployStatus(deploy.id, "success"))
      .catch((error) => updateDeployStatus(deploy.id, "failed", error instanceof Error ? error.message : String(error)));

    return Response.json({ slug });
  }

  if (!isDashboardBuilt()) {
    return new Response('dashboard-ui not built — run "bun run dashboard:build"', { status: 503 });
  }

  if (url.pathname === "/api/dashboard/login" && request.method === "POST") {
    const parsed = loginBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });

    const session = await login(parsed.data.email, parsed.data.password);
    if (!session) return new Response("Unauthorized", { status: 401 });

    return withSetCookies(
      Response.json({ email: parsed.data.email }),
      buildSessionCookieHeaders(session),
    );
  }

  if (url.pathname === "/api/dashboard/logout" && request.method === "POST") {
    logout(request);
    return withSetCookies(new Response(null, { status: 200 }), buildClearCookieHeaders());
  }

  if (url.pathname === "/api/dashboard/clients" && request.method === "GET") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });

    // client.status is just whatever's stored in the DB — nothing keeps it in sync with the
    // clients/<slug>/ directory actually existing on disk (deleting a directory doesn't touch
    // the DB row, by design — see CLAUDE.md's "clients/ directory" section: it's build output,
    // and its DB row/env/domains are a separate control-plane concern that may still be wanted
    // even with the build temporarily gone). buildPresent reports the real, current disk state
    // alongside it so the dashboard doesn't show a deleted client as blithely "active".
    const clients = listClients().map((client) => ({
      slug: client.slug,
      status: client.status,
      source: client.source,
      buildPresent: hasClientDir(client.slug),
      domains: listDomainsForClient(client.id),
    }));
    return Response.json(clients);
  }

  if (url.pathname === "/api/dashboard/clients" && request.method === "POST") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });

    const parsed = createClientBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });

    const domain = parsed.data.domain.toLowerCase();
    if (!HOSTNAME_RE.test(domain)) return new Response("Bad Request", { status: 400 });
    if (findDomainByHost(domain)) return new Response("Conflict", { status: 409 });

    const deployToken = generateDeployToken();
    let client;
    try {
      client = createClientWithPrimaryDomain({
        domain,
        repoFullName: parsed.data.repoFullName,
        installationId: parsed.data.installationId,
        defaultBranch: parsed.data.defaultBranch,
        deployTokenHash: hashDeployToken(deployToken),
      });
    } catch {
      return new Response("Conflict", { status: 409 });
    }

    let workflowInjected = true;
    let workflowError: string | undefined;
    try {
      await commitWorkflowFile(parsed.data.installationId, parsed.data.repoFullName, parsed.data.defaultBranch, client.slug);
      await setDeploySecret(parsed.data.installationId, parsed.data.repoFullName, deployToken);
    } catch (error) {
      workflowInjected = false;
      workflowError = error instanceof Error ? error.message : String(error);
    }

    return Response.json({ slug: client.slug, domain, workflowInjected, workflowError }, { status: 201 });
  }

  const clientDomainsMatch = url.pathname.match(/^\/api\/dashboard\/clients\/([^/]+)\/domains$/);
  if (clientDomainsMatch && request.method === "POST") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });

    const slug = decodeURIComponent(clientDomainsMatch[1]!);
    const client = findClientBySlug(slug);
    if (!client) return new Response("Not Found", { status: 404 });

    const parsed = addDomainBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });

    const host = parsed.data.host.toLowerCase();
    if (!HOSTNAME_RE.test(host)) return new Response("Bad Request", { status: 400 });
    if (findDomainByHost(host)) return new Response("Conflict", { status: 409 });

    addDomain(client.id, host, false);
    return new Response(null, { status: 201 });
  }

  const clientDomainHostMatch = url.pathname.match(/^\/api\/dashboard\/clients\/([^/]+)\/domains\/([^/]+)$/);
  if (clientDomainHostMatch && request.method === "DELETE") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });

    const slug = decodeURIComponent(clientDomainHostMatch[1]!);
    const client = findClientBySlug(slug);
    if (!client) return new Response("Not Found", { status: 404 });

    const host = decodeURIComponent(clientDomainHostMatch[2]!);
    const domains = listDomainsForClient(client.id);
    const domain = domains.find((d) => d.host === host);
    if (!domain) return new Response("Not Found", { status: 404 });
    // The primary domain is what supervisor.ts actually dispatches to — deleting it (or the
    // client's only domain, which is necessarily primary) would leave the client unreachable, so
    // an admin must set a different domain as primary first.
    if (domain.isPrimary) return new Response("Conflict", { status: 409 });

    deleteDomain(client.id, host);
    return new Response(null, { status: 204 });
  }

  const clientDomainPrimaryMatch = url.pathname.match(
    /^\/api\/dashboard\/clients\/([^/]+)\/domains\/([^/]+)\/primary$/,
  );
  if (clientDomainPrimaryMatch && request.method === "POST") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });

    const slug = decodeURIComponent(clientDomainPrimaryMatch[1]!);
    const client = findClientBySlug(slug);
    if (!client) return new Response("Not Found", { status: 404 });

    const host = decodeURIComponent(clientDomainPrimaryMatch[2]!);
    const domain = listDomainsForClient(client.id).find((d) => d.host === host);
    if (!domain) return new Response("Not Found", { status: 404 });

    if (!domain.isPrimary) setPrimaryDomain(client.id, host);
    return new Response(null, { status: 204 });
  }

  const clientEnvMatch = url.pathname.match(/^\/api\/dashboard\/clients\/([^/]+)\/env$/);
  if (clientEnvMatch && request.method === "GET") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });

    const slug = decodeURIComponent(clientEnvMatch[1]!);
    const client = findClientBySlug(slug);
    if (!client) return new Response("Not Found", { status: 404 });

    return Response.json(listEnvForClient(client.id));
  }

  if (clientEnvMatch && request.method === "POST") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });

    const slug = decodeURIComponent(clientEnvMatch[1]!);
    const client = findClientBySlug(slug);
    if (!client) return new Response("Not Found", { status: 404 });

    const parsed = setEnvBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || !ENV_KEY_RE.test(parsed.data.key)) return new Response("Bad Request", { status: 400 });

    setEnvVar(client.id, parsed.data.key, parsed.data.value);
    // Env only takes effect for a freshly-spawned worker (spawnWorker reads it once, at spawn
    // time) — evict the resident one, if any, so the *next* request picks up the change instead
    // of silently continuing to serve on stale env until some unrelated crash/redeploy happens.
    deps.evictWorker(slug);
    return new Response(null, { status: 201 });
  }

  const clientEnvKeyMatch = url.pathname.match(/^\/api\/dashboard\/clients\/([^/]+)\/env\/([^/]+)$/);
  if (clientEnvKeyMatch && request.method === "DELETE") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });

    const slug = decodeURIComponent(clientEnvKeyMatch[1]!);
    const client = findClientBySlug(slug);
    if (!client) return new Response("Not Found", { status: 404 });

    deleteEnvVar(client.id, decodeURIComponent(clientEnvKeyMatch[2]!));
    deps.evictWorker(slug);
    return new Response(null, { status: 204 });
  }

  const clientDeploysMatch = url.pathname.match(/^\/api\/dashboard\/clients\/([^/]+)\/deploys$/);
  if (clientDeploysMatch && request.method === "GET") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });

    const slug = decodeURIComponent(clientDeploysMatch[1]!);
    const client = findClientBySlug(slug);
    if (!client) return new Response("Not Found", { status: 404 });

    return Response.json(
      listDeploysForClient(client.id).map((d) => ({
        status: d.status,
        triggeredBy: d.triggered_by,
        commitSha: d.commit_sha,
        errorMessage: d.error_message,
        startedAt: d.started_at,
        finishedAt: d.finished_at,
      })),
    );
  }

  const reinjectMatch = url.pathname.match(/^\/api\/dashboard\/clients\/([^/]+)\/reinject-workflow$/);
  if (reinjectMatch && request.method === "POST") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });
    if (!isGithubAppConfigured()) return githubUnavailable();

    const slug = decodeURIComponent(reinjectMatch[1]!);
    const client = findClientBySlug(slug);
    if (!client) return new Response("Not Found", { status: 404 });
    if (client.source !== "github" || !client.repo_full_name || !client.installation_id || !client.default_branch) {
      return Response.json({ error: "Client was not created via GitHub, nothing to re-inject" }, { status: 400 });
    }

    // The raw deploy token is never stored (only its hash) — re-injecting means minting a fresh
    // one and rotating the stored hash to match, so any prior token stops verifying the moment
    // this succeeds. If the GitHub calls below fail, the rotation is still committed: it's
    // simpler and safer to require a retry (which mints yet another fresh token) than to leave
    // a token whose repo secret we're not sure actually got updated.
    const deployToken = generateDeployToken();
    updateDeployTokenHash(client.id, hashDeployToken(deployToken));

    try {
      await commitWorkflowFile(client.installation_id, client.repo_full_name, client.default_branch, client.slug);
      await setDeploySecret(client.installation_id, client.repo_full_name, deployToken);
    } catch (error) {
      return Response.json(
        { workflowInjected: false, workflowError: error instanceof Error ? error.message : String(error) },
        { status: 200 },
      );
    }

    return Response.json({ workflowInjected: true });
  }

  const clientMailMatch = url.pathname.match(/^\/api\/dashboard\/clients\/([^/]+)\/mail$/);
  if (clientMailMatch && request.method === "GET") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });

    const slug = decodeURIComponent(clientMailMatch[1]!);
    const client = findClientBySlug(slug);
    if (!client) return new Response("Not Found", { status: 404 });

    const mailDomain = findMailDomainForClient(client.id);
    return Response.json({
      configured: isMailConfigured(),
      enabled: Boolean(mailDomain),
      domain: mailDomain?.domain ?? null,
      dnsZoneFile: mailDomain?.dns_zone_file ?? null,
      mailHostname: env.STALWART_MAIL_HOSTNAME ?? null,
    });
  }

  const clientMailEnableMatch = url.pathname.match(/^\/api\/dashboard\/clients\/([^/]+)\/mail\/enable$/);
  if (clientMailEnableMatch && request.method === "POST") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });
    if (!isMailConfigured()) return mailUnavailable();

    const slug = decodeURIComponent(clientMailEnableMatch[1]!);
    const client = findClientBySlug(slug);
    if (!client) return new Response("Not Found", { status: 404 });

    const primaryHost = findPrimaryHostForClient(client.id);
    if (!primaryHost) return Response.json({ error: "Client has no primary domain" }, { status: 400 });

    let result;
    try {
      result = await createMailDomain(primaryHost);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
    }

    upsertMailDomain(client.id, primaryHost, result.stalwartDomainId, result.dnsZoneFile);
    // The tenant's njin worker calls Stalwart's Management API directly using this shared key
    // (see CLAUDE.md's mail-hosting notes) — set only now, at enable time, not for every client
    // unconditionally, since a client with email disabled has no use for it.
    setEnvVar(client.id, "STALWART_URL", env.STALWART_URL!);
    setEnvVar(client.id, "STALWART_API_KEY", env.STALWART_API_KEY!);
    setEnvVar(client.id, "STALWART_DOMAIN", primaryHost);
    deps.evictWorker(slug);

    return Response.json({
      domain: primaryHost,
      dnsZoneFile: result.dnsZoneFile,
      mailHostname: env.STALWART_MAIL_HOSTNAME,
    });
  }

  const clientMailRefreshMatch = url.pathname.match(/^\/api\/dashboard\/clients\/([^/]+)\/mail\/refresh$/);
  if (clientMailRefreshMatch && request.method === "POST") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });
    if (!isMailConfigured()) return mailUnavailable();

    const slug = decodeURIComponent(clientMailRefreshMatch[1]!);
    const client = findClientBySlug(slug);
    if (!client) return new Response("Not Found", { status: 404 });

    const mailDomain = findMailDomainForClient(client.id);
    if (!mailDomain) return Response.json({ error: "Email is not enabled for this client" }, { status: 400 });

    let dnsZoneFile: string;
    try {
      dnsZoneFile = await refreshDnsZoneFile(mailDomain.stalwart_domain_id);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
    }

    upsertMailDomain(client.id, mailDomain.domain, mailDomain.stalwart_domain_id, dnsZoneFile);
    return Response.json({ domain: mailDomain.domain, dnsZoneFile, mailHostname: env.STALWART_MAIL_HOSTNAME });
  }

  if (url.pathname === "/api/dashboard/github/install-url" && request.method === "GET") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });
    if (!isGithubAppConfigured()) return githubUnavailable();

    return Response.json({ url: buildInstallUrl(createInstallState()) });
  }

  if (url.pathname === "/api/dashboard/github/oauth/callback" && request.method === "GET") {
    // A full-page browser redirect target hit in the admin's own tab, not a fetch() caller — the
    // session cookie is present if this is legitimate, so an absent session gets a redirect
    // "home" (not a JSON 401) to stop a logged-out/replayed hit from completing someone's install.
    const session = getSessionFromRequest(request);
    if (!session) return redirectTo(request, "/");
    if (!isGithubAppConfigured()) return new Response("GitHub App not configured", { status: 503 });

    const state = url.searchParams.get("state");
    if (!state || !consumeInstallState(state)) return redirectTo(request, "/?github_error=invalid_state");

    const installationId = url.searchParams.get("installation_id");
    if (!installationId) return redirectTo(request, "/?github_error=missing_installation");

    const code = url.searchParams.get("code");
    if (code) {
      try {
        await exchangeOauthCode(code);
      } catch {
        return redirectTo(request, "/?github_error=oauth_exchange_failed");
      }
    }

    return redirectTo(request, `/?github_installation_id=${encodeURIComponent(installationId)}`);
  }

  if (url.pathname === "/api/dashboard/github/installations" && request.method === "GET") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });
    if (!isGithubAppConfigured()) return githubUnavailable();

    try {
      return Response.json(await listInstallations());
    } catch {
      return new Response("Bad Gateway", { status: 502 });
    }
  }

  if (url.pathname === "/api/dashboard/github/repos" && request.method === "GET") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });
    if (!isGithubAppConfigured()) return githubUnavailable();

    const installationId = Number(url.searchParams.get("installation_id"));
    if (!installationId) return new Response("Bad Request", { status: 400 });

    try {
      return Response.json(await listRepositoriesForInstallation(installationId));
    } catch {
      return new Response("Bad Gateway", { status: 502 });
    }
  }

  const clientMatch = url.pathname.match(/^\/api\/dashboard\/clients\/([^/]+)$/);
  if (clientMatch && request.method === "DELETE") {
    const session = getSessionFromRequest(request);
    if (!session) return new Response("Unauthorized", { status: 401 });

    const slug = decodeURIComponent(clientMatch[1]!);
    const deleted = deleteClientCascade(slug, deps.evictWorker);
    if (!deleted) return new Response("Not Found", { status: 404 });
    return new Response(null, { status: 204 });
  }

  if (url.pathname.startsWith("/api/")) return new Response("Not Found", { status: 404 });

  // Exact static-asset match first (Vite's hashed filenames under /assets/ can be cached
  // aggressively); anything else (client-side routes, deep links, "/") falls back to index.html
  // so the SPA's own router owns it.
  const asset = await getAsset(url.pathname);
  if (asset) {
    const isImmutable = url.pathname.startsWith("/assets/");
    return new Response(asset.body, {
      headers: {
        "content-type": asset.contentType,
        ...(isImmutable ? { "cache-control": "public, max-age=31536000, immutable" } : {}),
      },
    });
  }

  const index = await getIndexHtml();
  if (!index) return new Response("Not Found", { status: 404 });
  return new Response(index.body, { headers: { "content-type": "text/html; charset=utf-8" } });
};
