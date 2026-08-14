import { useEffect, useState } from "preact/hooks";
import {
  deleteClient,
  deleteDomain,
  getClients,
  logout,
  setPrimaryDomain,
  UnauthorizedError,
  type ClientListItem,
  type CreateClientResult,
} from "../api";
import { ActionsMenu } from "../components/ActionsMenu";
import { AddClientDialog } from "../components/AddClientDialog";
import { AddDomainDialog } from "../components/AddDomainDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DeployHistoryDialog } from "../components/DeployHistoryDialog";
import { EnvDialog } from "../components/EnvDialog";
import { MailDialog } from "../components/MailDialog";

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
  const [mailSlug, setMailSlug] = useState<string | null>(null);
  // "<slug>:<host>" of the domain action currently in flight, so only that pill shows busy state
  // and a double-click can't fire a second request.
  const [busyDomain, setBusyDomain] = useState<string | null>(null);

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

  const handleSetPrimaryDomain = async (slug: string, host: string) => {
    const key = `${slug}:${host}`;
    setBusyDomain(key);
    setError(null);
    try {
      await setPrimaryDomain(slug, host);
      await load();
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(`Failed to set "${host}" as primary.`);
    } finally {
      setBusyDomain(null);
    }
  };

  const handleDeleteDomain = async (slug: string, host: string) => {
    const key = `${slug}:${host}`;
    setBusyDomain(key);
    setError(null);
    try {
      await deleteDomain(slug, host);
      await load();
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(`Failed to delete domain "${host}".`);
    } finally {
      setBusyDomain(null);
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
                      {client.domains.map((d) => {
                        const key = `${client.slug}:${d.host}`;
                        const busy = busyDomain === key;
                        // Deleting the primary (or a client's only domain, which is necessarily
                        // primary) would leave the client unreachable — the server rejects it
                        // (409), so the delete action is disabled here rather than round-tripping
                        // to show that error.
                        const canDelete = !d.isPrimary;
                        return (
                          <span key={d.host} class={`domain-pill${d.isPrimary ? " primary" : ""}`}>
                            {d.host}
                            {!d.isPrimary && (
                              <button
                                type="button"
                                class="domain-pill-action"
                                title="Make primary"
                                disabled={busy}
                                onClick={() => handleSetPrimaryDomain(client.slug, d.host)}
                              >
                                ★
                              </button>
                            )}
                            <button
                              type="button"
                              class="domain-pill-action"
                              title={canDelete ? "Delete domain" : "Cannot delete the primary domain"}
                              disabled={busy || !canDelete}
                              onClick={() => handleDeleteDomain(client.slug, d.host)}
                            >
                              ×
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td>
                    <div class="row-actions">
                      <ActionsMenu
                        items={[
                          ...(client.source === "github"
                            ? [{ label: "Deploys", onClick: () => setDeploysSlug(client.slug) }]
                            : []),
                          { label: "Env", onClick: () => setEnvSlug(client.slug) },
                          { label: "Email", onClick: () => setMailSlug(client.slug) },
                          { label: "Add domain", onClick: () => setAddDomainSlug(client.slug) },
                          { label: "Delete", onClick: () => setPendingDelete(client), danger: true },
                        ]}
                      />
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

      <EnvDialog
        slug={envSlug}
        otherSlugs={(clients ?? []).map((c) => c.slug).filter((s) => s !== envSlug)}
        onClose={() => setEnvSlug(null)}
        onUnauthorized={onUnauthorized}
      />

      <MailDialog slug={mailSlug} onClose={() => setMailSlug(null)} onUnauthorized={onUnauthorized} />
    </div>
  );
};
