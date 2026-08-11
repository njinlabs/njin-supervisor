import { useEffect, useState } from "preact/hooks";
import { deleteEnv, listEnv, setEnv, UnauthorizedError, type EnvVar } from "../api";

export type EnvDialogProps = {
  slug: string | null;
  onClose: () => void;
  onUnauthorized: () => void;
};

export const EnvDialog = ({ slug, onClose, onUnauthorized }: EnvDialogProps) => {
  const [vars, setVars] = useState<EnvVar[] | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (currentSlug: string) =>
    listEnv(currentSlug)
      .then(setVars)
      .catch((err) => {
        if (err instanceof UnauthorizedError) onUnauthorized();
        else setError("Failed to load env vars.");
      });

  useEffect(() => {
    if (!slug) return;
    setVars(null);
    setRevealed(new Set());
    setKey("");
    setValue("");
    setError(null);
    load(slug);
    // eslint-disable-next-line
  }, [slug]);

  if (!slug) return null;

  const toggleReveal = (k: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setEnv(slug, key.trim(), value);
      setKey("");
      setValue("");
      await load(slug);
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError("Failed to save — key must look like DB_PATH / S3_BUCKET (uppercase, digits, underscores).");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (k: string) => {
    setDeletingKey(k);
    setError(null);
    try {
      await deleteEnv(slug, k);
      await load(slug);
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(`Failed to delete "${k}".`);
    } finally {
      setDeletingKey(null);
    }
  };

  return (
    <div class="dialog-backdrop" onClick={onClose}>
      <div class="dialog dialog-wide" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Env vars for "{slug}"</h2>
        <p class="dialog-message">
          Changes apply on this client's next request — its currently running worker (if any) is
          restarted to pick them up.
        </p>

        {error && <div class="alert" role="alert">{error}</div>}

        {!vars && !error && <p class="loading-state">Loading…</p>}

        {vars && vars.length === 0 && <p class="empty-state">No env vars set yet.</p>}

        {vars && vars.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {vars.map((v) => (
                <tr key={v.key}>
                  <td class="slug">{v.key}</td>
                  <td class="env-value">
                    {revealed.has(v.key) ? v.value : "•".repeat(Math.min(v.value.length, 20)) || "(empty)"}
                  </td>
                  <td>
                    <div class="row-actions">
                      <button class="btn btn-secondary" type="button" onClick={() => toggleReveal(v.key)}>
                        {revealed.has(v.key) ? "Hide" : "Show"}
                      </button>
                      <button
                        class="btn btn-danger"
                        type="button"
                        onClick={() => handleDelete(v.key)}
                        disabled={deletingKey === v.key}
                      >
                        {deletingKey === v.key ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <form onSubmit={submit} class="env-form">
          <div class="field">
            <label for="env-key">Key</label>
            <input
              id="env-key"
              type="text"
              placeholder="DB_PATH"
              value={key}
              onInput={(e) => setKey((e.target as HTMLInputElement).value.toUpperCase())}
              required
            />
          </div>
          <div class="field">
            <label for="env-value">Value</label>
            <input
              id="env-value"
              type="text"
              value={value}
              onInput={(e) => setValue((e.target as HTMLInputElement).value)}
              required
            />
          </div>
          <div class="env-form-actions">
            <button class="btn btn-secondary" type="button" onClick={onClose}>
              Close
            </button>
            <button class="btn btn-primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Set"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
