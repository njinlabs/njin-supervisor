import { mkdirSync, existsSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getClientDir } from "../supervisor/discovery";

// Extracts an uploaded build tarball into clients/<slug>/, swapping it in atomically (rename,
// not an in-place overwrite) so a request racing a deploy never sees a half-written directory.
// The old directory is kept briefly under a .old-<ts> suffix as a rollback point, then removed —
// not restored automatically (see plan's "explicitly out of scope").
export const materializeBuild = async (slug: string, tarBytes: ArrayBuffer): Promise<void> => {
  const clientDir = getClientDir(slug);
  const tmpDir = `${clientDir}.tmp-${crypto.randomUUID()}`;
  const tmpTarFile = `${tmpDir}.tar.gz`;

  mkdirSync(tmpDir, { recursive: true });
  await Bun.write(tmpTarFile, tarBytes);

  try {
    const proc = Bun.spawn(["tar", "xzf", tmpTarFile, "-C", tmpDir]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`tar extraction failed with exit code ${exitCode}`);
    if (!existsSync(join(tmpDir, "worker.js"))) throw new Error("uploaded build has no worker.js");

    const oldDir = `${clientDir}.old-${Date.now()}`;
    if (existsSync(clientDir)) renameSync(clientDir, oldDir);
    renameSync(tmpDir, clientDir);
    // Best-effort cleanup — a failure here (e.g. transient OS lock) isn't fatal, the swap above
    // already succeeded and that's what matters for serving traffic.
    if (existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpTarFile, { force: true });
  }
};
