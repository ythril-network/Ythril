/**
 * A type's place in a space's schema versions (bundle-268, Q-744 design r4 §4, §5): the acts behind the type forms of
 * `GET /api/spaces/:id/schema-versions` and MCP `space_schema_versions`, reached through the one dispatcher (`schema-versions-acts.ts`).
 *
 * ## What each answers
 *
 * - {@link typeListAct} (`kind`): `{ kind, current, recordFacts?, types: [{ type, declared, networks?, older? }], ...the page fields }`. Every
 *   type the current schema declares for the kind (`own`, or `layer` with the networks whose layer declares it), and the names records carry
 *   that no current schema declares (`none`). `older` on an own row: whether some record of the type is not on its current definition, exactly
 *   when `filter {<type field>: T, schemaVersion: "older", schemaChanged: "any"}` finds one (the same stamps, {@link notSameFor}).
 * - {@link typeHistoryAct} (`kind` + `type`): `{ kind, type, current, declared, recordFacts?, cut?, definitions: [{ rep, current, since?,
 *   until?, origin }], ...the page fields }` (`type-history.ts`).
 * - {@link typeStandingsAct} (`fps` + `kind` + `type`): `{ kind, type, current, standings: [{ fp, standing, definition? }] }`, the drawer's
 *   row and the Brain's column: one call per page.
 *
 * ## Who sees what
 *
 * The current version must be one the caller may have (`404 unknown_fingerprint` otherwise: no type is placed against a version a peer may
 * not read). The record facts (the older mark and the record-only names) need `knowledge: read` on the space or an administrator
 * (`mayReadRecordFacts`); without it they are left out and the answer says `recordFacts: 'withheld'`. Nothing here answers a count.
 */
import { isDeclarableTypeName } from '@ythril-network/schema/internal';
import { COLLECTION_SUFFIX, type KnowledgeType } from '../config/types-knowledge.js';
import { getConfig } from '../config/loader.js';
import { pageList } from '../brain/list-page.js';
import { defaultBudgetChars, carriagesFor, type BudgetRequest } from '../brain/result-budget.js';
import { createCoalescingRunner } from '../sync/coalescing-runner.js';
import { UNKNOWN_FINGERPRINT } from '../util/errors.js';
import { variationOf } from './schema-stamp.js';
import { layersFor } from './network-layers.js';
import { heldVersionsKept } from './schema-version-text.js';
import { typeOnAnyOf, recordTypeNamesIn, stampIndexMayHoldArrays, unnamedFingerprintsIn, type StampedCollection } from './schema-snapshot-carried.js';
import {
  busyOnTimeout, kindStandingsIn, mayHave, notSameFor, notSameStanding, passTimeLeft, scopeKeyOf, standingsOf, type PassScope,
} from './type-standing.js';
import { mayReadRecordFacts, typeHistoryOf, declaredTypeNamesOf } from './type-history.js';
import type { SchemaVersionsActResult, SchemaVersionsCaller } from './schema-versions-acts.js';

/** The most fingerprints one `fps` read asks about: above the Brain's page of 20, well under any request bound. */
export const FPS_MAX = 100;

/** The current version, when the caller may have it; else the refusal (design r3 §3.2). */
async function currentFor(spaceId: string, caller: SchemaVersionsCaller): Promise<string | SchemaVersionsActResult> {
  const variation = variationOf(spaceId);
  if (!variation) return { status: 404, error: `space '${spaceId}' is not configured` };
  const current = variation.stamp.fp;
  const held = (await heldVersionsKept(spaceId, [current])).get(current);
  if (!held || !mayHave(held, caller.shared)) {
    return {
      status: 404, code: UNKNOWN_FINGERPRINT,
      error: 'This caller may not read this space\'s current schema version, so no type can be placed against it',
    };
  }
  return current;
}

const collectionOf = (kind: KnowledgeType): StampedCollection => COLLECTION_SUFFIX[kind] as StampedCollection;
const scopeOf = (spaceId: string, caller: SchemaVersionsCaller): PassScope => ({ shared: caller.shared, timeLeft: passTimeLeft(spaceId) });

const typeNamesOf = declaredTypeNamesOf;

