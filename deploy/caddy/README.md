# Caddy — automatic per-tenant HTTPS via on-demand TLS

Since tenant domains are registered dynamically through the dashboard (not known upfront in any
static config), Caddy's [on-demand TLS](https://caddyserver.com/docs/automatic-https#on-demand-tls)
is the fit here: instead of listing every hostname, Caddy asks the supervisor "should I get a cert
for this hostname?" on first connection, and only proceeds if the answer is yes.

`GET /api/internal/tls-ask?domain=<host>` (`src/supervisor/supervisor.ts`) is that "ask" endpoint
— it returns `200` only if `<host>` is `DASHBOARD_HOST` or a currently-registered `domains` row
(primary or alias, doesn't matter — Caddy just needs to know whether to cert it, the redirect for
an alias domain happens at the application layer same as always). Everything else gets `403`,
so pointing a random domain's DNS at this server's IP does **not** get it a free cert.

## Install

```bash
sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile
# Adjust the `ask` URL if the supervisor isn't on localhost:11005 (PORT in .env) — this assumes
# Caddy and the supervisor run on the same host. The `reverse_proxy` target (localhost:6081)
# points at Varnish, not the supervisor directly — see deploy/varnish/README.md; adjust it only
# if Varnish listens somewhere other than :6081, or drop straight to :11005 if not running
# Varnish at all.
sudo systemctl reload caddy
```

## Notes

- The `ask` endpoint is unauthenticated by design (Caddy's on-demand TLS doesn't support auth
  headers on the ask request) — it only ever answers yes/no about domain registration, no
  sensitive data. Keep it reachable only from Caddy itself (same host via `localhost`, as in the
  template) rather than exposing it on a public interface, to avoid letting an outsider enumerate
  which domains are registered.
- If running `njin-supervisor.service` (see `deploy/systemd/`), Varnish (see `deploy/varnish/`),
  and Caddy on the same host, Caddy owns ports 80/443 and proxies to Varnish, which in turn
  proxies to the supervisor's own `PORT` (default `11005`) as its one backend — the supervisor
  itself has no TLS config of its own (see `DASHBOARD_COOKIE_SECURE`'s comment in `src/env.ts`: it
  assumes it always sits behind a TLS-terminating proxy in production).
