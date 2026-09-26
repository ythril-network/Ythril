/**
 * What an audit entry may record about the change itself.
 *
 * Audit entries answered who / when / which route / what status — never *what changed*. "Admin patched the
 * space at 14:02" does not tell you whether they renamed it or turned strict linkage off, which is exactly
 * the question an audit log exists to answer.
 *
 * ── Why this is an ALLOWLIST, and never a redaction denylist ─────────────────────────────────────────────
 *
 * Several audited routes handle secrets directly: token create/regenerate/update, webhook create/update
 * (target URLs and signing secrets), and the media-config routes (vision / STT / NLI / assist API keys).
 * Audit entries are queryable by any admin and retained for `audit.retentionDays`.
 *
 * Diffing a whole request body and stripping known-secret names inverts the failure in the worst possible
 * direction: forget one field and a live API key is written into a retained, queryable store, where it will
 * sit until retention expires and nothing will report it. Naming the fields that MAY be recorded fails the
 * other way — forget one and the entry simply lacks it, which is visible, harmless and fixable.
 *
 * So: an operation with no entry here records **nothing**. A route added later is silent by default rather
 * than leaky by default, which is the only safe direction for a default to point.
 *
 * ── Scalars only ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Recorded values must be scalar or absent. Allowing an object would mean a single allowlisted parent name
 * silently shipping every child it happens to gain later — the same forget-one-field failure, reintroduced
 * through nesting.
 */

import { AUDIT_SCHEMA_SUMMARY } from './audit-schema-summary.js';

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

/**
 * Fields each operation may record, by `operation` name from `audit/middleware.ts`.
 *
 * **Add a field only after checking it cannot carry a credential**, including indirectly — a webhook URL
 * can embed one in userinfo or a query string, which is why webhook routes are absent rather than
 * partially listed. Deliberately omitted for now: everything token.*, webhook.*, and any model/provider
 * config that sits next to an API key.
 */
export const AUDIT_CHANGE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // Space settings a reader would actually want explained after the fact.
  'space.update': ['label', 'purpose', 'validationMode', 'strictLinkage', 'dupeRulesOnInsert', 'dupeMergeSurvivor'],
  'space.rename': ['id'],
  // Token metadata ONLY, and only what this route can actually change: `PATCH /api/tokens/:id` renames.
  // Never `hash` or `prefix`; `token.create` and `token.regenerate` are absent entirely, because the
  // interesting value there IS the secret.
  // `rights` joined `name` when PATCH gained the ability to edit the matrix. Without it a rights change —
  // the single most security-relevant edit this route can make — would be applied and leave no trace in the
  // audit log, while a rename beside it did.
  'token.update': ['name', 'rights'],
  // Media levels and extraction mode: the settings that decide what gets processed and what leaves the
  // instance. The provider blocks in the same payload carry API keys and are NOT listed.
  'config.media.update': ['levels.images', 'levels.audio', 'levels.video', 'levels.text', 'documentProcessing.mode'],
  // Network settings a `PATCH /api/networks/:id` can actually change — and only those three. The network
  // record also holds `inviteKeyHash` and each member's `tokenHash`; naming fields rather than diffing the
  // record is what keeps them out. `requireSignedVotes` is the reason this entry is worth having: turning
  // it off silently weakens vote verification for the whole network, and "an admin patched the network"
  // does not tell you that happened.
  'network.update': ['label', 'syncSchedule', 'requireSignedVotes'],
  // The space list before and after `POST /api/networks/:id/spaces` — ids only; the act hands over nothing wider.
  'network.space.add': ['spaces'],
  // Accepting or dismissing a space an upstream announced (S-9): what the network carries, and what still waits.
  'network.space.pending': ['spaces', 'pendingSpaces'],
  // Backup schedule and retention. `offsite.destPath` is a container filesystem path (mounted volume),
  // not a URL, so it cannot carry credentials in userinfo the way a webhook target can.
  'data.backup_config.update': ['schedule', 'retention.keepLocal', 'offsite.destPath', 'offsite.retention.keepCount'],
  // ── Brain record edits ─────────────────────────────────────────────────────────────────────────
  //
  // These carry USER CONTENT — a fact's old text, an entity's old description — which is why they
  // were an owner decision rather than another slice, and why their `changes` expire on a much shorter
  // clock than the entry (see `change-retention.ts`, default 14 days).
  //
  // `properties` is deliberately absent from every one of them. It is a free-form bag whose keys the
  // user chooses, so it is the one field on a record that could hold a pasted credential, and the
  // allowlist cannot vet names it has never seen. Same reasoning that keeps webhook routes out.
  //
  // The `link*` names are the one group here that is NOT a field on the stored record. 5.0 moved a
  // record's connections into link records, so the route folds the before/after link sets into its
  // snapshots — see `linkAuditSnapshots`. Named as the caller writes them, because that is what an
  // operator reading the entry would go and change.
  'fact.update': ['fact', 'description', 'type', 'tags', 'linkEntities'],
  'entity.update': ['name', 'type', 'description', 'tags'],
  'edge.update': ['label', 'from', 'to', 'weight', 'type'],
  'chrono.update': ['title', 'description', 'type', 'status', 'startsAt', 'endsAt', 'tags', 'linkEntities', 'linkFacts'],
  // A file links to all THREE other kinds, and losing track of what a file was linked to is exactly
  // the kind of change nobody notices until a traversal comes back empty.
  'file.meta.update': ['description', 'tags', 'linkEntities', 'linkFacts', 'linkChronos'],
  // A merge is a deletion wearing an edit's clothes: the absorbed entity ceases to exist. The entry
  // already carries the survivor's id and the path carries the absorbed one, so the only fact that
  // becomes UNRECOVERABLE is the absorbed entity's name — an id alone means nothing once the record it
  // pointed at is gone. Recorded as name → null, which reads as "this entity no longer exists".
  'entity.merge': ['absorbedName'],
  // A library entry is `$ref`-ed by any number of spaces, so what it declares is what all of them
  // validate against. Scalars only here — the `schema` object itself is summarised as property-key
  // NAMES by `audit-schema-summary.ts`, because a property's schema can carry example values.
  'schema_library.update': ['knowledgeType', 'typeName', 'published', 'schemaGroup'],
  // Maintenance mode blocks writes instance-wide. One boolean, and the direction is the whole story:
  // an entry saying only "an admin hit the maintenance route" cannot distinguish starting an outage
  // from ending one.
  'data.maintenance.toggle': ['active'],
};

