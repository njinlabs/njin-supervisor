import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { findClientBySlug, type ClientRow } from "../db/repositories/clients";

export const generateDeployToken = (): string => randomBytes(32).toString("hex");

export const hashDeployToken = (token: string): string => createHash("sha256").update(token).digest("hex");

// null if the slug doesn't exist, has never been connected via GitHub (no deploy_token_hash
// yet), or the presented token doesn't match — callers (POST /api/deploy/:slug) treat all three
// identically as 401, so the reason isn't distinguished here.
export const verifyDeployToken = (slug: string, presentedToken: string): ClientRow | null => {
  const client = findClientBySlug(slug);
  if (!client?.deploy_token_hash) return null;

  const presented = Buffer.from(hashDeployToken(presentedToken), "hex");
  const stored = Buffer.from(client.deploy_token_hash, "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;

  return client;
};
