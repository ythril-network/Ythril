/**
 * One recorded field change of an audit entry (`AuditChange`), apart from the allowlist that cuts changes to it and the summaries that build them.
 *
 * ## What it prevents
 *
 * **Two audit modules forming a cycle of their own.** `audit/audit-changes.ts` reads the schema summaries (`AUDIT_SCHEMA_SUMMARY`) and
 * `audit/audit-schema-summary.ts` builds `AuditChange` rows, so while the shape lived in `audit-changes.ts` the two imported each other: a cyclic set
 * that `check-i-architecture-dependency-direction` counts against a ceiling that only goes down. This module imports nothing, so both name the
 * shape here; `audit-changes.ts` re-exports it for its own readers.
 */

/**
 * A single recorded field change.
 *
 * Two shapes, and a change is only ever one of them:
 *   - scalar: `from`/`to`, where absent means "was not set";
 *   - set: `added`/`removed`, for a list-valued field like `tags`.
 */
export interface AuditChange {
  field: string;
  from?: string | number | boolean | null;
  to?: string | number | boolean | null;
  /** Members present after but not before. Only for allowlisted list fields. */
  added?: (string | number | boolean)[];
  /** Members present before but not after. */
  removed?: (string | number | boolean)[];
}
