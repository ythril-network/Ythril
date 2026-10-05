/**
 * The tier resolver was already tested. This tests the CALL SITE, which is where a correct resolver stops
 * mattering if it is fed the wrong arguments.
 *
 * ## Why source assertions rather than a live embed
 *
 * `embedStoredRecord` needs Mongo, a model and a space. The three things that can be wrong here are all visible
 * in the source and none of them need any of that:
 *
 *  - a FILE must skip the schema tier, because a file has no type and therefore no type schema;
 *  - the record flag must be passed as `undefined` when absent, not `false`, or it would win the resolution and
 *    the two lower tiers would never be consulted;
 *  - the suppressed branch must UNSET a stale vector, not merely decline to write a new one.
 *
 * The last is the one with teeth: leaving an old vector behind keeps the record findable by exactly the
 * mechanism the flag exists to switch off.
 *
 * Run: node --test testing/standalone/suppress-embeddings-wiring.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { suppressionBranchOf, UNSETS_THE_VECTOR } from './_suppression-branch.mjs';

const { UNSET_VECTOR } = await import('../../server/dist/sync/local-only-fields.js');

/*
 * TWO FILES, because the wiring is now split across them and each half is asserted below.
 *
 * The three-tier resolution moved into `suppress-embeddings.ts` when the record creators needed it before
 * their inline embed — `embed-record.ts` imports `edges.ts`, so holding it there put six brain modules in a
 * runtime import cycle. What stayed in `embed-record.ts` is the CONSEQUENCE: unsetting a stale vector and
 * returning `excluded`. Reading only one file would silently stop checking half of this.
 */
/** Comments must not satisfy any of these — several of them describe the very trap being asserted. */
const codeOf = f => stripComments(readFileSync(new URL(f, import.meta.url), 'utf8'));
const EMBED_RECORD = codeOf('../../server/src/brain/embed-record.ts');
const CODE = [codeOf('../../server/src/brain/suppress-embeddings.ts'), EMBED_RECORD].join('\n');

describe('the suppression decision reaches the embed path', () => {
  it('calls the shared resolver rather than re-deciding locally', () => {
    // A second copy of record > schema > space is how the order drifts from `retention`.
    assert.match(CODE, /embeddingSuppressed\(\{/);
    assert.match(CODE, /from '\.\/suppress-embeddings\.js'/);
  });

  it('passes the record flag as undefined when it is absent, never false', () => {
    // `false` at the top tier WINS, so an absent flag read as `false` would force embedding and make both lower
    // tiers dead code — the schema and space settings would exist and do nothing. The mapping itself is
    // `recordSuppression`'s, exercised in `one-switch-three-tiers-is-documented.test.js`; what this asserts is
    // that the embed path defers to it instead of spelling the rule out a second time.
    assert.match(CODE, /record:\s*recordSuppression\(doc\)/);
  });

  it('consults all three tiers', () => {
    // set-claim: the three TIERS of the suppression rule, which is a fixed record > schema > space design
    // asserted in `one-switch-three-tiers-is-documented`. This checks the call site names all three.
    for (const key of ['record:', 'schema:', 'space:']) {
      assert.ok(CODE.includes(key), `the resolver call is missing ${key}`);
    }
  });
});

describe('a file skips the schema tier', () => {
  it('narrows the record type instead of casting it', () => {
    // `BrainEmbedRecordType` includes `'file'`; `KnowledgeType` does not. A cast would compile and then index
    // `typeSchemas` with `'file'`, missing every time — suppression would look wired and never apply.
    assert.match(CODE, /recordType === 'file' \? undefined : recordType/);
    assert.ok(!/recordType as KnowledgeType/.test(CODE), 'the record type is cast rather than narrowed');
  });

  it('does not look up a schema when there is no knowledge type', () => {
    assert.match(CODE, /knowledgeType === undefined \? undefined : schemaKeyFor\(knowledgeType, doc\)/);
  });
});

describe('suppression removes a stale vector', () => {
  it('unsets both the vector and its model', () => {
    // Declining to write a new vector is not enough: the old one still answers vector search, which is the whole
    // bug the flag exists to prevent. Asserted on the SUPPRESSION branch's own block — the failure path of the same
    // function writes the same unset, so a match anywhere in the file would hold with this branch's deleted.
    assert.match(suppressionBranchOf(EMBED_RECORD), UNSETS_THE_VECTOR,
      'the suppression branch does not unset the stale vector');
    // What `UNSET_VECTOR` unsets is read from the value the product uses, not from its source text: both halves of
    // the vector are still asserted.
    assert.ok('embedding' in UNSET_VECTOR && 'embeddingModel' in UNSET_VECTOR,
      'UNSET_VECTOR must remove the vector AND the model that produced it');
  });

  it('returns a distinct outcome rather than reporting success', () => {
    // `'embedded'` here would make a suppressed record indistinguishable from an embedded one in every caller
    // and every metric. Inside the suppression branch, not merely somewhere in the file.
    assert.match(suppressionBranchOf(EMBED_RECORD), /return 'excluded';/);
  });
});

describe('the field exists on both tiers of the type', () => {
  const TYPES = readFileSync(new URL('../../server/src/config/types-knowledge.ts', import.meta.url), 'utf8');

  it('is declared on TypeSchema and on SpaceMeta', () => {
    const count = (TYPES.match(/^\s*suppressEmbeddings\?: boolean;/gm) ?? []).length;
    assert.equal(count, 2, `expected the field on both TypeSchema and SpaceMeta, found ${count}`);
  });

  it('is OPTIONAL on both, because absent must mean "not stated"', () => {
    // A required boolean would collapse the tiers: every schema would state a value and the space setting could
    // never apply.
    assert.ok(!/^\s*suppressEmbeddings: boolean;/m.test(TYPES), 'the field is required somewhere');
  });
});

describe('both write surfaces accept it', () => {
  it('the space meta body lists it, or .strict() would reject the field', () => {
    // Two files now: the field is declared with the space request bodies, and the merge guard is in the planner
    // both write surfaces call. Read together, because the pair IS the guarantee — a field the body accepts and
    // the merge drops is the same silent failure as one the body rejects.
    const spaces = ['server/src/spaces/body-schemas.ts', 'server/src/spaces/meta-update.ts']
      .map(p => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')).join('\n');
    assert.match(spaces, /suppressEmbeddings: z\.boolean\(\)\.optional\(\)/);
    // Guarded on `!== undefined`: `false` is how suppression is turned back OFF, and a truthy guard would drop
    // that patch while answering 200.
    assert.match(spaces, /if \(incoming\.suppressEmbeddings !== undefined\)/);
  });

  it('the schema LIBRARY accepts it too, so the two surfaces do not drift', () => {
    // A library entry that cannot express a field the inline schema can is a surface that silently drops it.
    const lib = readFileSync(new URL('../../server/src/api/schema-library.ts', import.meta.url), 'utf8');
    assert.match(lib, /suppressEmbeddings: z\.boolean\(\)\.optional\(\)/);
  });
});
