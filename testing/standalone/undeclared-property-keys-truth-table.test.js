/**
 * An undeclared property key — the validator's truth table (Q-93), against the REAL engine.
 *
 * ## What the rule is
 *
 * A type that declares at least one property in `propertySchemas` has a LIST of property keys. A write that adds a key
 * which is not on it is a violation: `{ field: 'properties.<key>', value, reason: "property '<key>' is not declared on this
 * type", declared: [...] }`. Until Q-93 `validatePropertiesAgainstSchema` looped over the DECLARED keys only, so a strict
 * space refused a wrong value for `status` and stored `statuz: 'x'` beside it without a word — and the schema editor
 * promised the opposite. The case in `schema-validation.test.js` that said "a property not in the schema is not rejected"
 * was inverted by hand for it.
 *
 * ## The table
 *
 * `propertySchemas` {absent, `{}`, non-empty} x `validationMode` {strict, warn, off} x the key {introduced by the write,
 * already stored on the record (pre-existing)} — for every kind that has properties (entity, edge, fact, chrono), through
 * the classifiers the writers use (`classify*UpsertAgainst`), because the question "is this key the write's fault" is the
 * classifier's (P-6: a stored key is never refused, only a key the write ADDS). The two open shapes are open on both doors:
 * an empty list is not a closed list, or every type created from the editor would refuse every property.
 *
 * Around the table: a retype (a key declared on the old type and not on the new one is introduced; undeclared on both is
 * pre-existing), a null value (absent), prototype-named keys (`Object.hasOwn`, never `in`), dotted and `$`-prefixed and
 * oversize keys (one row each; the refusal body stays bounded), an unresolvable `$ref` type (the broken-reference violation
 * and nothing about keys), a nested value (one row for the key, not one per leaf), the 20-row cap (applied AFTER the
 * classification, so a new key past the twentieth stored one is still refused), `off` evaluating nothing, and an edit of a
 * stored undeclared key's value (not the write's fault).
 *
 * ## What is not asserted
 *
 * The exact `reason` wording beyond the sentence the plan fixes, the position of the cap, and where `declared` sits on the
 * row: those are the implementation's, and a test that copied them would break on a reword and prove nothing more.
 * `declared` is only required to be on SOME row and to name the declared keys.
 *
 * Run: node --test testing/standalone/undeclared-property-keys-truth-table.test.js   (needs `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  validateEntity, validateEdge, validateFact, validateChrono, resolveMetaRefs,
} = await import('../../server/dist/spaces/schema-validation.js');
const {
  classifyEntityUpsertAgainst, classifyEdgeUpsertAgainst, classifyFactUpsertAgainst, classifyChronoUpsertAgainst,
  SchemaViolationError,
} = await import('../../server/dist/brain/write-validation.js');

/** Literal fixtures: what each kind's declaring type declares, and the key every case adds. */
const DECLARED_KEY = 'status';
const KEY = 'zzNotDeclared';
const MODES = ['strict', 'warn', 'off'];
const SHAPES = ['absent', 'empty', 'non-empty'];

/**
 * The four kinds, each with: the key its `typeSchemas` entry lives under, a way to build a record (type or label +
 * properties), the validator, and the classifier called with a stored record (`existing`, or null for an insert) and the
 * write (`incoming`). `type` is the entity type / edge label / fact type / chrono type.
 */
const KINDS = {
  entity: {
    schemaKey: 'entity',
    validate: (meta, type, properties) => validateEntity(meta, { name: 'n', type, properties }),
    classify: (meta, existing, incoming) => classifyEntityUpsertAgainst(
      meta,
      existing && { name: 'n', type: existing.type, properties: existing.properties },
      { name: 'n', type: incoming.type, properties: incoming.properties },
    ),
  },
  edge: {
    schemaKey: 'edge',
    validate: (meta, type, properties) => validateEdge(meta, { label: type, properties }),
    classify: (meta, existing, incoming) => classifyEdgeUpsertAgainst(
      meta,
      existing && { label: existing.type, properties: existing.properties },
      { label: incoming.type, properties: incoming.properties },
    ),
  },
  fact: {
    schemaKey: 'fact',
    validate: (meta, type, properties) => validateFact(meta, { type, properties }),
    classify: (meta, existing, incoming) => classifyFactUpsertAgainst(
      meta,
      existing && { type: existing.type, properties: existing.properties },
      { type: incoming.type, properties: incoming.properties },
    ),
  },
  chrono: {
    schemaKey: 'chrono',
    validate: (meta, type, properties) => validateChrono(meta, { type, properties }),
    classify: (meta, existing, incoming) => classifyChronoUpsertAgainst(
      meta,
      existing && { type: existing.type, properties: existing.properties },
      { type: incoming.type, properties: incoming.properties },
    ),
  },
};

