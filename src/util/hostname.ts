// Standard hostname charset only (letters/digits/hyphen/dot) — shared by supervisor.ts's
// Host-header resolution and the dashboard's domain-creation endpoints, since both need the
// same "is this a plausible DNS hostname" check before it ever reaches a DB query or filesystem
// path segment.
export const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
