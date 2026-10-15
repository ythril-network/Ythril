/**
 * What each door that STORES a type schema answers when it refuses one — status and words — a CHARACTERIZATION of the answers
 * BEFORE bundle-23 (`Q-215`, `Q-362`), green on base 85c4c564 and expected to be EDITED by bundle-23 where it changes them.
 *
 * ## Why this file exists before the change
 *
 * Bundle-23 builds the schema library's body from the one the inline doors use (`Q-215`), and bounds the text of every validation
 * refusal (`Q-362`). The answers of the refusing doors are today a zod error's own JSON, whole; a change to them is only reviewable
 * against a record of today's. Every expectation is a literal: derived from the server it would compare the new code with itself.
 *
 * ## What it pins
 *
 * One refused schema per door FAMILY, and the words each family answers:
 *  - **The inline doors** — the space `PATCH`, `PUT .../schema`, the single-type `PUT` (REST) and `schema_update` (MCP) — answer
 *    `400`. The REST doors' body is `{ error: <the zod issues as pretty-printed JSON text> }`; the MCP door's text is
 *    `Error (400): <the same issues text>`. The ISSUES differ only in `path`, which starts where each door's body starts.
 *  - **The library doors** (`POST /api/schema-library`) answer `400` in the same shape, with a `path` that starts at the entry's
 *    own body (`schema`, ...).
 *  - **A refusal stores nothing**, read from the instance after the call.
 *
 * And the ONE difference between the families that bundle-23 closes: a namingPattern that can backtrack exponentially is REFUSED
 * by every inline door and ACCEPTED by the library (its body is a plain length check). The pin records the accepted entry.
 *
 * ## MCP pins fail rather than skip
 *
 * `mongoSkipReason()` skips on a laptop and THROWS under CI, so a runner without the test Mongo fails this file. `schema_update` is
 * driven through its tool handler, the function the MCP transport calls.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-schema-refusal-has-the-words-it-has-pinned-before-bundle-23-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, openTestMongo, closeTestMongo } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance, INLINE_DOORS } from './_schema-doors.mjs';

const dir = tempInstanceDir('ythril-schema-words-');
const skip = await mongoSkipReason();
const SPACE = 'words';

/** A pattern one character over the 500 the schema allows, and one that backtracks exponentially. Literals. */
const TOO_LONG = 'x'.repeat(501);
const TOO_RISKY = '(a+)+$';
const tooBig = (path) => ({ origin: 'string', code: 'too_big', maximum: 500, inclusive: true, path, message: 'Too big: expected string to have <=500 characters' });
const RISKY_MESSAGE = 'this pattern cannot be evaluated: a quantified group that contains a quantifier (or an alternation) can backtrack exponentially, '
  + 'so it would never be applied and every value would be rejected. Rewrite it without the quantified group — a character class usually does the same job.';

/** Where each inline door's body starts, so the issue's `path` is the one each door answers. */
const INLINE_PATH = {
  'space-patch': ['meta', 'typeSchemas', 'entity', 'thing', 'namingPattern'],
  'put-schema': ['typeSchemas', 'entity', 'thing', 'namingPattern'],
  'put-single-type': ['namingPattern'],
  'mcp-schema-update': ['meta', 'typeSchemas', 'entity', 'thing', 'namingPattern'],
};

/** The body of a REST refusal is `{ error }` and the MCP text is `Error (400): ` and the same issues text. Returns the issues text. */
function issuesText(door, answer) {
  if (door === 'mcp-schema-update') {
    assert.ok(answer.text.startsWith('Error (400): '), answer.text);
    return answer.text.slice('Error (400): '.length);
  }
  assert.deepEqual(Object.keys(answer.body), ['error'], `the REST refusal body is not { error }: ${answer.text}`);
  return answer.body.error;
}

