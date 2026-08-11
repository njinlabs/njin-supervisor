import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "../env";

const dir = dirname(env.CONTROL_DB_PATH);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

export const db = new Database(env.CONTROL_DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
