import { useEffect, useState } from "preact/hooks";
import { deleteClient, getClients, logout, UnauthorizedError, type ClientListItem, type CreateClientResult } from "../api";
import { AddClientDialog } from "../components/AddClientDialog";
import { AddDomainDialog } from "../components/AddDomainDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DeployHistoryDialog } from "../components/DeployHistoryDialog";
import { EnvDialog } from "../components/EnvDialog";

export const Clients = ({ onUnauthorized }: { onUnauthorized: () => void }) => {
  const [clients, setClients] = useState<ClientListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ClientListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [addClientOpen, setAddClientOpen] = useState(false);
  const [pendingInstallationId, setPendingInstallationId] = useState<number | null>(null);
  const [addDomainSlug, setAddDomainSlug] = useState<string | null>(null);
  const [deploysSlug, setDeploysSlug] = useState<string | null>(null);
  const [envSlug, setEnvSlug] = useState<string | null>(null);

  const load = () =>
    getClients()
      .then(setClients)
      .catch((err) => {
        if (err instanceof UnauthorizedError) onUnauthorized();
        else setError("Failed to load clients.");
      });

  useEffect(() => {
    load();
  }, [onUnauthorized]);

  // The GitHub install flow is a full-page redirect away and back — any in-memory state is gone
  // when the browser returns, so the callback communicates via the URL instead.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const installationId = params.get("github_installation_id");
    const githubError = params.get("github_error");

    if (installationId) {
      setPendingInstallationId(Number(installationId));
      setAddClientOpen(true);
    } else if (githubError) {
      setError(`GitHub connection failed (${githubError}).`);
    }

    if (installationId || githubError) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const handleLogout = async () => {
    await logout();
    onUnauthorized();
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const slug = pendingDelete.slug;

    setDeleting(true);
    setError(null);
    try {
      await deleteClient(slug);
      setPendingDelete(null);
      await load();
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(`Failed to delete "${slug}".`);
    } finally {
      setDeleting(false);
    }
  };

  const handleClientCreated = async (result: CreateClientResult) => {
    setAddClientOpen(false);
    setPendingInstallationId(null);
    setError(null);
    setNotice(
      result.workflowInjected
        ? `Client "${result.slug}" created — deploy workflow added to the repo.`
        : `Client "${result.slug}" created, but the deploy workflow couldn't be added automatically` +
            (result.workflowError ? ` (${result.workflowError})` : "") +
            " — check the GitHub App's permissions, or add it manually.",
    );
    await load();
  };

  return (
    <div class="page">
      <div class="page-header">
        <div>
          <h1>Clients</h1>
          <p class="subtitle">{clients ? `${clients.length} registered` : "Loading…"}</p>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-primary" type="button" onClick={() => setAddClientOpen(true)}>
            Add Client
          </button>
          <button class="btn btn-secondary" type="button" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </div>

      {notice && <div class="alert alert-notice" role="status">{notice}</div>}
      {error && <div class="alert" role="alert">{error}</div>}

      {!clients && !error && (
        <div class="card">
          <p class="loading-state">Loading clients…</p>
        </div>
      )}

      {clients && clients.length === 0 && (
        <div class="card">
          <p class="empty-state">No clients registered yet.</p>
        </div>
      )}

      {clients && clients.length > 0 && (
        <div class="card">
          <table>
            <thead>
              <tr>
                <th>Slug</th>
                <th>Status</th>
                <th>Source</th>
                <th>Domains</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.slug}>
                  <td class="slug">{client.slug}</td>
                  <td>
                    {client.buildPresent ? (
                      <span class="badge">{client.status}</span>
                    ) : (
                      <span class="badge badge-danger" title="clients/<slug>/ no longer exists on disk">
                        missing build
                      </span>
                    )}
                  </td>
                  <td>{client.source}</td>
                  <td>
                    <div class="domain-list">
                      {client.domains.map((d) => (
                        <span key={d.host} class={`domain-pill${d.isPrimary ? " primary" : ""}`}>
                          {d.host}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div class="row-actions">
                      {client.source === "github" && (
                        <button class="btn btn-secondary" type="button" onClick={() => setDeploysSlug(client.slug)}>
                          Deploys
                        </button>
                      )}
                      <button class="btn btn-secondary" type="button" onClick={() => setEnvSlug(client.slug)}>
                        Env
                      </button>
                      <button class="btn btn-secondary" type="button" onClick={() => setAddDomainSlug(client.slug)}>
                        Add domain
                      </button>
                      <button class="btn btn-danger" type="button" onClick={() => setPendingDelete(client)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete "${pendingDelete?.slug}"?`}
        message="This terminates its worker if running, removes its registration (domains, env vars), and deletes its build from disk. This cannot be undone."
        confirmLabel="Delete"
        danger
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      <AddClientDialog
        open={addClientOpen}
        initialInstallationId={pendingInstallationId}
        onCreated={handleClientCreated}
        onCancel={() => {
          setAddClientOpen(false);
          setPendingInstallationId(null);
        }}
        onUnauthorized={onUnauthorized}
      />

      <AddDomainDialog
        slug={addDomainSlug}
        onAdded={async () => {
          setAddDomainSlug(null);
          await load();
        }}
        onCancel={() => setAddDomainSlug(null)}
        onUnauthorized={onUnauthorized}
      />

      <DeployHistoryDialog
        slug={deploysSlug}
        onClose={() => setDeploysSlug(null)}
        onUnauthorized={onUnauthorized}
      />

      <EnvDialog slug={envSlug} onClose={() => setEnvSlug(null)} onUnauthorized={onUnauthorized} />
    </div>
  );
};
