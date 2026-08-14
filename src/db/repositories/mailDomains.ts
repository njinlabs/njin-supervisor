import { db } from "../client";

export type MailDomain = {
  id: number;
  client_id: number;
  domain: string;
  stalwart_domain_id: string;
  dns_zone_file: string;
  created_at: string;
  updated_at: string;
};

export const findMailDomainForClient = (clientId: number): MailDomain | null =>
  db.query("SELECT * FROM mail_domains WHERE client_id = ?").get(clientId) as MailDomain | null;

export const upsertMailDomain = (
  clientId: number,
  domain: string,
  stalwartDomainId: string,
  dnsZoneFile: string,
): void => {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO mail_domains (client_id, domain, stalwart_domain_id, dns_zone_file, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET
       stalwart_domain_id = excluded.stalwart_domain_id,
       dns_zone_file = excluded.dns_zone_file,
       updated_at = excluded.updated_at`,
  ).run(clientId, domain, stalwartDomainId, dnsZoneFile, now, now);
};
