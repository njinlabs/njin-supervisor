import { useEffect, useState } from "preact/hooks";
import {
  createClient,
  getGithubInstallUrl,
  listGithubInstallations,
  listGithubRepos,
  UnauthorizedError,
  type CreateClientResult,
  type GithubInstallation,
  type GithubRepo,
} from "../api";

export type AddClientDialogProps = {
  open: boolean;
  // Pre-supplied once the admin has been redirected back from GitHub's install flow
  // (?github_installation_id= on the dashboard URL) — skips straight to the repo picker.
  initialInstallationId: number | null;
  // Result is handed up rather than shown inline — the dialog closes right after a successful
  // create, so any "workflow injection failed" warning needs to live in the parent's own alert,
  // not local state that's about to unmount.
  onCreated: (result: CreateClientResult) => void;
  onCancel: () => void;
  onUnauthorized: () => void;
};

export const AddClientDialog = ({
  open,
  initialInstallationId,
  onCreated,
  onCancel,
  onUnauthorized,
}: AddClientDialogProps) => {
  const [installations, setInstallations] = useState<GithubInstallation[] | null>(null);
  const [installationId, setInstallationId] = useState<number | null>(initialInstallationId);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [selectedRepoFullName, setSelectedRepoFullName] = useState("");
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setInstallationId(initialInstallationId);
    setRepos(null);
    setSelectedRepoFullName("");
    setDomain("");
    setError(null);

    if (initialInstallationId === null) {
      listGithubInstallations()
        .then(setInstallations)
        .catch((err) => {
          if (err instanceof UnauthorizedError) onUnauthorized();
          else setError("Failed to load GitHub installations.");
        });
    }
  }, [open, initialInstallationId]);

  useEffect(() => {
    if (installationId === null) return;
    setRepos(null);
    listGithubRepos(installationId)
      .then(setRepos)
      .catch((err) => {
        if (err instanceof UnauthorizedError) onUnauthorized();
        else setError("Failed to load repositories for that installation.");
      });
  }, [installationId]);

  if (!open) return null;

  const connectGithub = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = await getGithubInstallUrl();
      window.location.href = url;
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError("Failed to start GitHub connection.");
      setBusy(false);
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    const repo = repos?.find((r) => r.fullName === selectedRepoFullName);
    if (!repo || installationId === null) return;

    setBusy(true);
    setError(null);
    try {
      const result = await createClient({
        domain: domain.trim(),
        repoFullName: repo.fullName,
        installationId,
        defaultBranch: repo.defaultBranch,
      });
      onCreated(result);
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError("Failed to create client — the domain may already be registered.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="dialog-backdrop" onClick={onCancel}>
      <div class="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Add Client</h2>

        {error && <div class="alert" role="alert">{error}</div>}

        {installationId === null ? (
          <>
            <p class="dialog-message">
              Clients are created by connecting a GitHub repository — pick an existing installation, or
              connect a new one.
            </p>
            {installations && installations.length > 0 && (
              <div class="field">
                <label for="add-client-installation">GitHub account/org</label>
                <select
                  id="add-client-installation"
                  onChange={(e) => setInstallationId(Number((e.target as HTMLSelectElement).value))}
                >
                  <option value="">Select…</option>
                  {installations.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.accountLogin}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div class="dialog-actions">
              <button class="btn btn-secondary" type="button" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button class="btn btn-primary" type="button" onClick={connectGithub} disabled={busy}>
                {busy ? "Redirecting…" : "Connect GitHub"}
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <div class="field">
              <label for="add-client-repo">Repository</label>
              <select
                id="add-client-repo"
                value={selectedRepoFullName}
                onChange={(e) => setSelectedRepoFullName((e.target as HTMLSelectElement).value)}
                required
              >
                <option value="">{repos ? "Select a repository…" : "Loading repositories…"}</option>
                {repos?.map((r) => (
                  <option key={r.id} value={r.fullName}>
                    {r.fullName}
                    {r.private ? " (private)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div class="field">
              <label for="add-client-domain">Primary domain</label>
              <input
                id="add-client-domain"
                type="text"
                placeholder="tenant.example.com"
                value={domain}
                onInput={(e) => setDomain((e.target as HTMLInputElement).value)}
                required
              />
            </div>
            <div class="dialog-actions">
              <button class="btn btn-secondary" type="button" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button class="btn btn-primary" type="submit" disabled={busy || !repos}>
                {busy ? "Creating…" : "Create client"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
