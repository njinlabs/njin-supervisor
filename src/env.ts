import { join } from "node:path";
import { z } from "zod";

// Centralized process.env parsing for the supervisor itself. Per-tenant env vars (DB_*, S3_*,
// IMG_HOSTS, ...) are NOT parsed here — those are consumed by each worker's own njin app via
// full process.env passthrough (see spawnWorker in supervisor/supervisor.ts), not by this file.
const schema = z
  .object({
    PORT: z.coerce.number().int().positive().default(11005),
    // Portable, not a hardcoded absolute path — import.meta.dir resolves to wherever this file
    // itself actually lives at runtime, so clients/ is found as long as it stays a sibling of src/.
    CLIENTS_ROOT: z
      .string()
      .optional()
      .transform((v) => v ?? join(import.meta.dir, "..", "clients")),
    CONTROL_DB_PATH: z
      .string()
      .optional()
      .transform((v) => v ?? join(import.meta.dir, "..", "data", "supervisor.db")),
    // Dashboard requests are routed by this dedicated Host (never a `domains` row) rather than a
    // path prefix, so they can't collide with any tenant's own routes. Optional — unset disables
    // the dashboard routing branch entirely (see supervisor.ts), letting the supervisor boot with
    // dashboard support off.
    DASHBOARD_HOST: z.string().optional(),
    // Base URL of the Varnish cache in front of this process (see deploy/varnish/) — optional,
    // Varnish isn't required to run the supervisor. When set, redeployWorker() bans that
    // tenant's cached objects right after a successful hot-swap so a stale build never lingers
    // in cache past a deploy. Unset -> that ban call is just skipped.
    VARNISH_URL: z.string().optional(),
    ADMIN_EMAIL: z.string().email().optional(),
    ADMIN_PASSWORD: z.string().min(8).optional(),
    // Bun.serve here has no TLS config — production deployments sit behind a TLS-terminating
    // reverse proxy, so request.url is always http:// even in prod and can't be used to decide
    // the cookie's Secure flag. Defaults safely to true; local *.test HTTP dev opts out explicitly.
    // NOT z.coerce.boolean() — that's JS `Boolean(str)`, which is true for "false" too.
    DASHBOARD_COOKIE_SECURE: z
      .string()
      .optional()
      .transform((v) => v !== "false"),
    // GitHub App integration (M3+M4) — all optional, but all-or-nothing (see the refine below).
    // Unset entirely -> boot still succeeds, GitHub/deploy endpoints just return 503 instead of
    // crashing. GH_APP_PRIVATE_KEY is base64 of the App's downloaded .pem (raw multi-line PEM in
    // a .env file is fragile across shells/parsers) — decoded at use time in github/app.ts.
    GH_APP_ID: z.string().optional(),
    GH_APP_PRIVATE_KEY: z.string().optional(),
    GH_APP_CLIENT_ID: z.string().optional(),
    GH_APP_CLIENT_SECRET: z.string().optional(),
    GH_APP_SLUG: z.string().optional(),
    // Mail hosting (Stalwart) — all optional but all-or-nothing (see the refine below). Unset ->
    // boot still succeeds, the dashboard's "Enable Email" endpoints just return 503. STALWART_URL
    // is the Management API base (e.g. http://127.0.0.1:8080), STALWART_API_KEY the single shared
    // admin API key used for every tenant (see src/mail/stalwart.ts and CLAUDE.md's mail-hosting
    // notes for the deliberate single-shared-key tradeoff), STALWART_MAIL_HOSTNAME the one MX
    // target every tenant domain shares (mail sharing means no new A record/cert per tenant).
    STALWART_URL: z.string().optional(),
    STALWART_API_KEY: z.string().optional(),
    STALWART_MAIL_HOSTNAME: z.string().optional(),
  })
  // Seeding a broken admin (email with no password, or vice versa) should fail loudly at boot,
  // not silently no-op — see seedAdminIfNeeded() in dashboard/auth.ts.
  .refine((v) => Boolean(v.ADMIN_EMAIL) === Boolean(v.ADMIN_PASSWORD), {
    message: "ADMIN_EMAIL and ADMIN_PASSWORD must both be set, or both be unset",
    path: ["ADMIN_EMAIL"],
  })
  .refine(
    (v) => {
      const fields = [v.GH_APP_ID, v.GH_APP_PRIVATE_KEY, v.GH_APP_CLIENT_ID, v.GH_APP_CLIENT_SECRET, v.GH_APP_SLUG];
      const setCount = fields.filter(Boolean).length;
      return setCount === 0 || setCount === fields.length;
    },
    {
      message:
        "GH_APP_ID, GH_APP_PRIVATE_KEY, GH_APP_CLIENT_ID, GH_APP_CLIENT_SECRET and GH_APP_SLUG must all be set together, or all be unset",
      path: ["GH_APP_ID"],
    },
  )
  .refine(
    (v) => {
      const fields = [v.STALWART_URL, v.STALWART_API_KEY, v.STALWART_MAIL_HOSTNAME];
      const setCount = fields.filter(Boolean).length;
      return setCount === 0 || setCount === fields.length;
    },
    {
      message: "STALWART_URL, STALWART_API_KEY and STALWART_MAIL_HOSTNAME must all be set together, or all be unset",
      path: ["STALWART_URL"],
    },
  );

export const env = schema.parse(process.env);
