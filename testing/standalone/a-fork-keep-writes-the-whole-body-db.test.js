/**
 * Keeping a side makes the parent say exactly what that side said (Q-624 design §9, test 8).
 *
 * ## What it prevents
 *
 * Bundle-81's resolve copied the fork's body onto the parent field by field, by a list the resolve code kept (`fact`, `tags`,
 * `description`, `properties`, `type`). Q-624 widens the divergence rule to the WHOLE body of every kind (`authoredContentHash`), so a
 * field the hash compares and the keep does not write is a fork that "keep this version" leaves standing in spirit: the parent still
 * differs from the version the user chose, and the next sync forks it again. The keep-writer builds one `$set`/`$unset` over
 * `BODY_FIELDS_OF[kind]`, which includes `superseded`, `suppressEmbeddings` and `type` that the doors' `SYSTEM_FIELDS` refusal keeps away
 * from callers.
 *
 * ## The fields are derived INDEPENDENTLY of the thing under test
 *
 * A test that read its field list from `BODY_FIELDS_OF` would assert the table equals itself. The fields a body can hold are read from
 * what an author can WRITE: the keys of the kind's `update_*` tool schema (the door write schema), and the fields the record type
 * declares in `config/types.ts`, less what no author writes (the version metadata, the derived and local-only fields); plus the three the
 * doors refuse and the keep must still carry: `superseded`, `suppressEmbeddings`, `type`.
 *
 * ## Two assertions
 *
 *  1. `BODY_FIELDS_OF[family]` covers every one of them: a field the doors write and the hash ignores fails here;
 *  2. for each field, a fork that differs from its parent ONLY there makes `keep: 'fork'` leave the parent's body hash equal to the
 *     fork's, and `keep: 'parent'` leave it equal to the parent's own.
 *
 * A field the sample table has no values for fails by name, so a new field cannot be skipped by omission.
 *
 * Run: node --test testing/standalone/a-fork-keep-writes-the-whole-body-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { FORK_KINDS, initForkFixtures, seedFork, reviewDoors } from './_q624-fork-fixtures.mjs';
import { stripComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();
const S = 'q624keep';

/** The update tool of each kind, and the interface its record type is declared by in `config/types.ts`. */
const SOURCES = {
  fact: { tool: 'update_fact', iface: 'FactDoc' },
  entity: { tool: 'update_entity', iface: 'EntityDoc' },
  chrono: { tool: 'update_chrono', iface: 'ChronoEntry' },
  edge: { tool: 'update_edge', iface: 'EdgeDoc' },
};
/** What no author writes: version metadata, the derived fields a local model fills, retention stamps and the redaction marks. */
const NOT_AUTHORED = new Set(['_id', 'spaceId', 'seq', 'createdAt', 'updatedAt', 'author', 'forkOf', 'embedding', 'embeddingModel', 'matchedText',
  '_expireAt', '_contentExpireAt', 'contentRedacted', 'contentRedactedAt', 'from', 'to', 'fromKind', 'toKind', 'label']);
/** Arguments of an update tool that are not body: the target, the guards, the link sets, the retention. */
const CONTROL_ARGS = new Set(['space', 'id', 'ifMatchSeq', 'deleteFields', 'ttlDays', 'linkEntities', 'linkFacts', 'edges', 'links', 'targetSpace', 'dryRun']);
/** Always in the body and refused by the doors' SYSTEM_FIELDS, so the keep is the only writer of them. */
const SYSTEM_BODY = ['superseded', 'suppressEmbeddings', 'type'];

/** [parent's value, the fork's value] per field: the two differ in nothing else. */
const SAMPLES = {
  fact: ['the parent says this', 'the fork says that'],
  name: ['Parent Name', 'Fork Name'],
  title: ['Parent title', 'Fork title'],
  description: ['parent description', 'fork description'],
  tags: [['p'], ['f']],
  properties: [{ colour: 'red' }, { colour: 'blue' }],
  type: ['note', 'decision'],
  superseded: [false, true],
  suppressEmbeddings: [false, true],
  startsAt: ['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'],
  endsAt: ['2026-01-02T00:00:00.000Z', '2026-02-02T00:00:00.000Z'],
  status: ['upcoming', 'cancelled'],
  confidence: [0.4, 0.9],
  recurrence: [{ freq: 'daily', interval: 1 }, { freq: 'weekly', interval: 2 }],
  weight: [1, 2],
};

