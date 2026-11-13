/**
 * Two schema versions are compared text to text, per type, in four classes, and a place neither side could read is never "same"
 * (bundle-267, Q-741/Q-742; design r3 §2, §7 pure; probe 1 M as amended A1-A3).
 *
 * ## The contract these cases are written against (before the code exists)
 *
 * - `server/dist/spaces/schema-version-text.js` `versionMetaOf(text)`: the stored-tolerant parse of a snapshot text (readStoredMeta's
 *   tolerance, stored rules not recompiled) answering `{ meta, unread }`, where `unread` names every place the tolerance dropped (an
 *   unknown key, a type that no longer parses). `null` for text that is not JSON or not format 1.
 * - `server/dist/spaces/schema-diff.js`:
 *   - `SCHEMA_DIFF_CLASSES`: the class of every key of every zod object a version text holds, one table per object, named by its
 *     path (`type`, `type.propertySchemas.*`, `type.retention`, `type.endpoints`, `type.rules.*`, `spaceRule`); each value is
 *     `structural | wording | write | lifecycle`, or `nested` for a key whose own table classes its parts.
 *   - `keyClass(table, key)`: the table's class, and `structural` for a key the table does not know (fail toward showing).
 *   - `schemaVersionDiff(fromText, toText)`: `{ types: [{ kind, type, changes: [{ place, from, to, class }] }], spaceRules, allowlists:
 *     [{ kind, from, to }], unread }`.
 *   - `typesDifferingUnder(fromText, toText, mode)` (mode `structural | any`): `{ kinds: Map<kind, Set<type> | 'all'>, unclassified }`,
 *     memoised per process by the pair and the mode (bounded at 256 pairs).
 *
 * ## Why each case can fail for a real defect
 *
 * The class table is derived from the zod shapes here, recursively, so a key added to `PropertySchemaZ` (or to the nested endpoints
 * or rule entries) with no class is a red, not a silent "structural". The per-type cases build real canonical texts with the
 * schema package's own `schemaFingerprintTextOf` and read the classification back, so a classifier that compares the parsed metas
 * instead of the texts, flattens a space rule onto one type, or reads an allowlist change as "no change" fails.
 *
 * ## Seen red
 *
 * At b299cde3 neither module exists: every case fails on the missing module (new code).
 *
 * Run: node --test testing/standalone/a-schema-version-diff-says-what-changed-per-type.test.js (after npm run build)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const schemaPkg = await import('../../schema/dist/index.js');
const { schemaFingerprintTextOf } = await import('../../schema/dist/internal.js');
const { KNOWLEDGE_TYPES } = await import('../../server/dist/config/types-knowledge.js');

const load = async (rel) => {
  try { return await import(`../../server/dist/spaces/${rel}`); } catch (err) { return { __missing: err }; }
};
let diff, text;
before(async () => {
  diff = await load('schema-diff.js');
  text = await load('schema-version-text.js');
});
const need = (mod, name) => {
  assert.ok(!mod.__missing, `server/dist/spaces module for ${name} does not load: ${mod.__missing?.code ?? mod.__missing}`);
  assert.equal(typeof mod[name], name === 'SCHEMA_DIFF_CLASSES' ? 'object' : 'function', `${name} is not exported`);
  return mod[name];
};

const textOf = (meta) => schemaFingerprintTextOf(meta);
const ent = (types) => ({ typeSchemas: { entity: types } });
const differs = (answer, kind, type) => {
  const k = answer.kinds.get(kind);
  return k === 'all' || (k instanceof Set && k.has(type));
};

// ── the class table, derived from zod ─────────────────────────────────────────────────────────────────────────────────────────────

/** Through the wrappers zod puts around an object: optional, nullable, default, a preprocess (pipe). */
function inner(schema) {
  let s = schema;
  for (let i = 0; i < 12; i++) {
    const d = s?._zod?.def;
    if (!d) return s;
    if (d.type === 'optional' || d.type === 'nullable' || d.type === 'default') s = d.innerType;
    else if (d.type === 'pipe') s = d.out;
    else return s;
  }
  return s;
}

