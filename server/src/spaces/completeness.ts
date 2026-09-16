/**
 * Space completeness — how much of what this space *declared* it would hold, it actually holds.
 *
 * **A score is not the feature; the checks are.** A space that reads "68 %" and cannot say which 32 %
 * produces guilt without a next action, so nothing here computes a number first and explains it after.
 * Each check names one specific missing thing, counts how many records it affects, and carries a sample
 * the UI can link to. The score is the weighted roll-up of those checks and nothing more — remove a
 * check and the number changes; there is no separate notion of "completeness" to keep in sync.
 *
 * **Applicability, never zero.** A check with no denominator is dropped from the roll-up rather than
 * scored 0. A space that declares no `typeSchemas` has opted out of schema governance deliberately;
 * scoring it 0 % for that would make the number a scold instead of a measurement, and an operator who
 * cannot make the number go up stops reading it. `total: 0` means "not asked", not "failed".
 *
 * The split in this file is deliberate: {@link gatherCompletenessFacts} does the I/O and
 * {@link scoreCompleteness} does the judging, over a plain object. The judging is where the bugs will
 * be, and it is unit-testable without Mongo.
 */
import { col } from '../db/mongo.js';
import type { BrainCollection } from '../config/types.js';
import type { SpaceMeta, KnowledgeType } from '../config/types.js';

/** The knowledge collections a check can point at. `file` is not a `KnowledgeType` — it has no schema. */
export type CompletenessScope = KnowledgeType | 'file' | 'space';

export type CompletenessCheckId =
  | 'declared-type-unused'
  | 'undeclared-type-in-use'
  | 'declared-property-never-filled'
  | 'entity-without-edges'
  | 'file-not-recallable'
  | 'meta-purpose-missing'
  | 'schemas-declared-but-unenforced';

export interface CompletenessCheck {
  id: CompletenessCheckId;
  /** `warn` = records are already wrong or invisible. `info` = the space is thinner than it declared. */
  severity: 'info' | 'warn';
  /** Which collection (or the space itself) this instance of the check is about. A check id can appear
   *  once per knowledge kind — `declared-type-unused` for entities and for edges are different findings
   *  with different samples, and collapsing them would make the sample meaningless. */
  scope: CompletenessScope;
  /** How many of the checked things are missing or wrong. */
  affected: number;
  /** How many things were checked. Always `> 0` — see {@link CompletenessReport.checks}. */
  total: number;
  weight: number;
  /** `0..weight`. Partial credit — a space with 1 of 40 entities unlinked is not the same as 40 of 40. */
  earned: number;
  /** At most {@link SAMPLE_CAP} identifiers — type names, property keys or record ids, per check. */
  sample: string[];
  /** Which Brain tab shows the affected records, or `null` when the finding is about the space itself
   *  and no collection displays it. The UI turns it into a link. */
  /**
   * Where the affected records are, or `null` for a finding about the space itself.
   *
   * ## Narrower than `BrainCollection`, and the compiler is what made that visible
   *
   * This field was `BrainCollection | null` on both sides of the API and it feeds a BUTTON: the Overview's
   * tiles and the Review tab pass it straight into an `output<CollectionTab>()`. That typechecked for as
   * long as the collections and the Brain's tabs had the same five members, and broke the hour `M-2` added
   * a sixth — which is the same trap, one field down, as the three collection SETS that looked like one
   * list because it had four members.
   *
   * A link record has no tab and will not get one: it is DERIVED from an array on another record, so a
   * "go and fix these" button pointing at it would open nothing an operator could act on. The owner's
   * ruling on how links surface says the same — *"on graph shown as info on click, and toggleable if
   * memories and chronos appear"* — a graph affordance and a recall toggle, not a tab.
   *
   * So the exclusion lives in the type, where a check that tried to target links is a compiler error at the
   * point it is written. The client's mirror narrows to its own `CollectionTab`, which is the authority on
   * that side; `brain-tabs.ts` holds the decision and says why the two lists are not related.
   */
  targetTab: Exclude<BrainCollection, 'links'> | null;
}

export interface CompletenessReport {
  spaceId: string;
  /** `0..100`, or `null` when no check applied — a brand-new space is not "0 % complete". */
  score: number | null;
  /**
   * **Only checks that applied.** A check with no denominator is absent, not present with `total: 0`:
   * the array is the list of questions this space could be asked, and a question that does not arise is
   * not a question it failed. That is what keeps the score from being a scold.
   */
  checks: CompletenessCheck[];
  /** True when a schema declared more property keys than {@link PROPERTY_KEY_CAP} and the tail was not
   *  checked. Surfaced rather than silently truncated — a bounded check that lies is worse than none. */
  truncated: boolean;
}

