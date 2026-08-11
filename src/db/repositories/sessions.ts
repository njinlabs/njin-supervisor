import { db } from "../client";

export type SessionRow = {
  id: string;
  admin_user_id: number;
  expires_at: string;
  created_at: string;
};

// Opaque, unguessable random id — the session cookie's value is meaningless without a matching
// row here, so there's nothing to sign (no SESSION_SECRET/JWT needed).
const generateSessionId = (): string => crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");

export const createSession = (adminUserId: number, ttlMs: number): SessionRow => {
  const now = new Date();
  const id = generateSessionId();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  db.query(
    `INSERT INTO sessions (id, admin_user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
  ).run(id, adminUserId, expiresAt, now.toISOString());
  return { id, admin_user_id: adminUserId, expires_at: expiresAt, created_at: now.toISOString() };
};

// ISO-8601 timestamps sort/compare lexicographically, so a plain string comparison against "now"
// works without parsing either side.
export const findValidSession = (id: string): SessionRow | null => {
  const row = db.query("SELECT * FROM sessions WHERE id = ? AND expires_at > ?").get(
    id,
    new Date().toISOString(),
  ) as SessionRow | null;
  return row ?? null;
};

export const deleteSession = (id: string): void => {
  db.query("DELETE FROM sessions WHERE id = ?").run(id);
};
