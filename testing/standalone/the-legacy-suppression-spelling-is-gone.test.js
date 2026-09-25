/**
 * `excludeFromVectorSearch` is gone — both halves of it, everywhere.
 *
 * `_DEPRECATIONS.md` row 1.8: the pre-3.1.0 spelling of the per-record never-embed mark. It has two halves
 * and they have to go together, because either one left behind is worse than both staying:
 *
 *  - the **input alias**, read by `parseRecordSuppression` — the one place either door accepted it;
 *  - the **stored key**, written beside the current spelling, read back as a fallback, excluded from the
 *    not-suppressed filter, declared on four record types, hashed by `merkle.ts`, projected by `reindex.ts`,
 *    and accepted by five `Incoming*` ingest schemas.
 *
 * Leave the stored key and drop the input and a record already carrying it keeps working while nobody can
 * set it — two spellings, one readable. Drop the stored key and keep the input and a caller is told 201 for
 * a field that is written and never read.
 *
 * ## Why it could not go before now
 *
 * A peer below 3.1.0 does not know the current spelling, strips it on ingest, and replicates its
 * unsuppressed copy onward: content an author marked never-embed reaches an embedding model and returns to
 * ranked search, silently, on every instance. The peer floor (`N-1`) is this instance's own MAJOR, so only a
 * 4.x build refuses every 3.x peer.
 *
 * **The development tree is 3.4.0 and its floor is 3.0.0, which admits exactly that peer.** That is not a
 * hazard, because reaching anyone requires a RELEASE, and the owner ruled on 2026-09-05 that there will be
 * none before 4.0. So the check lives in `release-gate.mjs`, where a tag is refused if this key is gone and
 * the major is below 4 — the moment the assumption is actually tested, rather than an always-on gate that
 * would keep the tree red for a risk that development cannot reach.
 *
 * Run: node --test testing/standalone/the-legacy-suppression-spelling-is-gone.test.js
 */
import { describe, it, before } from 'node:test';
import { trackedSources } from './_sources.mjs';
import { incomingSchemas } from '../_shared/incoming-sync-schemas.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const LEGACY = 'excludeFromVectorSearch';

/** Tracked server sources only, comments stripped — a docblock explaining the removal is not a use. */
function serverSources() {
  return trackedSources('server/src');
}

describe('the legacy spelling is gone from the server', () => {
  it('the sweep sees the sources at all', () => {
    // The vacuity guard: a `git ls-files` that returns nothing would report a clean removal over no files.
    const files = serverSources();
    assert.ok(files.length > 100, `only ${files.length} server sources found — the sweep is measuring nothing`);
  });

  it('and the current spelling is still there, so this is a REMOVAL and not a rename', () => {
    /*
     * The second vacuity guard, and the more important one. If `suppressEmbeddings` had gone too, every
     * assertion below would pass over a feature that no longer exists — which is not what row 1.8 asks for.
     */
    const src = stripComments(readFileSync('server/src/brain/suppress-embeddings.ts', 'utf8'));
    assert.match(src, /suppressEmbeddings/,
      'the current spelling is gone as well — this row retires one of two spellings, not the feature');
  });

  it('NO server source mentions it, in code or in a type', () => {
    const offenders = serverSources()
      .filter(f => stripComments(readFileSync(f, 'utf8')).includes(LEGACY));
    assert.deepEqual(offenders, [],
      `${offenders.join(', ')} still names \`${LEGACY}\`. Both halves go together: the input alias and the `
      + 'stored key, including its declaration on the record types, its row in the merkle projection, its '
      + 'reindex projections and its six ingest schemas.');
  });
});

describe('the doors refuse it rather than ignoring it', () => {
  it('the REST unknown-field list no longer excuses it', () => {
    /*
     * `unknown-fields.ts` is what turns an unrecognised key into a refusal. While the legacy name sits on
     * its allowed list, a body carrying it is accepted and dropped — a 201 for a field nothing reads, which
     * is the exact failure `.strict()` exists to prevent one file over.
     */
    const src = stripComments(readFileSync('server/src/api/brain/unknown-fields.ts', 'utf8'));
    assert.ok(!src.includes(LEGACY) && !src.includes('LEGACY_RECORD_SUPPRESS_FIELD'),
      'the REST doors still allow the legacy field through, so it is accepted and silently dropped');
  });

  it('and no MCP tool schema declares it', () => {
    /*
     * MCP schemas are `additionalProperties: false` and the dispatcher validates before the handler, so
     * removing the property is what makes the tools refuse the field — the refusal is the absence.
     */
    // The floor is 10 rather than the default 100: this is one subtree, and a floor above what the scan can
    // ever return fails on correct code.
    const offenders = trackedSources('server/src/mcp', { floor: 10 })
      .filter(f => stripComments(readFileSync(f, 'utf8')).includes(LEGACY));
    assert.deepEqual(offenders, [],
      `${offenders.join(', ')} still declares the legacy field, so the tool accepts it`);
  });
});

