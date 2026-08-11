import { useEffect, useState } from "preact/hooks";
import { listDeploys, reinjectWorkflow, UnauthorizedError, type DeployListItem } from "../api";

export type DeployHistoryDialogProps = {
  slug: string | null;
  onClose: () => void;
  onUnauthorized: () => void;
};

export const DeployHistoryDialog = ({ slug, onClose, onUnauthorized }: DeployHistoryDialogProps) => {
  const [deploys, setDeploys] = useState<DeployListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reinjecting, setReinjecting] = useState(false);

  const load = (currentSlug: string) =>
    listDeploys(currentSlug)
      .then(setDeploys)
      .catch((err) => {
        if (err instanceof UnauthorizedError) onUnauthorized();
        else setError("Failed to load deploy history.");
      });

  useEffect(() => {
    if (!slug) return;
    setDeploys(null);
    setError(null);
    setNotice(null);
    load(slug);
    // eslint-disable-next-line
  }, [slug]);

  if (!slug) return null;

  const handleReinject = async () => {
    setReinjecting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await reinjectWorkflow(slug);
      setNotice(
        result.workflowInjected
          ? "Workflow re-injected — a fresh deploy token was set on the repo."
          : `Re-inject failed${result.workflowError ? `: ${result.workflowError}` : ""}.`,
      );
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError("Failed to re-inject workflow.");
    } finally {
      setReinjecting(false);
    }
  };

  return (
    <div class="dialog-backdrop" onClick={onClose}>
      <div class="dialog dialog-wide" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Deploys for "{slug}"</h2>

        {notice && <div class="alert alert-notice" role="status">{notice}</div>}
        {error && <div class="alert" role="alert">{error}</div>}

        {!deploys && !error && <p class="loading-state">Loading…</p>}

        {deploys && deploys.length === 0 && <p class="empty-state">No deploys yet.</p>}

        {deploys && deploys.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Commit</th>
                <th>Triggered by</th>
                <th>Started</th>
                <th>Finished</th>
              </tr>
            </thead>
            <tbody>
              {deploys.map((d, i) => (
                <tr key={i}>
                  <td>
                    <span class={`badge${d.status === "failed" ? " badge-danger" : ""}`}>{d.status}</span>
                    {d.errorMessage && <div class="deploy-error" title={d.errorMessage}>{d.errorMessage}</div>}
                  </td>
                  <td>{d.commitSha ? d.commitSha.slice(0, 7) : "—"}</td>
                  <td>{d.triggeredBy}</td>
                  <td>{new Date(d.startedAt).toLocaleString()}</td>
                  <td>{d.finishedAt ? new Date(d.finishedAt).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div class="dialog-actions">
          <button class="btn btn-secondary" type="button" onClick={handleReinject} disabled={reinjecting}>
            {reinjecting ? "Re-injecting…" : "Re-inject workflow"}
          </button>
          <button class="btn btn-primary" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
