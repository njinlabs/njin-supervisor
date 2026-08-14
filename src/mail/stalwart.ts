import { env } from "../env";

export const isMailConfigured = (): boolean => Boolean(env.STALWART_URL);

// Stalwart's Management API is JMAP-based (POST /jmap, `using: ["urn:stalwart:jmap"]`,
// `methodCalls: [[method, args, callId]]`) rather than a REST/OpenAPI surface — see
// https://stalw.art/docs/api/management/overview/ and https://stalw.art/docs/ref/object/domain.
// This has been implemented against Stalwart's published docs but has NOT yet been exercised
// against a live instance — verify the first real x:Domain/set call against STALWART_URL (e.g.
// via the dashboard's "Enable Email" action on a throwaway domain) before relying on it for a
// real tenant, and adjust the shapes below if the live response disagrees with the docs.
type JmapMethodResponse = [string, Record<string, unknown>, string];

const callJmap = async (method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  if (!isMailConfigured()) throw new Error("Stalwart mail hosting is not configured");

  const res = await fetch(`${env.STALWART_URL}/jmap`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STALWART_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:stalwart:jmap"],
      methodCalls: [[method, args, "0"]],
    }),
  });
  if (!res.ok) throw new Error(`Stalwart API request failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as { methodResponses: JmapMethodResponse[] };
  const [responseMethod, responseArgs] = body.methodResponses[0] ?? [];
  if (responseMethod === "error") {
    throw new Error(`Stalwart API error calling ${method}: ${JSON.stringify(responseArgs)}`);
  }
  if (!responseArgs) throw new Error(`Stalwart API returned no response for ${method}`);
  return responseArgs;
};

export type CreatedMailDomain = { stalwartDomainId: string; dnsZoneFile: string };

// Registers a Domain object in Stalwart for a tenant's primary hostname. DNS and certificate
// management are both left Manual: DNS is Manual because the tenant domains in this project sit
// with registrars (e.g. DomainEsia) Stalwart's automatic DNS management doesn't integrate with,
// so dnsZoneFile is surfaced to the admin to copy in by hand instead; certificates stay Manual
// because Caddy already owns :443 on this box, so Stalwart's own ACME can't complete anyway (see
// CLAUDE.md's mail-hosting notes for the full port-443 conflict and the Caddy-copy workaround).
// DKIM is left Automatic with no algorithm restriction — Stalwart's default generates both an
// ed25519 and an RSA key (confirmed live against a local instance; a `algorithms` property on
// the Automatic variant, as an earlier version of this code tried, is rejected as an invalid
// patch). The RSA record's multi-string TXT value may need manual splitting on a DNS panel that
// doesn't support it (see jadiweb.id's real-world setup in CLAUDE.md's mail-hosting notes) — the
// admin can just omit that one TXT record and rely on the ed25519 record alone if so.
export const createDomain = async (domain: string): Promise<CreatedMailDomain> => {
  const response = await callJmap("x:Domain/set", {
    create: {
      new: {
        name: domain,
        certificateManagement: { "@type": "Manual" },
        dkimManagement: { "@type": "Automatic" },
        dnsManagement: { "@type": "Manual" },
        subAddressing: { "@type": "Enabled" },
      },
    },
  });

  const created = response.created as Record<string, { id: string; dnsZoneFile?: string }> | undefined;
  const result = created?.new;
  if (!result) throw new Error(`Stalwart did not confirm creation of domain ${domain}: ${JSON.stringify(response)}`);

  // dnsZoneFile is a server-set field — if the create response doesn't already include it,
  // fetch it explicitly by the id we just got back.
  const dnsZoneFile = result.dnsZoneFile ?? (await fetchDnsZoneFile(result.id));
  return { stalwartDomainId: result.id, dnsZoneFile };
};

const fetchDnsZoneFile = async (stalwartDomainId: string): Promise<string> => {
  const response = await callJmap("x:Domain/get", { ids: [stalwartDomainId], properties: ["dnsZoneFile"] });
  const list = response.list as { dnsZoneFile?: string }[] | undefined;
  const dnsZoneFile = list?.[0]?.dnsZoneFile;
  if (dnsZoneFile === undefined) throw new Error(`Stalwart returned no dnsZoneFile for domain id ${stalwartDomainId}`);
  return dnsZoneFile;
};

// Re-fetches the current DNS zone snapshot for an already-created domain (e.g. after DKIM key
// rotation) using the id stored from the original createDomain() call.
export const refreshDnsZoneFile = (stalwartDomainId: string): Promise<string> => fetchDnsZoneFile(stalwartDomainId);
