/**
 * A meta key a caller sets by a door is the key the space then holds — on the REST PATCH and on MCP `schema_update` alike (`Q-217`).
 *
 * ## What was found
 *
 * Two keys of `SpaceMeta` answered success and stored nothing, by two different mechanisms, and neither was visible from outside:
 *
 * - `stampSkew`: not in `SpaceMetaBody`, so the strict body refused it — on every door, and a hand-edited `config.json` was the only
 *   way to set a field the docs call writable;
 * - `whenDuePasses`: in the body, in the rights table, declared on the MCP tool — and absent from the six fields `mergeSpaceMeta`
 *   copies, so the PATCH parsed it, answered 200 and wrote the meta without it. (MCP `schema_update` forwards what its schema
 *   declares and so reached the same merge.)
 *
 * The merge-kind table (`a-meta-field-keeps-its-merge-kind-through-every-merge.test.js`) holds the merge functions; this holds the DOORS,
 * which is where a caller meets the defect. The keys are the settable keys of the `SpaceMeta` interface, read from the source, so a key
 * added to the type is on the hook the day it is added: its sample goes in the table below or this fails.
 *
 * Run: node --test testing/standalone/a-meta-field-set-on-a-door-is-the-field-stored-db.test.js
 * (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { stripComments } from './_strip-comments.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { parseSource, ts } from '../_shared/syntax-tree.mjs';

const dir = tempInstanceDir('ythril-meta-door-');
const skip = await mongoSkipReason();
const SPACE = 'sch';

/** A value a caller would send for each key, different from what the space is seeded with. Literal: it is the request, not a rule. */
const SAMPLES = {
  purpose: 'a purpose that says what the space is for',
  usageNotes: 'notes for the people who use it',
  validationMode: 'warn',
  strictLinkage: false,
  suppressEmbeddings: true,
  whenDuePasses: 'nothing',
  stampSkew: { warnMinutes: 5, properties: ['stampedAt'] },
  typeSchemas: { entity: { Door: { namingPattern: '^[A-Z]' } } },
  // F-46: added with the key (SpaceMeta.rules), as this table asks of every key added to SpaceMeta.
  rules: { door: { rule: "self.description != 'forbidden'", message: 'not that description' } },
};

/** The doors, and the keys each does not carry by design (with the reason). */
const DOORS = [
  ['space-patch', {}],
  ['mcp-schema-update', { purpose: 'MCP writes the directive through update_space; schema_update carries the other meta keys' }],
];

function interfaceKeys(file, name) {
  const sf = parseSource(file, stripComments(readFileSync(join(REPO_ROOT, file), 'utf8')));
  let keys = null;
  sf.forEachChild(function visit(node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      keys = node.members.filter(m => m.name).map(m => m.name.getText(sf).replace(/^['"]|['"]$/g, ''));
      return;
    }
    ts.forEachChild(node, visit);
  });
  assert.ok(keys, `${file} no longer declares interface ${name}`);
  return keys;
}

describe('a meta key set by a door is the key stored', { skip }, () => {
  let inst, settable;
  before(async () => {
    await openTestMongo('meta_door');
    const { SERVER_OWNED_META_FIELDS } = await import('../../server/dist/spaces/body-schemas.js');
    settable = interfaceKeys('server/src/config/types-knowledge.ts', 'SpaceMeta').filter(k => !SERVER_OWNED_META_FIELDS.includes(k));
    inst = await bootSchemaInstance(dir, { spaces: [{ id: SPACE, label: 'Schema', folders: [], meta: { validationMode: 'strict' } }] });
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  it('every settable key has a sample (a key added to SpaceMeta is decided here or this fails)', () => {
    assert.ok(settable.length >= 7, `only ${settable.length} settable keys read from interface SpaceMeta`);
    assert.deepEqual(settable.filter(k => !(k in SAMPLES)), [], 'SpaceMeta gained a settable key with no sample here');
  });

  for (const [door, notCarried] of DOORS) {
    describe(door, () => {
      for (const key of Object.keys(SAMPLES)) {
        const why = notCarried[key];
        it(`${key}${why ? ' (not carried by this door)' : ''}: set by the door, held by the space`, { skip: why ?? false }, async () => {
          assert.ok(settable.includes(key), `${key} is not a settable SpaceMeta key — the sample table is stale`);
          inst.reset();
          const answer = await inst.doors[door](SPACE, { [key]: structuredClone(SAMPLES[key]) });
          assert.equal(answer.refused, false, `${door} refused ${key}: ${answer.text.slice(0, 300)}`);
          assert.deepEqual(inst.heldMeta(SPACE)[key], SAMPLES[key],
            `${door} answered ${answer.status} for ${key} and the space does not hold it (${JSON.stringify(inst.heldMeta(SPACE)[key])}): a write that reports success for a value it did not store`);
        });
      }
    });
  }

  it('the two doors store the same meta for the same request (the pair compared, not each against a literal)', async () => {
    const stored = {};
    for (const [door] of DOORS) {
      inst.reset();
      const { purpose: _p, ...meta } = SAMPLES;
      const answer = await inst.doors[door](SPACE, structuredClone(meta));
      assert.equal(answer.refused, false, `${door}: ${answer.text.slice(0, 300)}`);
      const { version: _v, updatedAt: _u, previousVersions: _h, ...held } = inst.heldMeta(SPACE);
      stored[door] = held;
    }
    assert.deepEqual(stored['mcp-schema-update'], stored['space-patch'], 'REST and MCP stored different metas for one request');
  });
});
