/**
 * Save migrations, keyed by the schema version they upgrade *from* (see `save.ts`). Each takes
 * untrusted JSON and must tolerate missing or odd fields: anything it does not recognise is left
 * for the invariants to judge.
 */
import type { MigrationRegistry } from "./types/save";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 1 → 2 (D25): a job's `issuer` was a bare string (usually a company). It stays as the display
 * label; the person becomes that name with the role "shipper", the pitch a generic template
 * line, and the urgency "relaxed". The literals mirror `LEGACY_ISSUER_ROLE` and
 * `DEFAULT_PITCH_KEY` in `systems/commerce/jobs.ts` (core may not import systems); a migration
 * is frozen once shipped, so they must not follow later changes to those constants anyway.
 */
export function migrateJobsToPeople(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.jobs)) return raw;
  for (const job of Object.values(raw.jobs)) {
    if (!isRecord(job) || isRecord(job.issuerPerson)) continue;
    const name = typeof job.issuer === "string" ? job.issuer : "A dockside broker";
    job.issuer = name;
    job.issuerPerson = { name, role: "shipper" };
    if (!isRecord(job.pitch)) job.pitch = { key: "job.pitch.default", params: {} };
    if (typeof job.urgency !== "string") job.urgency = "relaxed";
  }
  return raw;
}

export const migrations: MigrationRegistry = {
  1: migrateJobsToPeople,
};
