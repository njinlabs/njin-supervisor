import { useEffect, useState } from "preact/hooks";
import { addDomain, UnauthorizedError } from "../api";

export type AddDomainDialogProps = {
  slug: string | null;
  onAdded: () => void;
  onCancel: () => void;
  onUnauthorized: () => void;
};

export const AddDomainDialog = ({ slug, onAdded, onCancel, onUnauthorized }: AddDomainDialogProps) => {
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHost("");
    setError(null);
  }, [slug]);

  if (!slug) return null;

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addDomain(slug, host.trim());
      onAdded();
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError("Failed to add domain — it may already be registered.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="dialog-backdrop" onClick={onCancel}>
      <div class="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Add domain to "{slug}"</h2>
        <form onSubmit={submit}>
          <div class="field">
            <label for="add-domain-host">Domain</label>
            <input
              id="add-domain-host"
              type="text"
              placeholder="alias.example.com"
              value={host}
              onInput={(e) => setHost((e.target as HTMLInputElement).value)}
              autoFocus
              required
            />
          </div>
          {error && <div class="alert" role="alert">{error}</div>}
          <div class="dialog-actions">
            <button class="btn btn-secondary" type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button class="btn btn-primary" type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add domain"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