/** One type schema per shape of `propertySchemas`: absent (the key is not there), empty, or declaring `status`. */
const schemaOf = (shape) => shape === 'absent' ? {}
  : shape === 'empty' ? { propertySchemas: {} }
    : { propertySchemas: { [DECLARED_KEY]: { type: 'string' } } };

/** A space's meta: one type `thing` of the given shape for the kind (and `other` when a retype needs a destination). */
const metaOf = (kind, mode, types) => ({
  validationMode: mode,
  typeSchemas: { [KINDS[kind].schemaKey]: types },
});

/** The rows that name `key` as undeclared. Plain keys are exact on `field`; the reason is the plan's one sentence. */
const undeclaredRows = (rows, key = KEY) => rows.filter(r => r.field === `properties.${key}`
  && /not declared/i.test(r.reason));

const names = (rows) => rows.map(r => r.field);

describe('the validator reports an undeclared key when the type declares at least one property', () => {
  for (const kind of Object.keys(KINDS)) {
    it(`${kind}: one row for the key, in the plan's sentence, with the declared keys named`, () => {
      const meta = metaOf(kind, 'strict', { thing: schemaOf('non-empty') });
      const v = KINDS[kind].validate(meta, 'thing', { [DECLARED_KEY]: 'ok', [KEY]: 'x' });
      const rows = undeclaredRows(v);
      assert.equal(rows.length, 1, `expected exactly one row naming ${KEY}, got ${JSON.stringify(v)}`);
      assert.equal(rows[0].reason, `property '${KEY}' is not declared on this type`);
      assert.equal(rows[0].value, 'x', 'the row carries the value the caller sent');
      const declared = v.map(r => r.declared).find(Array.isArray);
      assert.deepEqual(declared && [...declared].sort(), [DECLARED_KEY],
        `no row names the declared keys (expected [${DECLARED_KEY}]): ${JSON.stringify(v)}`);
      assert.equal(v.length, 1, `nothing else is wrong with this record: ${JSON.stringify(v)}`);
    });

    it(`${kind}: a declared key alone is never a violation`, () => {
      const meta = metaOf(kind, 'strict', { thing: schemaOf('non-empty') });
      assert.deepEqual(KINDS[kind].validate(meta, 'thing', { [DECLARED_KEY]: 'ok' }), []);
    });
  }
});