/** The record facts of one kind's list: per own type, whether a record of it is not on its current definition, and the record-only names. */
interface KindFacts {
  readonly older: ReadonlyMap<string, boolean>;
  readonly none: readonly string[];
}

/** One pass per (space, kind, current, scope) in flight: four tabs opened at once cost one. A joiner wants the flight's answer, never a rerun. */
const kindFlights = createCoalescingRunner<KindFacts>({ rerun: false });

/**
 * The record facts of `kind` against `current`: the standing pass, then per own type one bounded seek over the stamps not `same` for it (R3),
 * and the record-only names (R5) each confirmed by a seek over the carried stamps, so a listed name always has a history.
 */
function kindFactsOf(spaceId: string, kind: KnowledgeType, current: string, own: readonly string[], declared: ReadonlySet<string>, scope: PassScope): Promise<KindFacts> {
  const collection = collectionOf(kind);
  return kindFlights.run(`${spaceId}|${collection}|${current}|any|${scopeKeyOf(scope.shared)}`, () => busyOnTimeout(spaceId, async () => {
    const { fps, mayHoldArrays } = await kindStandingsIn(spaceId, collection, current, 'any', scope);
    const older = new Map<string, boolean>();
    for (const type of own) {
      const notSame = notSameFor(fps, type);
      older.set(type, notSame.length > 0 && await typeOnAnyOf(spaceId, collection, type, notSame, scope.timeLeft, { mayHoldArrays }));
    }
    const stamps = [...fps.keys(), current];
    const none: string[] = [];
    for (const name of await recordTypeNamesIn(spaceId, collection, scope.timeLeft)) {
      if (declared.has(name) || !isDeclarableTypeName(name)) continue;
      if (await typeOnAnyOf(spaceId, collection, name, stamps, scope.timeLeft, { mayHoldArrays })) none.push(name);
    }
    return { older, none };
  }));
}

/**
 * One page of rows, in the words every budgeted list answers, less `returned`: it repeats `count` (`listPageFields` sets both from one
 * figure), and the type forms answer the page fields their shared answer fixture names (`client/src/app/testing/fixtures/schema-type-answers.json`).
 */
function pageOf<T>(rows: readonly T[], req: BudgetRequest & { skip?: unknown }, caller: SchemaVersionsCaller):
  { ok: true; rows: T[]; fields: Record<string, unknown> } | { ok: false; error: string } {
  const page = pageList(rows, { skip: req.skip, maxChars: req.maxChars, maxBytes: req.maxBytes, maxTokens: req.maxTokens }, {
    defaultLimit: Math.max(1, rows.length), budgetChars: defaultBudgetChars(caller.transport), carriages: carriagesFor(caller.transport),
  });
  if (!page.ok) return { ok: false, error: page.error };
  const { returned: _sameAsCount, ...fields } = page.fields;
  return { ok: true, rows: page.rows, fields };
}

/** One row of the type list. */
interface TypeRow {
  type: string;
  declared: 'own' | 'layer' | 'none';
  networks?: string[];
  older?: boolean;
}

/** The type list of `kind` (`kind`). */
export async function typeListAct(
  spaceId: string, kind: KnowledgeType, req: BudgetRequest & { skip?: unknown }, caller: SchemaVersionsCaller,
): Promise<SchemaVersionsActResult> {
  const current = await currentFor(spaceId, caller);
  if (typeof current !== 'string') return current;
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  const own = typeNamesOf(space?.ownMeta ?? space?.meta, kind).sort();
  const ownSet = new Set(own);
  const layers = layersFor(cfg, spaceId);
  const effective = new Set(typeNamesOf(space?.meta, kind));
  const cut = (ids: string[]): string[] => (caller.shared ? ids.filter(id => caller.shared!.has(id)) : ids);
  // Keyed by `Map`, so a type named `__proto__` reaches no prototype.
  const rows = new Map<string, TypeRow>();
  for (const type of own) rows.set(type, { type, declared: 'own' });
  for (const type of [...effective].filter(t => !ownSet.has(t)).sort()) {
    rows.set(type, { type, declared: 'layer', networks: cut(layers.filter(l => typeNamesOf(l.meta, kind).includes(type)).map(l => l.networkId)) });
  }
  const facts = mayReadRecordFacts(caller.rights, spaceId);
  if (facts) {
    const { older, none } = await kindFactsOf(spaceId, kind, current, own, new Set(rows.keys()), scopeOf(spaceId, caller));
    for (const type of own) rows.get(type)!.older = older.get(type) === true;
    for (const type of none) rows.set(type, { type, declared: 'none' });
  }
  const all = [...rows.values()].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  const page = pageOf(all, req, caller);
  if (!page.ok) return { status: 400, error: page.error };
  return { status: 200, body: { kind, current, ...(facts ? {} : { recordFacts: 'withheld' }), types: page.rows, ...page.fields } };
}