/** Every zod object a version text holds, by path, with its keys: nested objects as `<path>.<key>`, a record's values as `<path>.<key>.*`. */
function tablesOf(name, schema, out = new Map()) {
  const s = inner(schema);
  const d = s?._zod?.def;
  if (d?.type !== 'object') return out;
  out.set(name, Object.keys(d.shape));
  for (const [k, v] of Object.entries(d.shape)) {
    const iv = inner(v);
    const id = iv?._zod?.def;
    if (id?.type === 'object') tablesOf(`${name}.${k}`, iv, out);
    else if (id?.type === 'record') tablesOf(`${name}.${k}.*`, id.valueType, out);
  }
  return out;
}

describe('the class table is total over the zod shapes a version text holds', () => {
  const derived = new Map([
    ...tablesOf('type', schemaPkg.InlineTypeSchemaZ),
    // A type's `rules` is a preprocessed map of unknowns judged by `ruleMapIssues` against TypeRuleZ: its entry shape is read from there.
    ...tablesOf('type.rules.*', schemaPkg.TypeRuleZ),
    ...tablesOf('spaceRule', schemaPkg.SpaceRuleZ),
  ]);
  const CLASSES = new Set(['structural', 'wording', 'write', 'lifecycle']);

  it('the derivation reaches every nested object (a floor, so a broken walk cannot pass as an empty table)', () => {
    for (const t of ['type', 'type.propertySchemas.*', 'type.retention', 'type.endpoints', 'type.rules.*', 'spaceRule']) {
      assert.ok(derived.has(t), `the zod walk did not reach ${t}: ${[...derived.keys()].join(', ')}`);
    }
    assert.ok(derived.get('type.propertySchemas.*').includes('mergeFn') && derived.get('spaceRule').includes('kinds'));
  });

  it('every derived table has a class for exactly its keys, and every class is one of the four (or nested, where a table exists)', () => {
    const table = need(diff, 'SCHEMA_DIFF_CLASSES');
    for (const [name, keys] of derived) {
      assert.ok(table[name] && typeof table[name] === 'object', `SCHEMA_DIFF_CLASSES has no table ${name}`);
      assert.deepEqual(Object.keys(table[name]).sort(), [...keys].sort(), `table ${name} does not class exactly the keys zod declares`);
      for (const k of keys) {
        const c = table[name][k];
        const nestedOk = c === 'nested' && (derived.has(`${name}.${k}`) || derived.has(`${name}.${k}.*`));
        assert.ok(CLASSES.has(c) || nestedOk, `${name}.${k} is classed ${JSON.stringify(c)}`);
      }
    }
  });

  it('a key a table does not know is structural, so a key added without a class is shown, never hidden', () => {
    const keyClass = need(diff, 'keyClass');
    assert.equal(keyClass('type.propertySchemas.*', 'aKeyNoReleaseHasYet'), 'structural');
    assert.equal(keyClass('type.propertySchemas.*', 'description'), 'wording', 'a known key must answer its own class, not the fallback');
  });
});