describe('the truth table: propertySchemas x validationMode x who introduced the key', () => {
  for (const kind of Object.keys(KINDS)) {
    for (const shape of SHAPES) {
      for (const mode of MODES) {
        const open = shape !== 'non-empty';

        it(`${kind} / propertySchemas ${shape} / ${mode} / the write INTRODUCES the key`, () => {
          const meta = metaOf(kind, mode, { thing: schemaOf(shape) });
          const check = KINDS[kind].classify(meta, null, { type: 'thing', properties: { [KEY]: 'x' } });
          const everywhere = [...check.all, ...check.introduced, ...check.preExisting, ...check.warnings];
          if (open || mode === 'off') {
            // Open on both doors, and off evaluates nothing at all: not even a row that nobody is told about.
            assert.deepEqual(undeclaredRows(everywhere), [],
              `${shape} propertySchemas in ${mode} must say nothing about ${KEY}: ${JSON.stringify(check)}`);
            assert.equal(check.blocked, false);
            return;
          }
          assert.equal(undeclaredRows(check.introduced).length, 1, `introduced must name ${KEY}: ${JSON.stringify(check)}`);
          assert.deepEqual(undeclaredRows(check.preExisting), [], 'an insert has nothing pre-existing');
          assert.equal(undeclaredRows(check.warnings).length, 1, `a ${mode} space must surface it: ${JSON.stringify(check)}`);
          assert.equal(check.blocked, mode === 'strict', `${mode}: blocked must be ${mode === 'strict'}`);
          assert.match(check.message, new RegExp(KEY), 'the sentence names the key');
        });

        it(`${kind} / propertySchemas ${shape} / ${mode} / the key was ALREADY stored (pre-existing)`, () => {
          const meta = metaOf(kind, mode, { thing: schemaOf(shape) });
          // The write touches only the declared property; the stored record already carried the key.
          const check = KINDS[kind].classify(
            meta,
            { type: 'thing', properties: { [DECLARED_KEY]: 'a', [KEY]: 'x' } },
            { type: 'thing', properties: { [DECLARED_KEY]: 'b' } },
          );
          const everywhere = [...check.all, ...check.introduced, ...check.preExisting, ...check.warnings];
          if (open || mode === 'off') {
            assert.deepEqual(undeclaredRows(everywhere), [], `${shape} / ${mode}: ${JSON.stringify(check)}`);
            assert.equal(check.blocked, false);
            return;
          }
          assert.deepEqual(undeclaredRows(check.introduced), [],
            `the write did not add ${KEY}, so it is not the write's fault: ${JSON.stringify(check)}`);
          assert.equal(undeclaredRows(check.preExisting).length, 1, `a stored key is reported as pre-existing: ${JSON.stringify(check)}`);
          assert.equal(check.blocked, false, `P-6: a stored undeclared key never refuses the edit, in ${mode} either`);
          // Reported, never silent: a warn or strict space still tells the caller the record does not fit.
          assert.equal(undeclaredRows(check.warnings).length, 1, `${mode} still reports the stored key: ${JSON.stringify(check)}`);
        });
      }
    }
  }
});

describe('a stored undeclared key stays editable: changing its VALUE is not the write adding the key', () => {
  for (const kind of Object.keys(KINDS)) {
    it(`${kind}: the stored key keeps its name, the write changes what it says`, () => {
      const meta = metaOf(kind, 'strict', { thing: schemaOf('non-empty') });
      const check = KINDS[kind].classify(
        meta,
        { type: 'thing', properties: { [DECLARED_KEY]: 'a', [KEY]: 'old' } },
        { type: 'thing', properties: { [KEY]: 'new' } },
      );
      assert.equal(check.blocked, false, `an edit of a stored undeclared key's value was refused: ${JSON.stringify(check)}`);
      assert.deepEqual(undeclaredRows(check.introduced), []);
      assert.equal(undeclaredRows(check.preExisting).length, 1);
    });

    it(`${kind}: a write that adds a SECOND undeclared key beside the stored one is refused for the second only`, () => {
      const meta = metaOf(kind, 'strict', { thing: schemaOf('non-empty') });
      const check = KINDS[kind].classify(
        meta,
        { type: 'thing', properties: { [DECLARED_KEY]: 'a', [KEY]: 'old' } },
        { type: 'thing', properties: { zzSecond: 'new' } },
      );
      assert.equal(check.blocked, true);
      assert.deepEqual(names(undeclaredRows(check.introduced, 'zzSecond')), ['properties.zzSecond']);
      assert.deepEqual(undeclaredRows(check.introduced), [], 'the stored key is not blamed on the write');
      assert.equal(undeclaredRows(check.preExisting).length, 1);
    });
  }
});