describe('a refused type schema, in the words each door answers before bundle-23', { skip }, () => {
  let inst;
  before(async () => {
    await openTestMongo('pinschemawords');
    inst = await bootSchemaInstance(dir, {
      spaces: [
        { id: SPACE, label: 'Words', folders: [], meta: { validationMode: 'strict' } },
        { id: 'general', label: 'General', builtIn: true, folders: [] },
      ],
      library: [],
    });
  });
  after(async () => { inst?.close(); await closeTestMongo(); });

  it('the harness reaches every inline door (a floor)', () => {
    assert.deepEqual([...INLINE_DOORS].sort(), Object.keys(INLINE_PATH).sort());
  });

  describe('the inline doors: 400, the zod issues as text, and nothing stored', () => {
    for (const door of INLINE_DOORS) {
      it(`${door}: a namingPattern over 500 characters`, async () => {
        inst.reset();
        const held = inst.heldTypes(SPACE);
        const out = await inst.doors[door](SPACE, { typeSchemas: { entity: { thing: { namingPattern: TOO_LONG } } } });
        assert.equal(out.status, 400, out.text);
        assert.deepEqual(JSON.parse(issuesText(door, out)), [tooBig(INLINE_PATH[door])]);
        assert.deepEqual(inst.heldTypes(SPACE), held, `${door}: a refused schema was stored`);
      });

      it(`${door}: a pattern that backtracks exponentially, refused with its own sentence`, async () => {
        inst.reset();
        const held = inst.heldTypes(SPACE);
        const out = await inst.doors[door](SPACE, { typeSchemas: { entity: { thing: { namingPattern: TOO_RISKY } } } });
        assert.equal(out.status, 400, out.text);
        assert.deepEqual(JSON.parse(issuesText(door, out)), [{ code: 'custom', path: INLINE_PATH[door], message: RISKY_MESSAGE }]);
        assert.deepEqual(inst.heldTypes(SPACE), held);
      });
    }

    it('the issues text is the zod error pretty-printed, two spaces to a level', async () => {
      inst.reset();
      const out = await inst.doors['put-single-type'](SPACE, { typeSchemas: { entity: { thing: { namingPattern: TOO_LONG } } } });
      assert.equal(out.body.error, JSON.stringify([tooBig(['namingPattern'])], null, 2));
    });
  });

  describe('the library doors: 400, the zod issues as text on the entry\'s own paths, and nothing stored', () => {
    const entry = (schema, name = 'wordslib') => ({ name, knowledgeType: 'entity', typeName: 'thing', schema });

    it('POST: a namingPattern over 500 characters', async () => {
      inst.reset();
      const out = await inst.library.post(entry({ namingPattern: TOO_LONG }));
      assert.equal(out.status, 400, out.text);
      assert.deepEqual(Object.keys(out.body), ['error']);
      assert.deepEqual(JSON.parse(out.body.error), [tooBig(['schema', 'namingPattern'])]);
      assert.deepEqual(inst.heldEntries(), []);
    });

    it('POST: an unknown key in the schema', async () => {
      inst.reset();
      const out = await inst.library.post(entry({ bogusKey: 1 }));
      assert.equal(out.status, 400, out.text);
      assert.deepEqual(JSON.parse(out.body.error), [
        { code: 'unrecognized_keys', keys: ['bogusKey'], path: ['schema'], message: 'Unrecognized key: "bogusKey"' },
      ]);
      assert.deepEqual(inst.heldEntries(), []);
    });
  });

  describe('the one difference between the families', () => {
    it('a library entry whose namingPattern backtracks exponentially is ACCEPTED and stored, where every inline door refuses it', async () => {
      inst.reset();
      const out = await inst.library.post({ name: 'wordsrisky', knowledgeType: 'entity', typeName: 'thing', schema: { namingPattern: TOO_RISKY } });
      assert.equal(out.refused, false, `the library refused a risky pattern: ${out.text}`);
      assert.equal(out.status, 201, out.text);
      assert.equal(inst.heldEntry('wordsrisky')?.schema?.namingPattern, TOO_RISKY);
      for (const door of INLINE_DOORS) {
        inst.reset();
        const refused = await inst.doors[door](SPACE, { typeSchemas: { entity: { thing: { namingPattern: TOO_RISKY } } } });
        assert.equal(refused.refused, true, `${door} accepted the pattern the library accepted`);
      }
    });
  });
});