describe('a fork keep writes the whole body', { skip }, () => {
  let door; let doors; let leaf; let ALL_TOOLS; let localOnly;

  before(async () => {
    door = await openPushDoor({ suite: 'q624t3_keep', spaces: [{ id: S, label: 'Keep', folders: [], meta: {} }] });
    await initForkFixtures();
    doors = await reviewDoors(door, S);
    leaf = await import('../../server/dist/sync/authored-content.js').catch(() => undefined);
    ({ ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js'));
    ({ LOCAL_ONLY_FIELDS: localOnly } = await import('../../server/dist/sync/local-only-fields.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  /** The fields an author can write into `kind`, read from the door's write schema and the record type, never from the hash's table. */
  function authoredFields(kind) {
    const { tool, iface } = SOURCES[kind];
    const t = ALL_TOOLS.find(x => x.name === tool);
    assert.ok(t, `no ${tool} tool: re-anchor the door-schema half of the field derivation`);
    const fromDoor = Object.keys(t.inputSchema({ requiredSpace: {}, optionalSpace: {} }).properties ?? {}).filter(k => !CONTROL_ARGS.has(k));
    const types = stripComments(fs.readFileSync('server/src/config/types.ts', 'utf8'));
    const m = types.match(new RegExp(`export interface ${iface}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`));
    assert.ok(m, `no interface ${iface} in config/types.ts: re-anchor the declared-fields half of the derivation`);
    const declared = [...m[1].matchAll(/^\s{2}([A-Za-z_]+)\??:/gm)].map(x => x[1]);
    const fields = new Set([...fromDoor, ...declared, ...SYSTEM_BODY].filter(f => !NOT_AUTHORED.has(f) && !localOnly.has(f)));
    assert.ok(fields.size >= 5, `${kind}: only ${fields.size} authored field(s) derived (${[...fields]}): the derivation is broken`);
    return [...fields].sort();
  }

  for (const kind of Object.keys(FORK_KINDS)) {
    const k = FORK_KINDS[kind];

    it(`${kind}: BODY_FIELDS_OF covers every field an author can write`, () => {
      assert.ok(leaf, 'sync/authored-content.js does not exist: BODY_FIELDS_OF and authoredContentHash are the leaf of design §2');
      const covered = new Set(leaf.BODY_FIELDS_OF[k.family] ?? []);
      const missing = authoredFields(kind).filter(f => !covered.has(f));
      assert.deepEqual(missing, [], `${kind}: a field the doors write is outside the body the hash compares and the keep writes: ${missing}`);
    });

    it(`${kind}: the sample table has a pair for every derived field (a fixture guard: it passes before the change)`, () => {
      const missing = authoredFields(kind).filter(f => !SAMPLES[f]);
      assert.deepEqual(missing, [], `${kind}: add a sample pair for ${missing}`);
    });

    it(`${kind}: for each field, a fork that differs only there is made the parent's body by keep 'fork'`, async () => {
      const fields = authoredFields(kind);
      for (const field of fields) {
        const sample = SAMPLES[field];
        assert.ok(sample, `${kind}: no sample values for the field '${field}': add its pair to SAMPLES so the field is driven`);
        await door.wipe(S);
        const id = `p-${field}`;
        const parent = k.row(S, id, 5, { [field]: sample[0] });
        await door.coll(S, k.family).insertOne(parent);
        const fork = await seedFork(door, S, kind, id, 5, { [field]: sample[1] });
        const r = await doors.resolve.MCP(kind, fork._id, 'fork');
        assert.ok(r.ok, `${kind}.${field}: resolve refused: ${r.sentence}`);
        const stored = await door.coll(S, k.family).findOne({ _id: id });
        assert.ok(stored.seq > 5, `${kind}.${field}: the parent was not rewritten above both versions (seq ${stored.seq})`);
        assert.ok(leaf, 'sync/authored-content.js does not exist: the equality below is its hash');
        assert.equal(leaf.authoredContentHash(k.family, stored).hash, leaf.authoredContentHash(k.family, fork).hash,
          `${kind}.${field}: after keep 'fork' the parent still differs from the fork it kept: the keep-writer left '${field}' unwritten`);
      }
    });

    it(`${kind}: keep 'parent' leaves the parent saying what it said, above both versions`, async () => {
      const id = 'p-keep-parent';
      const parent = k.row(S, id, 5, {});
      await door.coll(S, k.family).insertOne(parent);
      const fork = await seedFork(door, S, kind, id, 5, k.alt);
      const r = await doors.resolve.MCP(kind, fork._id, 'parent');
      assert.ok(r.ok, `${kind}: resolve refused: ${r.sentence}`);
      const stored = await door.coll(S, k.family).findOne({ _id: id });
      assert.ok(stored.seq > 5, `${kind}: keep 'parent' did not stamp the parent above both versions (seq ${stored.seq}): a peer holding the fork's version would keep it`);
      assert.ok(leaf, 'sync/authored-content.js does not exist');
      assert.equal(leaf.authoredContentHash(k.family, stored).hash, leaf.authoredContentHash(k.family, parent).hash, `${kind}: keep 'parent' changed the parent's body`);
    });
  }
});
