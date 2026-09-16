/**
 * Every field on a replicated document is either HASHED and replicated, or excluded from the hash. Never
 * neither — because a field that is hashed and stripped makes two peers permanently disagree about identical
 * content.
 *
 * ## The two mechanisms, and why they have to be checked together
 *
 * **Stripping.** `docs.ts` runs every pushed document through `safeParse` before writing it, and zod strips
 * keys the schema does not declare. The pull path validates nothing. So a field missing from its `Incoming*`
 * twin is kept when the record arrives by pull and deleted when the same record arrives by push: same version,
 * push-only, direction-dependent, no error and a 200 on the way back.
 *
 * **Hashing.** `computeMerkleRoot` hashes every field of every brain document except the three it excludes at
 * the projection (`embedding`, `embeddingModel`, `matchedText`). That hash is what tells an operator whether
 * two instances hold the same data.
 *
 * Put them together and the rule falls out with no judgement left in it: **a field that is hashed must
 * replicate.** If it does not, the sender's copy has the key and the receiver's does not, and the roots differ
 * for ever — so a network with `merkle: true` logs a `MERKLE_DIVERGENCE` warning every cycle for a space where
 * nothing is wrong. That is worse than a wrong number: a permanent false alarm teaches an operator to ignore
 * the one signal that means data is missing.
 *
 * ## Why the rule is DERIVED rather than a list kept by hand
 *
 * The first version of this file carried a hand-written table of fields that deliberately do not replicate,
 * with a reason per row. It caught the case it was written for, and it had the flaw every such list has: a
 * reason once written is never re-read, and `suppressEmbeddings` sat in it as *"NOT a decision"* for exactly as
 * long as nobody looked.
 *
 * Now the exemptions come from `merkle.ts` itself. A field excluded from the hash is free not to replicate,
 * because the two peers were never going to compare it. Everything else must be declared. Adding a field means
 * declaring it on the ingest schema, or excluding it from the hash — and both of those are edits somebody has
 * to make deliberately in the file that governs the behaviour.
 *
 * ## The exemption list is empty, and it got there the way it was supposed to
 *
 * It briefly held the two retention stamps, `_expireAt` and `_contentExpireAt`, which were hashed and stripped
 * — a live defect rather than a decision, named here with the right answer beside it rather than quietly
 * widening the rule to fit them. W-10 excluded them from the hash, and the stale-row test below is what
 * insisted the rows come out on the same run.
 *
 * ## What deriving it caught on the first run
 *
 * Three fields, none of them suspected, all silently deleted on push and all hashed:
 *
 * - **`FactDoc.type`** — the field that selects a memory's type schema. A memory arriving without it is
 *   validated against nothing on the receiver and misses every type filter.
 * - **`ChronoEntry.contentRedacted` / `contentRedactedAt`** — the marks that exist so a reader can tell *"this
 *   entry never had a description"* from *"it had one and its retention window lapsed"*. The description is
 *   already gone by then, so stripping the marks destroys precisely the distinction they were added for.
 *
 * The hand-written version of this file did not name any of them, and would not have. That is the argument for
 * a derived rule in one sentence.
 *
 * Run: node --test testing/standalone/a-replicated-field-reaches-its-incoming-schema.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const TYPES = 'server/src/config/types.ts';
const SHARED = 'server/src/api/sync/_shared.ts';
const MERKLE = 'server/src/brain/merkle.ts';
/*
 * The exclusion SET left `merkle.ts` for `sync/local-only-fields.ts`, which has two consumers: the hash
 * skips these fields, and the pull path strips them from an arriving document. One list, because the rule
 * this file states runs both ways — a field that is hashed must replicate, so a field that must NOT
 * replicate must not be hashed, or the divergence warning fires for ever over nothing.
 *
 * The file-metadata INCLUSION list stayed in `merkle.ts`: it is a projection of that document's own
 * fields rather than a statement about which fields are local.
 */
const LOCAL_ONLY = 'server/src/sync/local-only-fields.ts';

/** Fields of a `*Doc` interface, in declaration order. */
function docFields(src, name) {
  const at = src.indexOf(`export interface ${name}`);
  if (at < 0) return null;
  const body = src.slice(at, src.indexOf('\n}', at));
  return [...body.matchAll(/^ {2}([a-zA-Z_]\w*)\??:/gm)].map(m => m[1]);
}

/** Keys of an `Incoming*` zod object. */
function incomingKeys(src, name) {
  const at = src.indexOf(`export const ${name}`);
  if (at < 0) return null;
  const body = src.slice(at, src.indexOf('});', at));
  return [...body.matchAll(/^ {2}([a-zA-Z_]\w*):/gm)].map(m => m[1]);
}

/**
 * The fields the divergence hash does NOT see, read out of `merkle.ts` rather than copied.
 *
 * Both spellings have to agree, and that is itself worth asserting: `DERIVED_FIELDS` is the set skipped while
 * canonicalising a document, and the `.project({...: 0})` is the set never fetched from MongoDB. They are two
 * statements of one intention, and a field in only one of them is either hashed when it should not be, or
 * fetched for nothing.
 */
