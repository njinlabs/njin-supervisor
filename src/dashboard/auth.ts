import { env } from "../env";
import { countAdminUsers, createAdminUser, findAdminByEmail } from "../db/repositories/admins";
import { createSession, deleteSession, findValidSession, type SessionRow } from "../db/repositories/sessions";

export const SESSION_COOKIE_NAME = "njin_dashboard_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Idempotent — called once at boot (src/index.ts, after ensureSchema()). Only seeds if both
// ADMIN_EMAIL/ADMIN_PASSWORD are configured (env.ts's refine() guarantees they're both-or-neither)
// and no admin exists yet, so re-running on every restart never creates a second admin or resets
// the first one's password.
export const seedAdminIfNeeded = async (): Promise<void> => {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    console.log("Dashboard admin seeding skipped (ADMIN_EMAIL/ADMIN_PASSWORD not set)");
    return;
  }
  if (countAdminUsers() > 0) {
    console.log("Dashboard admin seeding skipped (an admin already exists)");
    return;
  }
  const passwordHash = await Bun.password.hash(env.ADMIN_PASSWORD);
  createAdminUser(env.ADMIN_EMAIL, passwordHash);
  console.log(`Dashboard admin seeded (${env.ADMIN_EMAIL})`);
};

// Same generic failure for "no such email" and "wrong password" — doesn't leak which one was
// wrong, so a caller can't use this to enumerate registered admin emails.
export const login = async (email: string, password: string): Promise<SessionRow | null> => {
  const admin = findAdminByEmail(email);
  if (!admin) return null;
  const valid = await Bun.password.verify(password, admin.password_hash);
  if (!valid) return null;
  return createSession(admin.id, SESSION_TTL_MS);
};

export const getSessionFromRequest = (request: Request): SessionRow | null => {
  const cookies = new Bun.CookieMap(request.headers.get("cookie") ?? "");
  const sessionId = cookies.get(SESSION_COOKIE_NAME);
  if (!sessionId) return null;
  return findValidSession(sessionId);
};

export const logout = (request: Request): void => {
  const cookies = new Bun.CookieMap(request.headers.get("cookie") ?? "");
  const sessionId = cookies.get(SESSION_COOKIE_NAME);
  if (sessionId) deleteSession(sessionId);
};

export const buildSessionCookieHeaders = (session: SessionRow): string[] => {
  const cookies = new Bun.CookieMap();
  cookies.set(SESSION_COOKIE_NAME, session.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: env.DASHBOARD_COOKIE_SECURE,
    expires: new Date(session.expires_at),
  });
  return cookies.toSetCookieHeaders();
};

export const buildClearCookieHeaders = (): string[] => {
  const cookies = new Bun.CookieMap();
  cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: env.DASHBOARD_COOKIE_SECURE,
    expires: new Date(0),
  });
  return cookies.toSetCookieHeaders();
};