describe('a retype is judged against the type it leaves and the type it lands on', () => {
  for (const kind of Object.keys(KINDS)) {
    const types = {
      // `old` declares the key `kept`; `fresh` declares only `status`; `alsoNot` declares only `status`, too; `open` declares nothing.
      withKey: { propertySchemas: { [DECLARED_KEY]: { type: 'string' }, kept: { type: 'string' } } },
      fresh: schemaOf('non-empty'),
      alsoNot: schemaOf('non-empty'),
      open: {},
    };

    it(`${kind}: declared on the old type, undeclared on the new one: INTRODUCED, refused in strict`, () => {
      const meta = metaOf(kind, 'strict', types);
      const check = KINDS[kind].classify(
        meta,
        { type: 'withKey', properties: { kept: 'x' } },
        { type: 'fresh', properties: {} },
      );
      assert.equal(undeclaredRows(check.introduced, 'kept').length, 1, `the retype made 'kept' undeclared: ${JSON.stringify(check)}`);
      assert.equal(check.blocked, true);
    });

    it(`${kind}: undeclared on both types: PRE-EXISTING, a retype between them is not refused for it`, () => {
      const meta = metaOf(kind, 'strict', types);
      const check = KINDS[kind].classify(
        meta,
        { type: 'fresh', properties: { [KEY]: 'x' } },
        { type: 'alsoNot', properties: {} },
      );
      assert.deepEqual(undeclaredRows(check.introduced), [], JSON.stringify(check));
      assert.equal(undeclaredRows(check.preExisting).length, 1, JSON.stringify(check));
      assert.equal(check.blocked, false);
    });

    it(`${kind}: from an open type to a declaring one the stored key is introduced by the retype`, () => {
      // The old type declared nothing, so its record had no undeclared key to inherit: the list closes around it now.
      const meta = metaOf(kind, 'strict', types);
      const check = KINDS[kind].classify(
        meta,
        { type: 'open', properties: { [KEY]: 'x' } },
        { type: 'fresh', properties: {} },
      );
      assert.equal(undeclaredRows(check.introduced).length, 1, JSON.stringify(check));
      assert.equal(check.blocked, true);
    });

    it(`${kind}: from a declaring type to an open one nothing is undeclared`, () => {
      const meta = metaOf(kind, 'strict', types);
      const check = KINDS[kind].classify(
        meta,
        { type: 'withKey', properties: { kept: 'x', [KEY]: 'y' } },
        { type: 'open', properties: {} },
      );
      assert.deepEqual(undeclaredRows([...check.all, ...check.introduced, ...check.warnings], 'kept'), []);
      assert.deepEqual(undeclaredRows(check.introduced), []);
      assert.equal(check.blocked, false);
    });
  }
});

describe('a null or undefined value is an absent key', () => {
  for (const kind of Object.keys(KINDS)) {
    it(`${kind}: ${KEY}: null and ${KEY}: undefined are not violations`, () => {
      const meta = metaOf(kind, 'strict', { thing: schemaOf('non-empty') });
      assert.deepEqual(undeclaredRows(KINDS[kind].validate(meta, 'thing', { [DECLARED_KEY]: 'ok', [KEY]: null })), []);
      assert.deepEqual(undeclaredRows(KINDS[kind].validate(meta, 'thing', { [DECLARED_KEY]: 'ok', [KEY]: undefined })), []);
    });
  }
});

describe('declared means OWN: a key named like something on Object.prototype is not declared by it', () => {
  // `JSON.parse` makes `__proto__` an OWN property, which is how a request body carries it; an object literal would set the prototype.
  const PROTOTYPE_KEYS = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf'];
  for (const kind of Object.keys(KINDS)) {
    for (const key of PROTOTYPE_KEYS) {
      it(`${kind}: the key '${key}' is undeclared on a type that declares only ${DECLARED_KEY}`, () => {
        const meta = metaOf(kind, 'strict', { thing: schemaOf('non-empty') });
        const properties = JSON.parse(`{"${DECLARED_KEY}":"ok","${key}":"x"}`);
        const v = KINDS[kind].validate(meta, 'thing', properties);
        assert.equal(undeclaredRows(v, key).length, 1,
          `'${key}' slipped past the declared list — a lookup through the prototype chain found it declared: ${JSON.stringify(v)}`);
      });
    }

    it(`${kind}: a type that DECLARES a key named 'constructor' accepts it, and the declared list names only own keys`, () => {
      const meta = metaOf(kind, 'strict', {
        thing: { propertySchemas: { constructor: { type: 'string' }, [DECLARED_KEY]: { type: 'string' } } },
      });
      assert.deepEqual(KINDS[kind].validate(meta, 'thing', { constructor: 'x' }), []);
      const v = KINDS[kind].validate(meta, 'thing', { constructor: 'x', toString: 'y' });
      assert.equal(undeclaredRows(v, 'toString').length, 1, JSON.stringify(v));
      const declared = v.map(r => r.declared).find(Array.isArray);
      assert.deepEqual(declared && [...declared].sort(), ['constructor', DECLARED_KEY].sort());
    });
  }
});