describe('and no reader honours it — the behaviour, not only the spelling', () => {
  /*
   * The source sweep above proves nobody NAMES the key. These call the readers, because a key can be read
   * without being spelled — a computed name, a spread, a loop over a field list. Moved here in `Q-45.4` from
   * the five files that each asserted one reader's half of this rule, so the rule has one home.
   *
   * Every one of these is the same failure pointing a different way: a leftover read of a key nothing writes
   * would suppress (or fail to sweep) a record on a stale field nobody set.
   */
  let S, R, W, K, M, I;
  before(async () => {
    S = await import('../../server/dist/brain/suppress-embeddings.js');
    R = await import('../../server/dist/brain/reembed.js');
    W = await import('../../server/dist/brain/suppression-sweep.js');
    K = await import('../../server/dist/config/types-knowledge.js');
    M = await import('../../server/dist/mcp/tools/shared.js');
    I = await import('../../server/dist/api/sync/_shared.js');
  });

  /** Every record kind, derived — with a floor, because an empty list passes every loop below. */
  const kinds = () => {
    assert.ok(K.KNOWLEDGE_TYPES.length >= 4, `only ${K.KNOWLEDGE_TYPES.length} knowledge types found`);
    return K.KNOWLEDGE_TYPES;
  };

  it('the input parser does not read it as an alias', () => {
    assert.deepEqual(S.parseRecordSuppression({ [LEGACY]: true }), { ok: true, value: undefined },
      'the retired spelling is still read as input, so a caller is told 201 for a field nothing applies');
  });

  it('the stored-record reader does not fall back to it', () => {
    assert.equal(S.recordSuppression({ [LEGACY]: true }), undefined,
      'a record carrying only the retired key still reads as suppressed');
  });

  it('the re-embed sweep does not exclude on it, for any kind', () => {
    for (const kind of kinds()) {
      const r = R.suppressionExclusion(undefined, kind);
      assert.ok(!JSON.stringify(r).includes(LEGACY),
        `${kind}: the exclusion still filters on the retired key, narrowing a sweep that should reach everything`);
    }
  });

  it('the suppression sweep does not select on it, for any kind', () => {
    for (const kind of kinds()) {
      assert.ok(!JSON.stringify(W.suppressedWithVectorFilter({}, kind)).includes(LEGACY),
        `${kind}: the sweep still honours the retired key, so a stale field strips a vector nobody asked to remove`);
    }
  });

  it('no ingest schema declares it, so push strips it', () => {
    for (const [name, schema] of incomingSchemas(I)) {
      assert.ok(!Object.prototype.hasOwnProperty.call(schema.shape, LEGACY),
        `${name} still declares the pre-3.1.0 spelling — it would be accepted and never read`);
    }
  });

  it('and the MCP parameter description does not offer it', () => {
    // A description is what an agent constructs arguments from; naming the old spelling there invites it.
    assert.ok(!M.SUPPRESS_EMBEDDINGS_SCHEMA.description.includes(LEGACY),
      'the suppressEmbeddings description still names the retired spelling');
  });
});

describe('and the release gate holds the version it may ship under', () => {
  it('a tag below 4.0 is refused while the key is gone', () => {
    /*
     * The protection that replaced an always-on gate. Asserted on the check's presence rather than by
     * running it, because running it means minting a fake manifest — and the shape being protected is that
     * somebody does not quietly delete the check while removing something else.
     */
    const gate = stripComments(readFileSync('scripts/release-gate.mjs', 'utf8'));
    assert.match(gate, /checkStoredShapeMatchesMajor/,
      'the release gate no longer refuses a pre-4.0 tag carrying the removed stored shape');
    assert.match(gate, /major < 4/,
      'the release gate mentions the check but no longer tests the major');
  });
});