/** Sample identifiers returned per check. Enough to recognise the problem, not enough to be a payload. */
export const SAMPLE_CAP = 5;

/**
 * Property keys examined per (knowledge type, type name). A schema with more declared keys than this is
 * pathological, and the alternative is an unbounded `$match` fan-out on a page load.
 */
export const PROPERTY_KEY_CAP = 50;

/**
 * Weights. Every number here has a reason next to it; none was chosen by feel.
 *
 * The scale is deliberately coarse (1 / 2 / 3). Finer weights imply a precision this measurement does
 * not have, and invite endless re-tuning of a number whose only job is to rank the checks.
 */
export const CHECK_WEIGHTS: Record<CompletenessCheckId, number> = {
  // Records are ALREADY invalid under the space's own rules — this is debt that has been taken on,
  // not work not yet done. Highest weight, and the only check that can fail records retroactively.
  'undeclared-type-in-use': 3,
  // A file no recall path can reach is not "incomplete", it is absent. Uploading it accomplished nothing.
  'file-not-recallable': 3,
  // An entity graph with no edges is a list. This is the single biggest "set up but not usable" signal,
  // but unlike the two above it costs nothing today — it only caps how much the space can ever answer.
  'entity-without-edges': 2,
  // A declared field nothing fills is a field nobody knew to fill. Real, common, and cheap to fix.
  'declared-property-never-filled': 2,
  // The space wrote rules and turned off the referee. Boolean, and one setting away from fixed.
  'schemas-declared-but-unenforced': 2,
  // A declared vocabulary the space never used — usually a typo or an abandoned model. Informational:
  // an unused type harms nothing, it just means the schema is describing an intention, not the contents.
  'declared-type-unused': 1,
  // MCP clients get no directive at handshake. Small, boolean, and genuinely one text field.
  'meta-purpose-missing': 1,
};

/** The four knowledge types that carry `typeSchemas`, and the collection + type field for each. */
const SCHEMA_KINDS: { kind: KnowledgeType; collection: string; typeField: string; tab: CompletenessCheck['targetTab'] }[] = [
  { kind: 'entity', collection: 'entities', typeField: 'type', tab: 'entities' },
  { kind: 'fact', collection: 'facts', typeField: 'type', tab: 'facts' },
  // Edges are typed by their `label`, not a `type` field — `typeSchemas.edge` keys are label values.
  { kind: 'edge', collection: 'edges', typeField: 'label', tab: 'edges' },
  { kind: 'chrono', collection: 'chrono', typeField: 'type', tab: 'chrono' },
];

/** Per-collection observations. Plain data so {@link scoreCompleteness} needs no database. */
export interface CompletenessFacts {
  /** knowledge type → type/label value → how many records carry it. Untyped records key on `''`. */
  typeCounts: Record<KnowledgeType, Record<string, number>>;
  /** knowledge type → type value → property key → how many records of that type set it. */
  propertyFilled: Record<KnowledgeType, Record<string, Record<string, number>>>;
  entities: number;
  /** Entities named by at least one edge's `from` or `to`. */
  entitiesWithEdges: number;
  /** Sample ids of entities with no edge at all. */
  unlinkedEntitySample: string[];
  /** Parent file records (chunks excluded) that are neither embedded nor chunked. */
  files: number;
  filesNotRecallable: number;
  fileSample: string[];
}

function emptyByKind<T>(make: () => T): Record<KnowledgeType, T> {
  return { entity: make(), fact: make(), edge: make(), chrono: make() };
}

/**
 * Read the space's contents into {@link CompletenessFacts}.
 *
 * Bounded on purpose: a fixed number of aggregations regardless of how many types or properties the
 * schema declares — two per schema-bearing collection, two over edges, two over files. This runs on a
 * page load, so "one query per declared type" was never an option.
 *
 * `memberIds` is the resolved member list, so a proxy space aggregates over every space it fronts,
 * exactly as `GET /:id/meta` does for its counts.
 */
