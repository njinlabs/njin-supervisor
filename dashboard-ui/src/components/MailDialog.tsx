import { useEffect, useState } from "preact/hooks";
import { enableMail, getMailStatus, refreshMail, UnauthorizedError, type MailStatus } from "../api";
import { parseDnsZoneFile } from "../lib/dnsZoneFile";

// Shortens a record name relative to the zone's own domain, the way most DNS panels display it
// (root -> "@", a subdomain -> just its label) instead of repeating the full FQDN in every row.
const relativeName = (name: string, domain: string): string => {
  if (name === domain) return "@";
  if (name.endsWith(`.${domain}`)) return name.slice(0, -(domain.length + 1));
  return name;
};

export type MailDialogProps = {
  slug: string | null;
  onClose: () => void;
  onUnauthorized: () => void;
};

export const MailDialog = ({ slug, onClose, onUnauthorized }: MailDialogProps) => {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (currentSlug: string) =>
    getMailStatus(currentSlug)
      .then(setStatus)
      .catch((err) => {
        if (err instanceof UnauthorizedError) onUnauthorized();
        else setError("Failed to load mail status.");
      });

  useEffect(() => {
    if (!slug) return;
    setStatus(null);
    setError(null);
    load(slug);
    // eslint-disable-next-line
  }, [slug]);

  if (!slug) return null;

  const handleEnable = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await enableMail(slug);
      setStatus((prev) => ({
        configured: true,
        enabled: true,
        domain: result.domain,
        dnsZoneFile: result.dnsZoneFile,
        mailHostname: result.mailHostname ?? prev?.mailHostname ?? null,
      }));
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(err instanceof Error ? err.message : "Failed to enable email.");
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await refreshMail(slug);
      setStatus((prev) => ({
        configured: true,
        enabled: true,
        domain: result.domain,
        dnsZoneFile: result.dnsZoneFile,
        mailHostname: result.mailHostname ?? prev?.mailHostname ?? null,
      }));
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(err instanceof Error ? err.message : "Failed to refresh DNS records.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="dialog-backdrop" onClick={onClose}>
      <div class="dialog dialog-wide" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Email for "{slug}"</h2>

        {error && <div class="alert" role="alert">{error}</div>}

        {!status && !error && <p class="loading-state">Loading…</p>}

        {status && !status.configured && (
          <p class="empty-state">Mail hosting is not configured on this supervisor (STALWART_* env vars are unset).</p>
        )}

        {status && status.configured && !status.enabled && (
          <p>
            Email is not enabled for this client yet. Enabling registers its primary domain with the shared Stalwart
            mail server and injects <code>STALWART_URL</code>/<code>STALWART_API_KEY</code>/<code>STALWART_DOMAIN</code>
            into its env so the tenant's own admin panel can create mailboxes.
          </p>
        )}

        {status && status.enabled && status.domain && status.dnsZoneFile && (
          <>
            <p>
              Email enabled for <code>{status.domain}</code>
              {status.mailHostname && (
                <>
                  {" "}— MX target: <code>{status.mailHostname}</code>
                </>
              )}
            </p>
            <p>Add these DNS records at the domain's registrar/DNS provider:</p>
            {!status.dnsZoneFile.includes("_domainkey.") && (
              <p class="alert alert-notice" role="status">
                DKIM keys are still being generated — click "Refresh DNS records" in a few seconds to pick them up.
              </p>
            )}
            <div class="dns-table-wrap">
              <table class="dns-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {parseDnsZoneFile(status.dnsZoneFile).map((record, i) => (
                    <tr key={i}>
                      <td class="dns-cell-name">{relativeName(record.name, status.domain!)}</td>
                      <td>
                        <span class="badge">{record.type}</span>
                      </td>
                      <td class="dns-cell-value">{record.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div class="dialog-actions">
          {status && status.configured && !status.enabled && (
            <button class="btn btn-secondary" type="button" onClick={handleEnable} disabled={busy}>
              {busy ? "Enabling…" : "Enable email"}
            </button>
          )}
          {status && status.enabled && (
            <button class="btn btn-secondary" type="button" onClick={handleRefresh} disabled={busy}>
              {busy ? "Refreshing…" : "Refresh DNS records"}
            </button>
          )}
          <button class="btn btn-primary" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