describe('keys a caller can make odd: dotted, $-prefixed, oversize', () => {
  for (const kind of Object.keys(KINDS)) {
    for (const key of ['a.b', '$x', '$set', 'a b', 'ключ']) {
      it(`${kind}: the key ${JSON.stringify(key)} is one undeclared row, named whole`, () => {
        const meta = metaOf(kind, 'strict', { thing: schemaOf('non-empty') });
        const v = KINDS[kind].validate(meta, 'thing', { [DECLARED_KEY]: 'ok', [key]: 'x' });
        const rows = v.filter(r => r.field.startsWith('properties.') && r.field.includes(key) && /not declared/i.test(r.reason));
        assert.equal(rows.length, 1, `expected one undeclared row for ${JSON.stringify(key)}, got ${JSON.stringify(v)}`);
      });
    }

    it(`${kind}: an oversize key is one row, and what the refusal sends back stays bounded`, () => {
      const meta = metaOf(kind, 'strict', { thing: schemaOf('non-empty') });
      const huge = 'k'.repeat(1_000_000);
      const check = KINDS[kind].classify(meta, null, { type: 'thing', properties: { [huge]: 'x' } });
      assert.equal(check.introduced.filter(r => r.field.startsWith('properties.k') && /not declared/i.test(r.reason)).length, 1,
        'the oversize key is not reported as undeclared at all');
      const body = JSON.stringify(new SchemaViolationError(check).toStructured());
      assert.ok(body.length < 10_000,
        `a megabyte key came back as a ${body.length}-char refusal body — the key is quoted whole, not through the bounded renderer`);
      assert.ok(check.message.length < 2_000, `the sentence quotes the key whole: ${check.message.length} chars`);
    });
  }
});

describe('an unresolvable $ref type says what is broken and nothing about keys', () => {
  for (const kind of Object.keys(KINDS)) {
    it(`${kind}: the broken-reference violation, and no undeclared row for any key`, () => {
      const meta = resolveMetaRefs(metaOf(kind, 'strict', { thing: { $ref: 'library:does-not-exist' } }));
      const v = KINDS[kind].validate(meta, 'thing', { anything: 'x', [KEY]: 'y' });
      assert.ok(v.some(r => r.field === '$ref'), `the unresolved reference is not reported: ${JSON.stringify(v)}`);
      assert.deepEqual(v.filter(r => /not declared/i.test(r.reason)), [],
        'with no schema resolved there is no declared list to compare a key to');
    });
  }
});

describe('a nested value is one row for its key', () => {
  for (const kind of Object.keys(KINDS)) {
    it(`${kind}: an undeclared key holding an object or an array names the key once, not its leaves`, () => {
      const meta = metaOf(kind, 'strict', { thing: schemaOf('non-empty') });
      const v = KINDS[kind].validate(meta, 'thing', { [DECLARED_KEY]: 'ok', [KEY]: { a: { b: 1 }, list: [1, 2, 3] } });
      assert.equal(undeclaredRows(v).length, 1, JSON.stringify(v));
      assert.deepEqual(v.filter(r => r.field.startsWith(`properties.${KEY}.`)), [], 'a row per leaf');
    });
  }
});

describe('the 20-row cap is applied after the classification, never before it', () => {
  it('a new key sorted after twenty-five stored undeclared ones is still the write\'s, and refused', () => {
    const stored = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`a${String(i).padStart(2, '0')}`, 'x']));
    for (const kind of Object.keys(KINDS)) {
      const meta = metaOf(kind, 'strict', { thing: schemaOf('non-empty') });
      const check = KINDS[kind].classify(
        meta,
        { type: 'thing', properties: { [DECLARED_KEY]: 'ok', ...stored } },
        { type: 'thing', properties: { zzNew: 'x' } },
      );
      assert.equal(check.blocked, true,
        `${kind}: the new key was lost behind twenty-five stored ones — the cap cut the list before the split, so the write passed`);
      assert.equal(undeclaredRows(check.introduced, 'zzNew').length, 1, `${kind}: ${JSON.stringify(check).slice(0, 400)}`);
    }
  });

  it('the stored keys are still reported as pre-existing, and none of them is blamed on the write', () => {
    const stored = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`a${String(i).padStart(2, '0')}`, 'x']));
    const meta = metaOf('entity', 'strict', { thing: schemaOf('non-empty') });
    const check = KINDS.entity.classify(
      meta,
      { type: 'thing', properties: { [DECLARED_KEY]: 'ok', ...stored } },
      { type: 'thing', properties: { zzNew: 'x' } },
    );
    assert.deepEqual(check.introduced.filter(r => /^properties\.a\d\d$/.test(r.field)), [],
      'a stored key was blamed on the write that did not add it');
    assert.ok(check.preExisting.some(r => /^properties\.a\d\d$/.test(r.field)), 'no stored key is reported at all');
  });
});