describe('the per-type diff', () => {
  const A = { propertySchemas: { p: { type: 'string' } } };
  const B = { propertySchemas: { x: { type: 'number' } } };

  it('a rename on A changes A structurally and leaves B out', () => {
    const typesDifferingUnder = need(diff, 'typesDifferingUnder');
    const schemaVersionDiff = need(diff, 'schemaVersionDiff');
    const from = textOf(ent({ A, B }));
    const to = textOf(ent({ A: { propertySchemas: { q: { type: 'string' } } }, B }));
    const d = schemaVersionDiff(from, to);
    const rowA = d.types.find(t => t.kind === 'entity' && t.type === 'A');
    assert.ok(rowA?.changes.some(c => c.class === 'structural'), `A's rename is not structural: ${JSON.stringify(d.types)}`);
    assert.equal(d.types.find(t => t.type === 'B'), undefined, 'B did not change and is listed');
    const s = typesDifferingUnder(from, to, 'structural');
    assert.ok(differs(s, 'entity', 'A') && !differs(s, 'entity', 'B'));
  });

  it('a description, a rule message, a merge function and a retention change are not structural; each is in `any`', () => {
    const typesDifferingUnder = need(diff, 'typesDifferingUnder');
    const schemaVersionDiff = need(diff, 'schemaVersionDiff');
    const base = { ...A, rules: { named: { rule: 'self.name != ""', message: 'needs a name' } } };
    const cases = {
      wording: { ...base, description: 'now described' },
      'wording (rule message)': { ...base, rules: { named: { rule: 'self.name != ""', message: 'a name, please' } } },
      write: { ...base, propertySchemas: { p: { type: 'number', mergeFn: 'max' } } },
      lifecycle: { ...base, retention: { days: 30 } },
    };
    // `write` changes the type too (string -> number): its own row must still name the mergeFn change as write.
    for (const [want, def] of Object.entries(cases)) {
      const from = textOf(ent({ A: base, B })), to = textOf(ent({ A: def, B }));
      const row = schemaVersionDiff(from, to).types.find(t => t.type === 'A');
      const cls = want.split(' ')[0];
      assert.ok(row?.changes.some(c => c.class === cls), `${want}: no ${cls} change on A: ${JSON.stringify(row)}`);
      assert.ok(differs(typesDifferingUnder(from, to, 'any'), 'entity', 'A'), `${want}: A is not in any`);
      if (want !== 'write') assert.ok(!differs(typesDifferingUnder(from, to, 'structural'), 'entity', 'A'), `${want}: A is structural`);
    }
  });

  it('a changed rule expression is structural', () => {
    const typesDifferingUnder = need(diff, 'typesDifferingUnder');
    const r = (rule) => ent({ A: { ...A, rules: { named: { rule, message: 'm' } } }, B });
    assert.ok(differs(typesDifferingUnder(textOf(r('self.name != ""')), textOf(r('size(self.name) > 2')), 'structural'), 'entity', 'A'));
  });

  it('a space rule makes every type of the kinds it governs differ, old kinds and new, untyped records included (A1)', () => {
    const typesDifferingUnder = need(diff, 'typesDifferingUnder');
    const rule = (kinds) => ({ tagged: { rule: 'size(self.tags) > 0', message: 'tag it', ...(kinds ? { kinds } : {}) } });
    const types = { entity: { A }, fact: { F: { propertySchemas: { f: { type: 'string' } } } }, edge: { knows: {} } };
    const from = textOf({ typeSchemas: types, rules: rule(['entity']) });
    const to = textOf({ typeSchemas: types, rules: rule(['entity', 'fact']) });
    const s = typesDifferingUnder(from, to, 'structural');
    assert.equal(s.kinds.get('entity'), 'all', 'an old kind of the changed rule is not all');
    assert.equal(s.kinds.get('fact'), 'all', 'a new kind of the changed rule is not all');
    assert.ok(!differs(s, 'edge', 'knows'), 'a kind the rule never governed differs');
    // Absent kinds = every kind (spaceRuleKinds): a rule added with no kinds reaches every knowledge type.
    const all = typesDifferingUnder(textOf({ typeSchemas: types }), textOf({ typeSchemas: types, rules: rule(undefined) }), 'structural');
    for (const kind of KNOWLEDGE_TYPES) assert.equal(all.kinds.get(kind), 'all', `a space rule with no kinds does not reach ${kind}`);
    // Its message alone is wording: no kind in structural, every governed kind in any.
    const msg = (m) => textOf({ typeSchemas: types, rules: { tagged: { rule: 'size(self.tags) > 0', message: m, kinds: ['fact'] } } });
    assert.equal(typesDifferingUnder(msg('one'), msg('two'), 'structural').kinds.size, 0, 'a space rule message is structural');
    assert.equal(typesDifferingUnder(msg('one'), msg('two'), 'any').kinds.get('fact'), 'all');
  });

  it('a kind that gains its first declared type differs for every type of that kind, declared or not (A2)', () => {
    const typesDifferingUnder = need(diff, 'typesDifferingUnder');
    const schemaVersionDiff = need(diff, 'schemaVersionDiff');
    const from = textOf(ent({ A }));
    const to = textOf({ typeSchemas: { entity: { A }, fact: { F: { propertySchemas: { f: { type: 'string' } } } } } });
    assert.equal(typesDifferingUnder(from, to, 'structural').kinds.get('fact'), 'all', 'a fact of an undeclared type is valid under one and refused under the other');
    assert.ok(!differs(typesDifferingUnder(from, to, 'structural'), 'entity', 'A'));
    assert.ok(schemaVersionDiff(from, to).allowlists.some(a => a.kind === 'fact' && a.from !== a.to), 'the allowlist change is not shown');
  });

  it('a peer variation that defines a type the same is not older for that type, under either mode', () => {
    const typesDifferingUnder = need(diff, 'typesDifferingUnder');
    const C = { propertySchemas: { c: { type: 'number' } } };
    const D = { propertySchemas: { d: { type: 'boolean' } } };
    for (const mode of ['structural', 'any']) {
      const s = typesDifferingUnder(textOf(ent({ A, D })), textOf(ent({ A, C })), mode);
      assert.ok(!differs(s, 'entity', 'A'), `${mode}: A is defined the same and differs`);
      assert.ok(differs(s, 'entity', 'C') && differs(s, 'entity', 'D'), `${mode}: C or D does not differ`);
    }
  });
});