/**
 * What the hash cannot see, from both of the places `merkle.ts` states it.
 *
 * ## Two projection SHAPES, and the second one is the opposite of the first
 *
 * The five document collections use an EXCLUSION projection: everything is hashed unless named. That is the
 * safe direction for them — a new AUTHORED field joins the hash on the commit that declares it.
 *
 * A file's metadata uses an INCLUSION projection, and deliberately: `FileMetaDoc` has thirty-odd fields and
 * all but a dozen are derived from the local blob. An exclusion list would have to name every one, and the
 * field somebody forgets is then hashed — so two instances that agree about everything anybody WROTE
 * diverge for ever over a chunk count.
 *
 * So the extractor has to read both, and what it returns is the same thing either way: the set of fields
 * the hash does not see.
 */
function merkleExcluded(src, docName, localOnlySrc) {
  const set = localOnlySrc.match(/LOCAL_ONLY_FIELDS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/);
  const names = s => [...(s ?? '').matchAll(/([a-zA-Z_]\w*)/g)].map(m => m[1]).filter(n => n !== '0');
  const fromSet = names(set?.[1]);

  /*
   * A file's list is INCLUSIVE, so 'excluded' is its complement against the document's own fields. Computed
   * that way rather than read off a second list, because a hand-written complement is a third statement of
   * one rule and this file exists to stop the second.
   */
  if (docName === 'FileMetaDoc') {
    const inc = src.match(/const FILE_HASH_PROJECTION = \{([\s\S]*?)\}\s*as const;/);
    const hashed = names(inc?.[1]).filter(n => n !== '1');
    return { fromSet, fromProjection: hashed, inclusive: true };
  }

  const proj = src.match(/const DERIVED_PROJECTION = \{([^}]*)\}/);
  return { fromSet, fromProjection: names(proj?.[1]), inclusive: false };
}

/**
 * Hashed, not replicated, and not a decision — EMPTY, and that is the state to keep it in.
 *
 * It held the two retention stamps until W-10 shipped, which is what an entry here is for: a live defect,
 * named, with the right answer written next to it, removed by the change that fixes it rather than by somebody
 * noticing later. The stale-row check below is what forced this list back to empty — excluding the stamps from
 * the hash made both rows unnecessary and the gate said so on the same run.
 *
 * Anything added here needs an open tracker row and a reason that says what the RIGHT answer is, not merely
 * what today's behaviour happens to be. A row without one is how an exemption becomes permanent.
 */
const HASHED_BUT_NOT_REPLICATED = {};

/**
 * Every replicated document and the schema that guards its push door — DERIVED from the schemas that exist.
 *
 * ## It was a hand-written list of four, and `M-2` is what that would have cost
 *
 * A fifth replicated document (`LinkDoc`) arrived and the list named four, so every assertion below would
 * have run over the old four and passed — reporting clean about a document nobody had checked. That is the
 * failure mode this whole file exists to catch, arriving through the file itself: a count cannot tell
 * "absent" from "never looked at".
 *
 * So the pairs come from the `Incoming*` schemas declared in `api/sync/_shared.ts`, and the document name
 * is derived from each one by dropping `Incoming`. Two names do not follow that rule and are mapped
 * explicitly — `IncomingChronoDoc` guards `ChronoEntry`, whose name predates the convention.
 *
 * The floor assertion below then does double duty: an `Incoming*` schema whose document cannot be found is
 * a re-anchor, and a replicated document with no `Incoming*` twin at all is caught by
 * `a-link-collection-joins-every-set-it-must.test.js`, which asks the question from the collection's side.
 */
const DOC_NAME_EXCEPTIONS = { IncomingChronoDoc: 'ChronoEntry' };

