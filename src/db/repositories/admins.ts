import { db } from "../client";

export type AdminUserRow = {
  id: number;
  email: string;
  password_hash: string;
  created_at: string;
};

// Whether any admin exists yet — what makes seedAdminIfNeeded() (dashboard/auth.ts) idempotent.
export const countAdminUsers = (): number =>
  (db.query("SELECT COUNT(*) as count FROM admin_users").get() as { count: number }).count;

export const findAdminByEmail = (email: string): AdminUserRow | null =>
  (db.query("SELECT * FROM admin_users WHERE email = ?").get(email) as AdminUserRow | null) ?? null;

export const findAdminById = (id: number): AdminUserRow | null =>
  (db.query("SELECT * FROM admin_users WHERE id = ?").get(id) as AdminUserRow | null) ?? null;

export const createAdminUser = (email: string, passwordHash: string): AdminUserRow => {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO admin_users (email, password_hash, created_at) VALUES (?, ?, ?)`,
  ).run(email, passwordHash, now);
  return findAdminByEmail(email)!;
};
