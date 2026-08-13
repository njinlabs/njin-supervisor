vcl 4.1;

# Sits between Caddy (TLS termination, deploy/caddy/Caddyfile) and njin-supervisor:
#   Client -> Caddy :443 -> Varnish :6081 -> supervisor :11005
# Caddy's on_demand_tls "ask" call (see deploy/caddy/README.md) goes straight to the supervisor
# and never touches this file — nothing here needs to special-case that endpoint.
#
# Supervisor already resolves every request by its own Host header (findDomainByHost in
# src/db/repositories/domains.ts) and dispatches to the right tenant worker itself — so this
# VCL only ever needs ONE backend, not per-tenant backends. Varnish's builtin cache-hash
# already includes req.http.host, so different tenants never collide in cache even though they
# share this one backend.

backend default {
    .host = "127.0.0.1";
    .port = "11005";
}

# Only the supervisor process itself is allowed to issue a BAN — see vcl_recv below and
# redeployWorker() in src/supervisor/supervisor.ts, which fires one right after a successful
# hot-swap so a stale build never lingers in cache past a deploy.
acl ban_acl {
    "localhost";
    "127.0.0.1";
}

sub vcl_recv {
    # Custom method (not Varnish's built-in single-URL "purge") — wipes every cached object for
    # one tenant host in one shot, keyed on the Host header of the BAN request itself.
    if (req.method == "BAN") {
        if (!client.ip ~ ban_acl) {
            return (synth(403, "Forbidden"));
        }
        ban("req.http.host == " + req.http.host);
        return (synth(200, "Banned"));
    }

    # DASHBOARD_HOST — dashboard login/session/client-management/deploy-upload traffic all
    # lives under this one host (see CLAUDE.md's Dashboard section) — never cache any of it.
    if (req.http.host == "supervisor.jadiweb.id") {
        return (pass);
    }

    # Any tenant's own /api/* path (their njin app's API routes, if any) — also never cache.
    if (req.url ~ "^/api/") {
        return (pass);
    }

    if (req.method != "GET" && req.method != "HEAD") {
        return (pass);
    }

    # Unlike a stateless single-app backend, tenants here can be logged-in dashboards or
    # session-bearing njin apps — a request carrying a cookie or bearer token must always reach
    # the real worker, never a cached response meant for an anonymous visitor.
    if (req.http.Authorization || req.http.Cookie) {
        return (pass);
    }

    return (hash);
}

sub vcl_backend_response {
    # Never cache a response that's setting a cookie (session/auth), even on a path this VCL
    # didn't already know to bypass.
    if (beresp.http.Set-Cookie) {
        set beresp.uncacheable = true;
        return (deliver);
    }

    # Respect whatever Cache-Control a tenant's own njin app sends; only fall back to a short
    # default when it sends none at all.
    if (!beresp.http.Cache-Control) {
        set beresp.ttl = 120s;
    }
}

sub vcl_deliver {
    if (obj.hits > 0) {
        set resp.http.X-Cache = "HIT";
    } else {
        set resp.http.X-Cache = "MISS";
    }
}
