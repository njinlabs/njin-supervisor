import sodium from "libsodium-wrappers";
import { env } from "../env";
import { getInstallationToken } from "./app";

const WORKFLOW_PATH = ".github/workflows/deploy-njin.yml";
const SECRET_NAME = "NJIN_DEPLOY_TOKEN";

// One repo = one client = one hardcoded slug + branch baked into its own workflow file — no
// runtime parameterization needed. Note: the branch name is substituted literally here, NOT via
// GitHub's "$default-branch" token — that placeholder only gets replaced by GitHub's own starter
// workflow *template* UI (workflow-templates/*.yml + properties.json), never for a file committed
// directly via the Contents API like this one. Using it literally would commit a workflow whose
// push trigger matches a branch that doesn't exist, so it would silently never run on any push.
export const renderDeployWorkflow = (slug: string, defaultBranch: string): string => `# Managed by njin-supervisor — do not edit by hand, changes will be overwritten on reconnect.
name: Deploy to njin
on:
  push:
    branches: [ "${defaultBranch}" ]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx njin build:worker
      - run: tar czf build.tar.gz -C out worker.js public src/views _admin
      - run: |
          curl -sf -X POST \\
            -H "Authorization: Bearer \${{ secrets.${SECRET_NAME} }}" \\
            -H "X-Commit-Sha: \${{ github.sha }}" \\
            --data-binary @build.tar.gz \\
            "${env.DASHBOARD_HOST ? `https://${env.DASHBOARD_HOST}` : ""}/api/deploy/${slug}"
`;

const githubApiHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
});

export const commitWorkflowFile = async (
  installationId: number,
  repoFullName: string,
  defaultBranch: string,
  slug: string,
): Promise<void> => {
  const token = await getInstallationToken(installationId);
  const contentUrl = `https://api.github.com/repos/${repoFullName}/contents/${WORKFLOW_PATH}`;

  // Look up the current file's sha (if any) — required by GitHub's contents API to update an
  // existing file rather than create a new one. A 404 just means "not created yet".
  const existing = await fetch(`${contentUrl}?ref=${encodeURIComponent(defaultBranch)}`, {
    headers: githubApiHeaders(token),
  });
  const existingSha = existing.ok ? ((await existing.json()) as { sha: string }).sha : undefined;

  const res = await fetch(contentUrl, {
    method: "PUT",
    headers: { ...githubApiHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      message: existingSha ? "Update njin deploy workflow" : "Add njin deploy workflow",
      content: Buffer.from(renderDeployWorkflow(slug, defaultBranch)).toString("base64"),
      branch: defaultBranch,
      ...(existingSha ? { sha: existingSha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Failed to commit workflow file: ${res.status} ${await res.text()}`);
};

export const setDeploySecret = async (
  installationId: number,
  repoFullName: string,
  deployToken: string,
): Promise<void> => {
  const token = await getInstallationToken(installationId);

  const keyRes = await fetch(`https://api.github.com/repos/${repoFullName}/actions/secrets/public-key`, {
    headers: githubApiHeaders(token),
  });
  if (!keyRes.ok) throw new Error(`Failed to fetch repo secrets public key: ${keyRes.status} ${await keyRes.text()}`);
  const { key, key_id } = (await keyRes.json()) as { key: string; key_id: string };

  // GitHub requires secret values encrypted with libsodium's sealed box (crypto_box_seal,
  // X25519-XSalsa20-Poly1305) against the repo's public key — node:crypto has no equivalent,
  // hence this dependency (mirrors GitHub's own documented Node.js example).
  await sodium.ready;
  const encrypted = sodium.crypto_box_seal(sodium.from_string(deployToken), sodium.from_base64(key, sodium.base64_variants.ORIGINAL));

  const putRes = await fetch(`https://api.github.com/repos/${repoFullName}/actions/secrets/${SECRET_NAME}`, {
    method: "PUT",
    headers: { ...githubApiHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ encrypted_value: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL), key_id }),
  });
  if (!putRes.ok) throw new Error(`Failed to set deploy secret: ${putRes.status} ${await putRes.text()}`);
};
