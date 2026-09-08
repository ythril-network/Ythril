/**
 * What each SETTING on a space requires — because one route carries twenty-two unrelated ones.
 *
 * ## Why this is not a `ROUTE_RIGHTS` row
 *
 * `ROUTE_RIGHTS` says "this route is a view of THIS area's data at THIS rung". `PATCH /api/spaces/:id` is
 * not a view of one area: it carries the space's name, its share of the host's disk, its media-analysis
 * levels, its duplicate rules, its record lifetime and its whole type map. It has a `NOT_AREA_SCOPED` row
 * saying exactly that, and this table is the answer to the question that row cannot answer.
 *
 * ## What was wrong before it existed
 *
 * Every field demanded Space-admin — `admin` on all four areas at once. On the busiest space-configuration
 * door in the API, the four areas therefore bought nothing at all: a `files` administrator could not set a
 * media level, a `dataQuality` writer could not tune a duplicate rule, and either had to be handed the
 * entire space instead. Owner, 2026-09-08: *"if it makes sense decompose the PATCH and give it to the
 * correct areas/rungs"*.
 *
 * ## Why a table, when the rule it replaced was refused
 *
 * A generalised rule was proposed first — *"a multi-field route's row names the highest rung any field in
 * its body can demand"* — and the owner refused it as *"complicated and prone to errors"*. It was: it
 * over-required by construction, and it failed OPEN on the widest body in the API.
 *
 * This is the opposite shape, and it is safe for one reason that must not be removed:
 * `a-settings-field-answers-to-the-area-that-owns-it.test.js` asserts this table is **TOTAL** over
 * `UpdateSpaceBody` and `SpaceMetaBody`, derived from those schemas rather than from a list. **A field with
 * no row here is a field nobody governs**, because the route's guard admits anyone who can reach the space
 * — so the build fails instead. The body being `.strict()` is the second half: a field nobody declared is
 * already a 400 and cannot arrive at all.
 *
 * ## Reading a row
 *
 * `'instanceAdmin'` and `'spaceAdmin'` are not areas — they are the two requirements that sit outside the
 * four-area grid, and they are spelled out rather than approximated by "admin on everything".
 *
 * **Most rows LOOSEN**, because everything needed the whole space before. Each one hands a field to the
 * area the design already says owns it. `maxGiB` is the single row that TIGHTENS: a space's quota is its
 * share of the HOST's disk, so a space administrator raising their own was self-granting.
 *
 * `meta.purpose` and `meta.usageNotes` stay at Space-admin deliberately. They are the space's description
 * of itself, shown to clients; there is no data area they belong to, and inventing one to avoid an
 * exception would be worse than the exception.
 */
import type { SpaceArea, Rung } from './space-rights.js';
import { RUNGS } from './space-rights.js';
import type { TokenRights } from '../config/rights-shape.js';
import { effectiveRung } from './mint-cap.js';
import { isSpaceAdminFor } from './editor-scope.js';

/** Rungs contain the ones below them, so "at least" is an index comparison and never a set of cases. */
const meetsRung = (held: Rung, need: Rung): boolean => RUNGS.indexOf(held) >= RUNGS.indexOf(need);

/** What one field demands: an area rung, or one of the two requirements outside the grid. */
export type FieldRight =
  | { area: SpaceArea; needs: Exclude<Rung, 'none'> }
  | 'instanceAdmin'
  | 'spaceAdmin';

const area = (a: SpaceArea, needs: Exclude<Rung, 'none'>): FieldRight => ({ area: a, needs });

/**
 * Keyed as the field arrives: top-level names bare, `meta` children prefixed `meta.`.
 *
 * `meta` itself has no row. It is a container, and a container's requirement would be a fifth way of
 * saying the highest rung of its children — which is the rule that was refused.
 */