/** Scalars only — anything else is dropped rather than stringified. */
function scalarOrDrop(v: unknown): string | number | boolean | null | undefined {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v as string | number | boolean;
  return undefined;   // objects, arrays, functions, undefined — never recorded
}

/**
 * Fields whose value is a LIST, recorded as added/removed rather than dropped.
 *
 * `scalarOrDrop` discards arrays, which is right for the general case — allowing an object or array
 * through would let one allowlisted parent name silently ship every child it gains later. But it means
 * `tags` and the link sets record NOTHING, and that failure is invisible: the entry appears, the field
 * is simply missing from `changes`, and an audit reader concludes the tags were untouched.
 *
 * So list handling is opt-in per field and deliberately narrow:
 *   - the field must be named here AND in the operation's allowlist;
 *   - every member must be a primitive. One object in the array and the whole field is dropped, which
 *     is the same fail-closed direction as everywhere else in this module.
 *
 * Recording added/removed rather than the whole before/after list keeps the entry proportional to the
 * change. Re-tagging one fact should not copy forty tags into the audit log twice.
 */
const LIST_FIELDS: ReadonlySet<string> = new Set(['tags', 'linkEntities', 'linkFacts', 'linkChronos']);

/** An array of primitives, or undefined if it is not one. Nested values disqualify the whole field. */
function primitiveListOrDrop(v: unknown): (string | number | boolean)[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: (string | number | boolean)[] = [];
  for (const item of v) {
    const t = typeof item;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') return undefined;
    out.push(item as string | number | boolean);
  }
  return out;
}

/** Set difference for a list field, or null when either side is not a primitive list. */
function listDelta(beforeV: unknown, afterV: unknown): { added: (string | number | boolean)[]; removed: (string | number | boolean)[] } | null {
  // An absent side is an empty list, so adding tags to a record that had none still records them.
  const b = beforeV === undefined ? [] : primitiveListOrDrop(beforeV);
  const a = afterV === undefined ? [] : primitiveListOrDrop(afterV);
  if (b === undefined || a === undefined) return null;

  const bSet = new Set(b);
  const aSet = new Set(a);
  return {
    added: a.filter(x => !bSet.has(x)),
    removed: b.filter(x => !aSet.has(x)),
  };
}

/** Read a dotted path (`levels.images`) without touching anything else on the object. */
function at(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
    obj,
  );
}

/**
 * The changes an operation is permitted to record, comparing two snapshots.
 *
 * Reads ONLY the allowlisted paths — an unlisted field is never accessed, so it cannot be logged by
 * accident even if it sits alongside one that is listed. Returns [] for an unknown operation.
 */
export function auditChanges(operation: string, before: unknown, after: unknown): AuditChange[] {
  if (before == null || after == null) return [];

  // Nested-object changes — a space's typeSchemas, a library entry's schema — that the scalars-only rule
  // above drops entirely, and that no amount of adding names to the allowlist could ever record. They
  // are summarised as NAME sets (which types, which property keys) and never values. See
  // `audit-schema-summary.ts` for why names are the line and values are not.
  const summary = AUDIT_SCHEMA_SUMMARY[operation]?.(before, after) ?? [];

  const fields = AUDIT_CHANGE_FIELDS[operation];
  if (!fields) return summary;

  const out: AuditChange[] = [...summary];
  for (const field of fields) {
    // List fields first: they would otherwise be dropped by scalarOrDrop and record nothing at all.
    if (LIST_FIELDS.has(field.split('.').pop() ?? field)) {
      const delta = listDelta(at(before, field), at(after, field));
      if (delta && (delta.added.length || delta.removed.length)) {
        out.push({
          field,
          ...(delta.added.length ? { added: delta.added } : {}),
          ...(delta.removed.length ? { removed: delta.removed } : {}),
        });
      }
      continue;
    }

    const from = scalarOrDrop(at(before, field));
    const to = scalarOrDrop(at(after, field));
    if (from === undefined && to === undefined) continue;   // absent on both sides — nothing happened
    if (from === to) continue;                              // unchanged
    out.push({
      field,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
  }
  return out;
}