export async function gatherCompletenessFacts(memberIds: string[]): Promise<CompletenessFacts> {
  const facts: CompletenessFacts = {
    typeCounts: emptyByKind<Record<string, number>>(() => ({})),
    propertyFilled: emptyByKind<Record<string, Record<string, number>>>(() => ({})),
    entities: 0,
    entitiesWithEdges: 0,
    unlinkedEntitySample: [],
    files: 0,
    filesNotRecallable: 0,
    fileSample: [],
  };

  for (const sid of memberIds) {
    for (const { kind, collection, typeField } of SCHEMA_KINDS) {
      const byType = await col(`${sid}_${collection}`).aggregate<{ _id: unknown; n: number }>([
        { $group: { _id: `$${typeField}`, n: { $sum: 1 } } },
      ]).toArray();
      for (const row of byType) {
        const key = typeof row._id === 'string' ? row._id : '';
        facts.typeCounts[kind][key] = (facts.typeCounts[kind][key] ?? 0) + row.n;
      }

      // (type, property key) → count, in one pass. `$objectToArray` on a missing `properties` would
      // throw, hence the `$ifNull`; records with no properties contribute no rows at all.
      const byProp = await col(`${sid}_${collection}`).aggregate<{ _id: { t: unknown; p: string }; n: number }>([
        { $project: { t: `$${typeField}`, kv: { $objectToArray: { $ifNull: ['$properties', {}] } } } },
        { $unwind: '$kv' },
        { $group: { _id: { t: '$t', p: '$kv.k' }, n: { $sum: 1 } } },
      ]).toArray();
      for (const row of byProp) {
        const t = typeof row._id.t === 'string' ? row._id.t : '';
        const forType = (facts.propertyFilled[kind][t] ??= {});
        forType[row._id.p] = (forType[row._id.p] ?? 0) + row.n;
      }
    }

    // Entity linkage. Joined edge-side rather than collecting every endpoint id into a Set and then
    // `$nin`-ing it: on a large graph that array IS the graph, shipped into a query. Each `$lookup`
    // stops at the first matching edge, so an entity with 10 000 edges costs the same as one with 1.
    // Both join fields are indexed (`{from,to,label}` gives `from`; `{to:1}` is created alongside it).
    const [unlinked] = await col(`${sid}_entities`).aggregate<{ n: number; sample: string[] }>([
      { $lookup: { from: `${sid}_edges`, localField: '_id', foreignField: 'from', pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }], as: 'out' } },
      { $lookup: { from: `${sid}_edges`, localField: '_id', foreignField: 'to', pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }], as: 'inb' } },
      { $match: { out: { $size: 0 }, inb: { $size: 0 } } },
      { $group: { _id: null, n: { $sum: 1 }, sample: { $firstN: { input: '$_id', n: SAMPLE_CAP } } } },
    ]).toArray();
    const entityCount = await col(`${sid}_entities`).countDocuments();
    facts.entities += entityCount;
    facts.entitiesWithEdges += entityCount - (unlinked?.n ?? 0);
    for (const id of unlinked?.sample ?? []) {
      if (facts.unlinkedEntitySample.length < SAMPLE_CAP) facts.unlinkedEntitySample.push(String(id));
    }

    // A file is recallable if it carries its own embedding OR something chunked it. Chunk records
    // (`parentFileId` set) are not files in their own right and are excluded from both sides.
    const parentFilter = { parentFileId: { $exists: false } };
    facts.files += await col(`${sid}_files`).countDocuments(parentFilter);
    const [orphaned] = await col(`${sid}_files`).aggregate<{ n: number; sample: string[] }>([
      { $match: { ...parentFilter, embedding: { $exists: false } } },
      { $lookup: { from: `${sid}_files`, localField: '_id', foreignField: 'parentFileId', pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }], as: 'chunks' } },
      { $match: { chunks: { $size: 0 } } },
      { $group: { _id: null, n: { $sum: 1 }, sample: { $firstN: { input: { $ifNull: ['$path', '$_id'] }, n: SAMPLE_CAP } } } },
    ]).toArray();
    facts.filesNotRecallable += orphaned?.n ?? 0;
    for (const p of orphaned?.sample ?? []) {
      if (facts.fileSample.length < SAMPLE_CAP) facts.fileSample.push(String(p));
    }
  }

  return facts;
}

/** Partial credit, clamped. `affected > total` cannot happen but must not produce a negative score. */
function credit(weight: number, affected: number, total: number): number {
  if (total <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, affected / total));
  return weight * (1 - ratio);
}

/**
 * Turn schema + contents into the checks and their roll-up. Pure — no database, no clock, no config.
 */