/** The history of (`kind`, `type`) (`kind` + `type`). */
export async function typeHistoryAct(
  spaceId: string, kind: KnowledgeType, type: string, req: BudgetRequest & { skip?: unknown }, caller: SchemaVersionsCaller,
): Promise<SchemaVersionsActResult> {
  const current = await currentFor(spaceId, caller);
  if (typeof current !== 'string') return current;
  const history = await typeHistoryOf(spaceId, kind, type, scopeOf(spaceId, caller));
  const rows = history.definitions.map(d => ({
    rep: d.rep, current: d.current, ...(d.since !== undefined ? { since: d.since } : {}), ...(d.until !== undefined ? { until: d.until } : {}),
    origin: { ...d.origin },
  }));
  const page = pageOf(rows, req, caller);
  if (!page.ok) return { status: 400, error: page.error };
  const facts = mayReadRecordFacts(caller.rights, spaceId);
  return {
    status: 200,
    body: {
      kind, type, current: history.current, declared: history.declared, ...(facts ? {} : { recordFacts: 'withheld' }),
      ...(history.cut ? { cut: true } : {}), definitions: page.rows, ...page.fields,
    },
  };
}

/** Where each of `fps` stands for (`kind`, `type`) against the current version, with the definition that holds it (`fps` + `kind` + `type`). */
export async function typeStandingsAct(
  spaceId: string, kind: KnowledgeType, type: string, fps: readonly string[], caller: SchemaVersionsCaller,
): Promise<SchemaVersionsActResult> {
  const current = await currentFor(spaceId, caller);
  if (typeof current !== 'string') return current;
  const collection = collectionOf(kind);
  const scope = scopeOf(spaceId, caller);
  const asked = [...new Set(fps)];
  const standings = await busyOnTimeout(spaceId, async () => {
    const placed = (await standingsOf(spaceId, collection, current, 'any', scope, asked)).fps;
    const ask = [...placed].filter(([, s]) => s !== 'notHeld' && s !== 'unclassified').map(([fp]) => fp);
    if (ask.length > 0) {
      const mayHoldArrays = await stampIndexMayHoldArrays(spaceId, collection);
      for (const fp of await unnamedFingerprintsIn(spaceId, collection, ask, scope.timeLeft, { mayHoldArrays })) placed.set(fp, 'unclassified');
    }
    return placed;
  });
  const standingOf = (fp: string): 'current' | 'older' | 'notHeld' | 'unclassified' => {
    if (fp === current) return 'current';
    const s = standings.get(fp);
    if (s === undefined || s === 'notHeld') return 'notHeld';
    if (s === 'unclassified') return 'unclassified';
    return notSameStanding(s, type) ? 'older' : 'current';
  };
  const rows = asked.map(fp => ({ fp, standing: standingOf(fp) }));
  const history = rows.some(r => r.standing === 'current' || r.standing === 'older') ? await typeHistoryOf(spaceId, kind, type, scope) : undefined;
  const out = rows.map(r => {
    const d = r.standing === 'current' || r.standing === 'older' ? history?.definitions.find(x => x.members.includes(r.fp)) : undefined;
    return d
      ? { ...r, definition: { rep: d.rep, ...(d.since !== undefined ? { since: d.since } : {}), ...(d.until !== undefined ? { until: d.until } : {}) } }
      : r;
  });
  return { status: 200, body: { kind, type, current, standings: out } };
}
