/**
 * The schema retention tier must reach every typed collection — not just the one it was written for.
 *
 * ## The failure this exists for
 *
 * `retention` on a type resolved correctly and applied to nothing outside chrono. Three of the four typed
 * collections called the TTL stamper WITHOUT their collection:
 *
 *     chrono.ts     stampExpiryOnCreate(spaceId, doc, ttlDays, { collection: 'chrono', type: doc.type })
 *     entities.ts   stampExpiryOnCreate(spaceId, doc, ttlDays)
 *     memory.ts     stampExpiryOnCreate(spaceId, doc, ttlDays)
 *     edges.ts      stampExpiryOnCreate(spaceId, doc, ttlDays)
 *
 * and `expiryForCreate` reads `typed ? … : undefined`, so the omission fell through to the space default in
 * silence. Every update site omitted it too, chrono's included. Meanwhile the API accepted the field, the guide
 * documented it as covering all four collections with an `entity.ticket` worked example, and the Schema tab
 * offered an input for it.
 *
 * **Why 30 passing unit tests did not catch it.** They test the pure resolver with `collection` handed in. Every
 * branch is covered. Nothing asserted that a *caller* supplies it — which is the entire bug.
 *
 * So this gate reads the CALL SITES, and a companion DB test proves an `entity` window reaches `_expireAt`.
 *
 * Run: node --test testing/standalone/retention-reaches-every-collection.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { balancedFrom, blockAfter } from './_structural-window.mjs';

const ROOT = process.cwd();

/** file → the collection literal its TTL calls must pass. */
const TYPED = {
  'server/src/brain/entities.ts': 'entity',
  'server/src/brain/fact.ts':   'fact',
  'server/src/brain/edges.ts':    'edge',
  'server/src/brain/chrono.ts':   'chrono',
};

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Every `stampExpiryOnCreate(` / `applyExpiryToUpdate(` call in a file, with its full argument text. */
function ttlCalls(src) {
  const out = [];
  const re = /(stampExpiryOnCreate|applyExpiryToUpdate)\(/g;
  let m;
  while ((m = re.exec(src))) {
    // Walk to the matching close paren so a multi-line call is one call.
    let depth = 1, i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    const args = src.slice(re.lastIndex, i - 1);
    // Skip the definitions themselves (ttl.ts) — they have a typed parameter, not an argument.
    if (/^\s*$/.test(args)) continue;
    out.push({ fn: m[1], args, line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

describe('the schema retention tier reaches every typed collection', () => {
  it('found the call sites — the pattern still matches', () => {
    const total = Object.keys(TYPED).reduce((n, f) => n + ttlCalls(read(f)).length, 0);
    assert.ok(total >= 10, `only found ${total} TTL call sites across the four typed collections`);
  });

  it('every create and update passes its collection', () => {
    const bad = [];
    for (const [file, kt] of Object.entries(TYPED)) {
      for (const c of ttlCalls(read(file))) {
        if (!c.args.includes(`collection: '${kt}'`)) bad.push(`${file}:${c.line} ${c.fn} — no collection: '${kt}'`);
      }
    }
    assert.deepEqual(bad, [], 'these TTL calls omit their collection, so the resolver falls through to the space '
      + `default and the type's own retention window does nothing:\n  ${bad.join('\n  ')}\n\n`
      + "Pass `{ collection: '<kind>', … }` as the last argument.");
  });

  it('an edge keys on `label`, never on `type`', () => {
    // EdgeDoc has BOTH, and `validateEdgeWrite` looks the schema up by label. Reading `type` for an edge finds
    // a schema that is never there and looks like it worked, which is worse than not passing anything.
    const src = read('server/src/brain/edges.ts');
    for (const c of ttlCalls(src)) {
      if (!c.args.includes("collection: 'edge'")) continue;
      assert.ok(!/type:\s*doc\.type|type:\s*existing\.type/.test(c.args),
        `edges.ts:${c.line} resolves its retention type from \`type\`; the schema is keyed by \`label\``);
    }
    // A WINDOW, converted: the subject is the TYPE_FIELD map itself, bounded by the brace that closes it. 200
    // characters reached past the map into the functions below, where `'label'` appears for other reasons.
    const ttl = read('server/src/brain/ttl.ts');
    const map = ttl.indexOf('TYPE_FIELD');
    assert.ok(map > -1, 'TYPE_FIELD is gone — re-anchor this gate');
    assert.match(balancedFrom(ttl, ttl.indexOf('{', map), 'the TYPE_FIELD map'), /edge:\s*'label'/,
      "ttl.ts must map edge -> 'label' in TYPE_FIELD");
  });

  it('the backfill pass walks all four collections, not only chrono', () => {
    // The half that made the tier apply to records that already exist. Chrono had it; the other three did not,
    // so a window set today would never reach yesterday's records even once the create path was fixed.
    const src = read('server/src/brain/chrono-redaction.ts');
    /*
     * The DERIVATION, not a hand-written list — and this assertion got stronger when the list went away.
     *
     * It used to require the four names in order: `['entity', 'fact', 'edge', 'chrono']`. That could only
     * ever check the list somebody had already typed, so a fifth knowledge type would leave it green while
     * the new type's records were never stamped — a retention policy an operator set and nothing applied.
     *
     * `TYPED_COLLECTIONS = KNOWLEDGE_TYPES` cannot be three of four, or four of five, by construction. The
     * question this gate asks is now "does the sweep walk every typed collection there IS", which is what
     * its own title claims, rather than "does it walk the four that existed when this was written".
     */
    assert.match(src, /TYPED_COLLECTIONS[^=]*=\s*KNOWLEDGE_TYPES\b/,
      'TYPED_COLLECTIONS must BE the knowledge types, so a new kind is covered without an edit here');
    assert.match(src, /import\s*\{\s*KNOWLEDGE_TYPES\s*\}/,
      'and it has to import them, or the line above is matching a local shadow');
    // A WINDOW, converted: the subject is the loop BODY, bounded by the brace that closes it. A cap here also
    // could not tell "the call is inside the loop" from "the call is 200 characters after it", which is the
    // difference between per-collection and once.
    const loop = src.indexOf('for (const collection of TYPED_COLLECTIONS)');
    assert.ok(loop > -1, 'the sweep loop is gone — re-anchor this gate');
    assert.match(blockAfter(src, loop, 'the retention sweep loop'), /backfillTypedExpiry/,
      'the sweep must call backfillTypedExpiry for each collection');
    // Files stay out: no type, so no schema window. Asserted so nobody "completes" the list.
    assert.ok(!/TYPED_COLLECTIONS[^=]*=[^\]]*'file/.test(src),
      'files have no type and therefore no schema window — they must not be in TYPED_COLLECTIONS');
  });

  it('switching a dormant policy on is announced, not silent', () => {
    // A window configured months ago through the API starts deleting records the first time this pass reaches
    // it. That is the documented behaviour and still worth one info line per space+type.
    const src = read('server/src/brain/chrono-redaction.ts');
    assert.match(src, /announced\.has\(key\)/, 'the first stamp for a space+type must be reported once');
    assert.match(src, /log\.info\(`Retention:/, 'that report must be at info, not debug');
  });

  it('the documented worked example is the one that was broken', () => {
    // The guide promises the tier on `entity`, with `ticket` as its example. If that claim is ever narrowed to
    // chrono, this gate should be reconsidered rather than silently disagreeing with the docs.
    //
    // `04f-write-semantics.md` since A-5: expiry moved off the memory page with the rest of the rules that
    // apply to every record type, and the worked example went with it.
    // A WINDOW, converted: the subject is the `"entity"` object in the JSON example, bounded by its own brace.
    // The example is prose-adjacent and gets reformatted; 120 characters is a claim about how somebody chose to
    // wrap the snippet, not about whether `retention` is shown under `entity`.
    const doc = read('docs/integration-guide/04f-write-semantics.md');
    const entity = doc.indexOf('"entity": {');
    assert.ok(entity > -1, 'the guide no longer shows an "entity" schema object — re-anchor this gate');
    assert.match(balancedFrom(doc, doc.indexOf('{', entity), 'the entity schema example'), /"retention"/,
      'the guide no longer shows an entity retention example — check whether the tier’s scope changed');
  });
});