export function scoreCompleteness(spaceId: string, meta: SpaceMeta, facts: CompletenessFacts): CompletenessReport {
  const checks: CompletenessCheck[] = [];
  let truncated = false;

  /** Push a check ONLY if it applied. `total <= 0` means the question does not arise for this space. */
  const push = (
    id: CompletenessCheckId,
    severity: CompletenessCheck['severity'],
    scope: CompletenessScope,
    affected: number,
    total: number,
    sample: string[],
    targetTab: CompletenessCheck['targetTab'],
  ): void => {
    if (total <= 0) return;
    const weight = CHECK_WEIGHTS[id];
    checks.push({ id, severity, scope, affected, total, weight, earned: credit(weight, affected, total), sample, targetTab });
  };

  const typeSchemas = meta.typeSchemas ?? {};

  for (const { kind, tab } of SCHEMA_KINDS) {
    const declared = typeSchemas[kind] ?? {};
    const declaredNames = Object.keys(declared);
    const counts = facts.typeCounts[kind];
    if (declaredNames.length === 0) continue;   // no allowlist → nothing declared to measure against

    const unusedSample: string[] = [];
    let unused = 0;
    for (const name of declaredNames) {
      if ((counts[name] ?? 0) > 0) continue;
      unused++;
      if (unusedSample.length < SAMPLE_CAP) unusedSample.push(name);
    }
    push('declared-type-unused', 'info', kind, unused, declaredNames.length, unusedSample, tab);

    // Against a NON-EMPTY allowlist only: an empty map means "all values accepted", so every record is
    // declared by definition and counting them as violations would invert the setting's meaning.
    const allowed = new Set(declaredNames);
    const undeclaredSample: string[] = [];
    let undeclared = 0, typedRecords = 0;
    for (const [value, n] of Object.entries(counts)) {
      // `''` is a record with no type at all. An allowlist does not forbid being untyped — validation
      // only fires on a value that is present and unknown — so untyped records are not in scope here.
      if (value === '') continue;
      typedRecords += n;
      if (allowed.has(value)) continue;
      undeclared += n;
      if (undeclaredSample.length < SAMPLE_CAP) undeclaredSample.push(value);
    }
    push('undeclared-type-in-use', 'warn', kind, undeclared, typedRecords, undeclaredSample, tab);

    const emptyPropSample: string[] = [];
    let propTotal = 0, propEmpty = 0;
    for (const name of declaredNames) {
      const propKeys = Object.keys(declared[name]?.propertySchemas ?? {});
      if (propKeys.length > PROPERTY_KEY_CAP) truncated = true;
      // A type nobody instantiated cannot have unfilled properties — that is `declared-type-unused`,
      // already counted. Charging it twice would double-penalise one mistake.
      if ((counts[name] ?? 0) === 0) continue;
      const filled = facts.propertyFilled[kind][name] ?? {};
      for (const key of propKeys.slice(0, PROPERTY_KEY_CAP)) {
        propTotal++;
        if ((filled[key] ?? 0) > 0) continue;
        propEmpty++;
        if (emptyPropSample.length < SAMPLE_CAP) emptyPropSample.push(`${name}.${key}`);
      }
    }
    push('declared-property-never-filled', 'info', kind, propEmpty, propTotal, emptyPropSample, tab);
  }

  push('entity-without-edges', 'info', 'entity', facts.entities - facts.entitiesWithEdges, facts.entities, facts.unlinkedEntitySample, 'entities');
  push('file-not-recallable', 'warn', 'file', facts.filesNotRecallable, facts.files, facts.fileSample, 'files');

  // Boolean checks. `total: 1` when the question applies at all, so they join the roll-up on the same
  // footing as the counted ones instead of needing a second scoring path.
  const purposeMissing = !meta.purpose || meta.purpose.trim() === '';
  push('meta-purpose-missing', 'info', 'space', purposeMissing ? 1 : 0, 1, [], null);

  const hasSchemas = SCHEMA_KINDS.some(({ kind }) => Object.keys(typeSchemas[kind] ?? {}).length > 0);
  push('schemas-declared-but-unenforced', 'warn', 'space',
    hasSchemas && (meta.validationMode ?? 'off') === 'off' ? 1 : 0, hasSchemas ? 1 : 0, [], null);

  const possible = checks.reduce((s, c) => s + c.weight, 0);
  const score = possible > 0 ? Math.round((checks.reduce((s, c) => s + c.earned, 0) / possible) * 100) : null;

  return { spaceId, score, checks, truncated };
}