/*
 * R6-3: a break is INTRODUCED when the record after the write breaks it AND (the record before did not, OR the write changed
 * the path the break is about). Before it, the classifier keyed a violation on field + reason only, so a record already
 * stored with a bad `status` sheltered every later bad `status` a write put there: the same field, the same reason, "pre-existing".
 *
 * Scope, stated because the two rulings read differently: for an UNDECLARED KEY the path the rule is about is the key's
 * presence, and the owner's Q-93 ruling (B-3/B-4) is that only a key the write ADDS is refused, so writing a new value to a
 * stored undeclared key stays pre-existing (asserted above). For a VALUE rule on a declared key the path is the value, and
 * a write that puts a new bad value there is the write's break.
 */
describe('R6-3: a write that changes the path a stored break is about owns the break', () => {
  const enumType = { propertySchemas: { [DECLARED_KEY]: { type: 'string', enum: ['up', 'down'] }, note: { type: 'string' } } };
  for (const kind of Object.keys(KINDS)) {
    it(`${kind}: a stored bad value replaced by ANOTHER bad value is introduced, and strict refuses it`, () => {
      const meta = metaOf(kind, 'strict', { thing: enumType });
      const check = KINDS[kind].classify(
        meta,
        { type: 'thing', properties: { [DECLARED_KEY]: 'retired' } },
        { type: 'thing', properties: { [DECLARED_KEY]: 'bogus' } },
      );
      assert.ok(check.introduced.some(r => r.field === `properties.${DECLARED_KEY}`),
        `the write put a new bad value at properties.${DECLARED_KEY} and it was filed as pre-existing — a stored break sheltered a new one: ${JSON.stringify(check)}`);
      assert.equal(check.blocked, true, 'strict let a write store a new bad value because the old one was bad too');
    });

    it(`${kind}: control: a write that leaves the bad value alone does not own it`, () => {
      const meta = metaOf(kind, 'strict', { thing: enumType });
      const check = KINDS[kind].classify(
        meta,
        { type: 'thing', properties: { [DECLARED_KEY]: 'retired', note: 'a' } },
        { type: 'thing', properties: { note: 'b' } },
      );
      assert.deepEqual(check.introduced, [], JSON.stringify(check));
      assert.ok(check.preExisting.some(r => r.field === `properties.${DECLARED_KEY}`), JSON.stringify(check));
      assert.equal(check.blocked, false);
    });

    it(`${kind}: control: a write that sends the SAME stored bad value back does not own it (a round-tripping editor)`, () => {
      const meta = metaOf(kind, 'strict', { thing: enumType });
      const check = KINDS[kind].classify(
        meta,
        { type: 'thing', properties: { [DECLARED_KEY]: 'retired', note: 'a' } },
        { type: 'thing', properties: { [DECLARED_KEY]: 'retired', note: 'b' } },
      );
      assert.equal(check.blocked, false, `re-sending the stored value is not a change to the path: ${JSON.stringify(check)}`);
    });
  }
});

describe('off evaluates nothing', () => {
  for (const kind of Object.keys(KINDS)) {
    it(`${kind}: a record full of undeclared keys leaves no trace in any list the classifier returns`, () => {
      const meta = metaOf(kind, 'off', { thing: schemaOf('non-empty') });
      const props = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'x']));
      const check = KINDS[kind].classify(meta, null, { type: 'thing', properties: { [DECLARED_KEY]: 'ok', ...props } });
      for (const list of ['all', 'introduced', 'preExisting', 'warnings']) {
        assert.deepEqual(check[list].filter(r => /not declared/i.test(r.reason)), [], `off left rows in ${list}`);
      }
      assert.equal(check.blocked, false);
    });
  }
});
