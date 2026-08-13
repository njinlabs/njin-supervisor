# Varnish — HTTP cache in front of the supervisor

Sits between Caddy and njin-supervisor: `Client -> Caddy :443 (TLS) -> Varnish :6081 -> supervisor
:11005`. A cache hit never reaches the supervisor at all, so it skips the per-request worker
marshaling cost (buffering the body, `postMessage` to the tenant's `Worker`) entirely — the win is
biggest for tenants whose traffic is mostly anonymous, publicly-cacheable pages.

Since the supervisor already resolves every request by its own `Host` header and dispatches to the
right tenant `Worker` itself, this VCL only needs **one** backend pointed at the supervisor's port
— it does not need per-tenant backend routing. Varnish's builtin cache-hash already includes
`req.http.host`, so different tenants' cached objects never collide even though they share this
one backend.

## Install

This replaces whatever `/etc/varnish/default.vcl` currently points at — if this Varnish instance
is also fronting another, unrelated app, do **not** install this file as-is; that app's backend
would silently disappear. (In this deployment the previous single-backend app was itself migrated
into this same supervisor as an ordinary `clients/<slug>/` tenant, so its old backend is dead and
safe to replace.)

```bash
sudo cp deploy/varnish/default.vcl /etc/varnish/default.vcl
# Edit the REPLACE_WITH_DASHBOARD_HOST placeholder in that file first — set it to this
# deployment's actual DASHBOARD_HOST value (see .env).

sudo varnishd -C -f /etc/varnish/default.vcl > /dev/null  # dry-compile check before reloading
sudo systemctl reload varnish
```

Then point Caddy's `reverse_proxy` at Varnish instead of the supervisor directly — in
`deploy/caddy/Caddyfile`, change:

```
reverse_proxy localhost:11005
```

to:

```
reverse_proxy localhost:6081
```

Leave the `on_demand_tls`'s `ask http://localhost:11005/...` line untouched — that's a
control-plane call from Caddy to the supervisor, not cacheable user traffic, and it's gated on
`Host: localhost`/`127.0.0.1` specifically because Caddy sends it directly (see
`deploy/caddy/README.md`).

Finally, set `VARNISH_URL` in the supervisor's `.env` (e.g. `http://localhost:6081`) so
`redeployWorker()` (`src/supervisor/supervisor.ts`) can issue a ban after every successful deploy —
see **Cache invalidation on deploy** below. Restart `njin-supervisor.service` to pick it up.

## Cache invalidation on deploy

A hot-swapped tenant's old build stays cached until its TTL naturally expires unless something
tells Varnish to drop it. This VCL adds a custom `BAN` HTTP method (not Varnish's built-in
single-URL `PURGE`) that wipes **every** cached object for one tenant `Host` in one call, since a
deploy can change any page, not just one URL:

```
BAN / HTTP/1.1
Host: <tenant-primary-domain>
```

Restricted by `ban_acl` to `localhost`/`127.0.0.1` — the supervisor is the only intended caller,
and it fires this automatically once `VARNISH_URL` is set (see above).

## Notes

- **Never cache the dashboard host or any `/api/*` path.** Dashboard sessions are cookie-based and
  deploy uploads are bearer-token-authenticated (`src/deploy/upload.ts`) — either one served from
  cache to the wrong caller would be a real security bug, not just a staleness annoyance.
- The VCL also passes through any request carrying `Cookie` or `Authorization` regardless of host,
  as defense in depth for tenants whose own njin app happens to be session-based too.
- `X-Cache: HIT`/`MISS` is added to every response in `vcl_deliver` — useful for confirming this is
  actually doing anything (`curl -sI https://<tenant-domain>/ | grep X-Cache`).

## Verify

```bash
systemctl status varnish
varnishlog -g request  # watch live traffic, confirm HIT/MISS and which paths are passing through
curl -sI https://<tenant-domain>/ | grep -i x-cache
```