describe('what the tolerant parse cannot read is unclassified, never "same"', () => {
  it('an unknown key in a newer text is named in unread, and the pair is unclassified though the read metas are equal', () => {
    const versionMetaOf = need(text, 'versionMetaOf');
    const typesDifferingUnder = need(diff, 'typesDifferingUnder');
    const schemaVersionDiff = need(diff, 'schemaVersionDiff');
    const plain = textOf(ent({ A: { propertySchemas: { p: { type: 'string' } } } }));
    // A newer release's key: canonical text written by hand, as a newer peer would send it.
    const newer = textOf(ent({ A: { propertySchemas: { p: { type: 'string', aKeyFromANewerRelease: 'x' } } } }));
    assert.notEqual(newer, plain);
    const read = versionMetaOf(newer);
    assert.ok(read.unread.some(p => String(p).includes('aKeyFromANewerRelease')), `unread does not name the dropped key: ${JSON.stringify(read.unread)}`);
    assert.ok(typesDifferingUnder(newer, plain, 'structural').unclassified, 'two different texts with an empty diff and an unread place were answered same');
    assert.ok(schemaVersionDiff(newer, plain).unread.length > 0);
  });

  it('a type the stored parse skips is named in unread', () => {
    const versionMetaOf = need(text, 'versionMetaOf');
    const bad = textOf(ent({ A: { propertySchemas: { p: { type: 'string' } } }, Bad: { namingPattern: '(' } }));
    const read = versionMetaOf(bad);
    assert.ok(read.meta.typeSchemas.entity.A, 'the readable type was dropped with the unreadable one');
    assert.ok(read.unread.some(p => String(p).includes('Bad')), `unread does not name the skipped type: ${JSON.stringify(read.unread)}`);
  });
});

describe('versionMetaOf', () => {
  it('round-trips a text whose stored rule no longer compiles: the type and rule are kept, and the text re-canonicalises to itself', () => {
    const versionMetaOf = need(text, 'versionMetaOf');
    const meta = ent({ A: { propertySchemas: { p: { type: 'string' } }, rules: { broken: { rule: 'self.name ==', message: 'a rule a newer parser refuses' } } } });
    const t = textOf(meta);
    const read = versionMetaOf(t);
    assert.ok(read, 'a stored text was refused');
    assert.deepEqual(read.unread, [], 'a stored rule that does not compile was reported unread: the parse is not the stored one');
    assert.equal(textOf(read.meta), t, 'the parsed meta does not give back the text');
  });

  it('answers null for text that is not JSON or not format 1', () => {
    const versionMetaOf = need(text, 'versionMetaOf');
    assert.equal(versionMetaOf('not json'), null);
    assert.equal(versionMetaOf(JSON.stringify({ format: 2, typeSchemas: {}, rules: {} })), null);
  });
});

describe('the diff memo', () => {
  it('answers the same classification for the same pair and mode, and is bounded', () => {
    const typesDifferingUnder = need(diff, 'typesDifferingUnder');
    const v = (n) => textOf(ent({ [`T${n}`]: { propertySchemas: { p: { type: 'string' } } } }));
    const first = typesDifferingUnder(v(0), v(1), 'structural');
    assert.equal(typesDifferingUnder(v(0), v(1), 'structural'), first, 'the same pair was classified twice');
    assert.notEqual(typesDifferingUnder(v(0), v(1), 'any'), first, 'the mode is not part of the key');
    for (let i = 2; i < 2 + 300; i++) typesDifferingUnder(v(0), v(i), 'structural');
    const again = typesDifferingUnder(v(0), v(1), 'structural');
    assert.notEqual(again, first, 'the memo held 300 newer pairs and the first: it is not bounded');
    assert.deepEqual([...again.kinds.entries()].map(([k, s]) => [k, s === 'all' ? s : [...s].sort()]),
      [...first.kinds.entries()].map(([k, s]) => [k, s === 'all' ? s : [...s].sort()]));
  });
});
