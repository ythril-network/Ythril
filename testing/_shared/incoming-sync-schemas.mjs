/**
 * Every `Incoming*` schema sync validates a pushed document with, READ OUT OF THE MODULE.
 *
 * ## Why this is derived and not a list
 *
 * The y-flows convention `convention-a-test-derives-its-set` states the rule and why it is written the way it is: *every `Incoming*`
 * schema in `api/sync/_shared.ts`, and it is written that way on purpose… Never count them here — the file
 * is the list.* It was learned the expensive way — a gate protecting that rule kept its own hand-written
 * list of four, missed `LinkDoc`, and so every assertion ran over the old four and **reported clean about a
 * document nobody had checked.**
 *
 * Two more gates were still doing exactly that when `Q-5` swept them:
 * `a-receiver-embeds-by-its-own-rules.test.js` asserted *"all four ingest schemas declare the flag"* and
 * `sync-carries-suppressed-memories.test.js` asserted *"NO incoming schema declares a vector — all four
 * alike"*. Six exist. Both titles were claims about the whole set, made by a loop over two thirds of it, and
 * both would have stayed green while `IncomingFileMetaDoc` lost its suppression flag or gained a vector.
 *
 * One helper rather than a second correct list, because the same rule written twice is the defect this
 * codebase produces most and the weaker copy is the one nobody watches.
 *
 * ## What counts as one
 *
 * A module export named `Incoming…Doc` that has a zod `.shape`. That is the shape of the thing, not a
 * naming convention this file invented — `docs.ts` builds the schema name from the record kind the same
 * way when it writes a refusal, so a schema that stopped matching would already be unreachable there.
 */
import assert from 'node:assert/strict';

/*
 * Re-anchored for Q-624 (design rev 4 section 2, D11): the `Incoming*` schemas live in the schema leaf, `sync/incoming-schemas.ts`, which imports no sync
 * machinery, and `api/sync/_shared.ts` re-exports them. The set is read out of the leaf, with the same floor; what it holds is unchanged by the move.
 */
let LEAF;
try { LEAF = await import('../../server/dist/sync/incoming-schemas.js'); }
catch (err) {
  throw new Error('server/dist/sync/incoming-schemas.js is not built: the Incoming*Doc schemas live in the schema leaf, and every gate that loops over them reads them from there '
    + `(${String(err?.code ?? err?.message)})`);
}

/** The prefix/suffix pair the ingest schemas are named with. */
const NAME = /^Incoming[A-Za-z]*Doc$/;

/**
 * `[name, zodObject]` for every ingest schema, sorted by name so a failure message is stable.
 *
 * @param {Record<string, unknown>} shared the imported `server/dist/api/sync/_shared.js`
 */
export function incomingSchemas(shared) {
  const found = Object.entries(LEAF)
    .filter(([name, v]) => NAME.test(name) && v && typeof v === 'object' && 'shape' in v)
    .sort(([a], [b]) => a.localeCompare(b));
  // The module a caller hands in (`api/sync/_shared.js`) re-exports what it held, so no importer changes: assert that it still does, and that it is the
  // SAME schema object, so a caller that tests through `_shared` is testing the leaf's schema and not a second copy of it.
  const reExported = found.filter(([name, v]) => shared?.[name] === v).length;
  assert.equal(reExported, found.length,
    `api/sync/_shared.js re-exports ${reExported} of the ${found.length} Incoming*Doc schemas the leaf holds: an importer that reads them through it is reading something else`);

  // THE VACUITY GUARD, and it is the whole point of deriving rather than listing. A rename, a bundler
  // change or a wrong import path would hand every caller an empty array, and an empty array passes every
  // `for` loop written over it — the same silent pass this helper exists to end. Six is what the rule in
  // `api/sync/_shared.ts` holds today; the assertion is a floor rather than an equality so that ADDING a seventh
  // schema does not fail a gate about something else, while losing one still does.
  assert.ok(found.length >= 6,
    `only ${found.length} Incoming*Doc schemas found in sync/incoming-schemas.js (${found.map(([n]) => n).join(', ') || 'none'}) — `
    + 're-anchor this helper before trusting any gate that loops over it');

  return found;
}

/**
 * The ingest schemas for records that can carry embedded TEXT.
 *
 * `IncomingLinkDoc` is the exemption and it has one reason: a link record is a pair of ids and a label
 * between two documents, so there is nothing to embed. `ingestBrainDoc` is told this out loud — links pass
 * `null` as the record type, which is *this kind has nothing to embed* — so a missing embed job on an
 * arriving link is correct rather than a bug, and a suppression flag on one would be a switch for a thing
 * that never happens.
 *
 * Written as an EXCLUSION so a new schema is covered by default. A seventh collection that also cannot
 * embed has to say so here, in the open, rather than being quietly absent from a list.
 *
 * @param {Record<string, unknown>} shared the imported `server/dist/api/sync/_shared.js`
 */
export function embeddableIncomingSchemas(shared) {
  return incomingSchemas(shared).filter(([name]) => name !== 'IncomingLinkDoc');
}