function replicatedPairs(sharedSrc) {
  const pairs = [];
  for (const m of sharedSrc.matchAll(/export const (Incoming\w*Doc)\s*=\s*z\.object\(/g)) {
    const inc = m[1];
    pairs.push([DOC_NAME_EXCEPTIONS[inc] ?? inc.replace(/^Incoming/, ''), inc]);
  }
  return pairs;
}

describe('a hashed field replicates, and a non-replicated field is not hashed', () => {
  const types = readFileSync(TYPES, 'utf8');
  const shared = readFileSync(SHARED, 'utf8');
  const merkle = readFileSync(MERKLE, 'utf8');
  const localOnly = readFileSync(LOCAL_ONLY, 'utf8');
  // Per document, because the two projection shapes are read differently — see `merkleExcluded`.
  const { fromSet, fromProjection } = merkleExcluded(merkle, null, localOnly);
  const REPLICATED = replicatedPairs(shared);

  it('the extractors find what they are looking for (the check itself works)', () => {
    // Floors every assertion below. A rename that broke any of these would make the comparisons run over
    // empty lists and pass, which is the failure mode a source-reading gate dies of.
    // The derivation's own floor, and it is the point of deriving: this number GREW when `M-2` added a
    // fifth replicated document, where a hand-written list would have gone on reporting clean about four.
    assert.ok(REPLICATED.length >= 5,
      `only ${REPLICATED.length} Incoming* schema(s) found in api/sync/_shared.ts — the extractor is broken, `
      + 'and a broken extractor makes every assertion below run over an empty list and pass');
    for (const [doc, inc] of REPLICATED) {
      // `LinkDoc` has nine fields and is the smallest replicated document there is — two endpoints, their
      // kinds, and the bookkeeping. The floor is what a real document cannot be under, not a round number.
      assert.ok((docFields(types, doc) ?? []).length > 6, `${doc} fields not found — re-anchor`);
      assert.ok((incomingKeys(shared, inc) ?? []).length > 6, `${inc} keys not found — re-anchor`);
    }
    assert.ok(fromSet.length >= 3, 'LOCAL_ONLY_FIELDS not found in sync/local-only-fields.ts — re-anchor');
    assert.ok(fromProjection.length >= 3, 'DERIVED_PROJECTION not found in merkle.ts — re-anchor');
    assert.ok(merkleExcluded(merkle, 'FileMetaDoc', localOnly).fromProjection.length >= 10,
      'FILE_HASH_PROJECTION not found in merkle.ts — re-anchor. It is an INCLUSION list, unlike every other '
      + 'collection, and reading it as an exclusion makes every derived file field look hashed.');
  });

  it('the two statements of "the hash does not see this" agree', () => {
    assert.deepEqual([...fromSet].sort(), [...fromProjection].sort(),
      'merkle.ts skips one set of fields while canonicalising and fetches a different set. A field in only '
      + 'one is either hashed when it must not be, or pulled out of MongoDB for nothing');
  });

  for (const [docName, incName] of REPLICATED) {
    it(`${docName}: every hashed field is declared by ${incName}`, () => {
      const fields = docFields(types, docName);
      const keys = incomingKeys(shared, incName);
      const view = merkleExcluded(merkle, docName, localOnly);
      /*
       * An INCLUSIVE projection turns the question round: a field is hashed only if it is NAMED, so
       * everything else is out of the hash and needs no declaration. The rule is unchanged — hashed AND
       * replicated, or neither — and this is the same rule read off the other shape.
       */
      const hashes = f => view.inclusive ? view.fromProjection.includes(f) : !view.fromProjection.includes(f);
      const undeclared = fields.filter(f =>
        hashes(f) && !keys.includes(f) && !fromSet.includes(f) && !(f in HASHED_BUT_NOT_REPLICATED));
      assert.deepEqual(undeclared, [],
        `${undeclared.join(', ')} on ${docName} is HASHED by the divergence check and STRIPPED on push. So `
        + `the two peers hash it differently for ever, so a network with merkle:true logs a MERKLE_DIVERGENCE `
        + `warning every cycle for a space where nothing is wrong. Declare them on ${incName}, or exclude them `
        + 'from the hash in merkle.ts (both places).');
    });
  }

  it('the exemption list has no stale rows', () => {
    /*
     * The other direction, and the reason an exemption is not free. A row naming a field that is now declared,
     * or now excluded from the hash, is a reason nobody will re-read — and this file exists partly because
     * that already happened once, to a row that read "NOT a decision" for as long as nobody looked at it.
     */
    const stale = Object.keys(HASHED_BUT_NOT_REPLICATED).filter(f => {
      if (fromSet.includes(f)) return true;
      return REPLICATED.every(([doc, inc]) => {
        const fields = docFields(types, doc) ?? [];
        return !fields.includes(f) || (incomingKeys(shared, inc) ?? []).includes(f);
      });
    });
    assert.deepEqual(stale, [],
      `${stale.join(', ')} is exempt but no longer needs to be — it is now either excluded from the hash or `
      + 'declared on every schema. Remove the row, and close the tracker item it names.');
  });

  it('and the endpoint KINDS cross the wire, which is the whole of M-1', () => {
    /*
     * `from`/`to` are bare ids, unambiguous only while both ends are always entities — the owner's case is a
     * party photo whose file meta links to person entities, a chrono event and a memory, so `to: "abc"`
     * becomes ambiguous across four collections.
     *
     * Asserted on BOTH shapes in one case on purpose: the field existing on `EdgeDoc` alone is the defect,
     * not a step towards the fix.
     */
    for (const f of ['fromKind', 'toKind']) {
      assert.ok(docFields(types, 'EdgeDoc').includes(f), `EdgeDoc does not declare ${f}`);
      assert.ok(incomingKeys(shared, 'IncomingEdgeDoc').includes(f),
        `IncomingEdgeDoc does not declare ${f}, so a pushed edge loses the kind of its own endpoints`);
    }
  });
});
