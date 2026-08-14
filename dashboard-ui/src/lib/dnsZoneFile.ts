export type DnsZoneRecord = { name: string; type: string; value: string };

// Stalwart's dnsZoneFile is plain BIND zone-file text (see src/mail/stalwart.ts) — a multi-string
// TXT value (the RSA DKIM key) is wrapped across several lines in parens, e.g.:
//   name. IN TXT (
//       "part1"
//       "part2"
//   )
// Collapsing everything inside a `(...)` span onto one line first means every record then becomes
// exactly one line, however many lines it started as.
export const parseDnsZoneFile = (zoneFile: string): DnsZoneRecord[] => {
  const collapsed = zoneFile.replace(/\(([^)]*)\)/gs, (_, inner) => inner.replace(/\s+/g, " ").trim());

  return collapsed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\S+?)\.?\s+IN\s+(\S+)\s+(.*)$/);
      if (!match) return { name: line, type: "", value: "" };
      const [, name, type, value] = match;
      return { name: name!, type: type!, value: value!.trim() };
    });
};