export const SPACE_FIELD_RIGHTS: Readonly<Record<string, FieldRight>> = {
  // The space's identity, like `/rename` beside it. No data area owns a name.
  label: 'spaceAdmin',

  // The one row that TIGHTENS. A quota is the INSTANCE's resource to give.
  maxGiB: 'instanceAdmin',

  // Changing the width invalidates every stored face descriptor, and the descriptors are files.
  faceDescriptorDims: area('files', 'admin'),

  // Changing the shape records must take. `replace` deletes types, but it deletes them from a payload the
  // caller wrote — the destructive act is authoring the map, which is the same `write` either way.
  typeSchemasMode: area('schema', 'write'),
  'meta.typeSchemas': area('schema', 'write'),
  'meta.whenDuePasses': area('schema', 'write'),

  // ENFORCEMENT rather than shape: flipping either makes writes that used to succeed start failing, for
  // every caller in the space, without anything having changed about their data.
  'meta.validationMode': area('schema', 'admin'),
  'meta.strictLinkage': area('schema', 'admin'),

  // Stops embedding space-wide, so recall silently stops finding anything written afterwards.
  'meta.suppressEmbeddings': area('knowledge', 'admin'),

  // It DELETES records on a clock.
  recordTtlDays: area('knowledge', 'admin'),

  // Flipping it makes the six legacy array fields start REFUSING writes for every caller in the space.
  completeLinkage: area('knowledge', 'admin'),

  // Tuning how duplicates are judged.
  dupeRules: area('dataQuality', 'write'),
  dupeMergeSurvivor: area('dataQuality', 'write'),
  // Admin, not write: it makes merges happen ON WRITE, so records are combined without anyone looking.
  dupeRulesOnInsert: area('dataQuality', 'admin'),
  // Admin, not write: it makes merges happen ON WRITE, so records are combined without anyone looking.

  // How uploaded files are processed.
  documentExtraction: area('files', 'write'),
  imageAnalysis: area('files', 'write'),
  audioAnalysis: area('files', 'write'),
  videoAnalysis: area('files', 'write'),
  textAnalysis: area('files', 'write'),

  // Prose about the space, shown to clients. Not the shape of anything, so no data area owns it.
  'meta.purpose': 'spaceAdmin',
  'meta.usageNotes': 'spaceAdmin',
};

/** The keys of a parsed update body, `meta.` prefixed, in the order they arrived. */
export function settingsFieldsIn(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (k === 'meta') {
      for (const [mk, mv] of Object.entries((v ?? {}) as Record<string, unknown>)) {
        if (mv !== undefined) out.push(`meta.${mk}`);
      }
      continue;
    }
    out.push(k);
  }
  return out;
}

/**
 * Which fields in this body the caller may NOT set, in the order they arrived.
 *
 * Empty means the whole update is allowed. The route refuses the REQUEST rather than dropping the fields:
 * a partial apply on a settings save is the failure mode where an operator sees "Saved" and half of what
 * they typed is gone.
 *
 * The message names every refused field and what each needs, so an operator can ask for the right grant
 * once instead of discovering them one save at a time.
 */
export function refusalsForSpaceUpdate(
  body: Record<string, unknown>,
  spaceId: string,
  instanceAdmin: boolean,
  rights: TokenRights | null | undefined,
): string[] {
  // An instance administrator passes everything. Saying it once here keeps every row below about the
  // per-space question, which is the only question the rows differ on.
  if (instanceAdmin) return [];

  const spaceAdmin = isSpaceAdminFor(rights, spaceId);
  const refused: string[] = [];

  for (const field of settingsFieldsIn(body)) {
    const need = SPACE_FIELD_RIGHTS[field];
    /*
     * An unknown field is REFUSED, not allowed.
     *
     * The gate asserts this table is total, so this branch should be unreachable — but "should be
     * unreachable" and "fails closed" are different claims, and only one of them survives somebody
     * deleting the gate. The route's guard admits anyone who can reach the space, so allowing here would
     * make a new field settable by everybody.
     */
    if (!need) { refused.push(field); continue; }
    if (need === 'instanceAdmin') { refused.push(field); continue; }   // instanceAdmin returned above
    if (need === 'spaceAdmin') { if (!spaceAdmin) refused.push(field); continue; }
    if (!rights || !meetsRung(effectiveRung(rights, spaceId, need.area), need.needs)) refused.push(field);
  }
  return refused;
}

/** How a refusal reads to the operator who has to go and ask for the grant. */
export function describeFieldRequirement(field: string): string {
  const need = SPACE_FIELD_RIGHTS[field];
  if (!need) return `${field} (no requirement is declared for this field, so it is refused)`;
  if (need === 'instanceAdmin') return `${field} (instance administrator)`;
  if (need === 'spaceAdmin') return `${field} (space administrator)`;
  return `${field} (${need.needs} on ${need.area})`;
}
