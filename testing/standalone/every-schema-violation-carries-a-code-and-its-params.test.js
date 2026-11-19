/**
 * Every schema violation the server reports carries a stable `code` and its `params` beside its `reason`, and the reason is built from
 * them (Q-943).
 *
 * ## The finding
 *
 * A violation was `{ field, value, reason }`: the reason English prose ("age: expected type 'number', got 'string'"). A screen that shows
 * a record's problems in German or Polish had nothing to translate but the prose, so the Review page's chips and every refusal read in
 * English whatever the language. The code and the values the prose names now ride beside it, so a client words the code itself.
 *
 * ## What is asserted, and what is derived
 *
 *  1. **Each kind of violation, raised by the real validator** (or by the one function that raises it outside the validator), carries a
 *     code of `SCHEMA_VIOLATION_CODES`, exactly the params that table names for it (plain values: a text, a number, a boolean or a list
 *     of texts), and a `reason` that is BOTH the literal text it had before the change (written here, from the base's source) AND
 *     `schemaViolationText(code, params)`: the two cannot drift, and the prose a caller reads did not change.
 *  2. **The table is covered**: every code it declares is produced by a case here (derived from the table, never listed), so a code added
 *     to the table that nothing raises, or raised by a site no case reaches, is red.
 *  3. **Every phrase a parameter selects** (a rule's cause, a too-large value's bound) is worded by the text function as before.
 *  4. **The one renderer keeps them and bounds them**: `boundedRows` passes `code` and `params` on, and cuts a list param the way it cuts
 *     `declared` (fifty names, each bounded, then the count).
 *  5. **No drift with the reference refusal**: the sentence a missing edge end's row says is the sentence `missingRefsRefusal` says.
 *
 * Seen red on d7a18d17c: no row carries a code, and the table's module does not exist.
 *
 * Run: node --test testing/standalone/every-schema-violation-carries-a-code-and-its-params.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const DIST = '../../server/dist/';
const validation = await import(`${DIST}spaces/schema-validation.js`);
const { recordViewOf } = await import(`${DIST}brain/record-view.js`);
const writeValidation = await import(`${DIST}brain/write-validation.js`);
const { linkTargetRemovedWarnings } = await import(`${DIST}brain/gone-entity-references.js`);
const { missingRefsRefusal } = await import(`${DIST}brain/entity-refs.js`);
const { REDOS_REFUSAL } = await import(`${DIST}util/redos.js`);
/** The table's module: absent before the change, and every case then fails on its first row without a code. */
const codes = await import(`${DIST}spaces/schema-violation-codes.js`).catch(() => ({}));
const TABLE = codes.SCHEMA_VIOLATION_CODES ?? {};
const textOf = codes.schemaViolationText ?? (() => { throw new Error('schemaViolationText is not exported'); });

const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 8);
const strict = (typeSchemas, extra = {}) => ({ validationMode: 'strict', typeSchemas, ...extra });
const PERSON = {
  namingPattern: '^[A-Z]',
  propertySchemas: {
    id: { type: 'string', required: true },
    age: { type: 'number', minimum: 0, maximum: 150 },
    rank: { type: 'string', enum: ['low', 'high'] },
    slug: { type: 'string', pattern: '^[a-z]+$' },
    nick: { type: 'string', pattern: '(a+)+' },
    a: { type: 'string' },
    b: { type: 'number' },
  },
};
const ENTITIES = strict({ entity: { person: PERSON, org: {}, risky: { namingPattern: '(a+)+' }, lib: { _unresolvedRef: 'library:gone-entry' } } });
const entity = (o) => validation.validateEntity(ENTITIES, recordViewOf('entity', { name: 'Ann', type: 'person', properties: { id: 'x', ...o.properties }, ...o.record }));
const EMPLOYS = strict({ entity: { org: {}, person: {} }, edge: { employs: { endpoints: { from: ['org'], to: ['person'] }, functional: true } } });
const edge = (resolved) => validation.validateEdge(EMPLOYS, recordViewOf('edge', { from: 'f', to: 't', label: 'employs', properties: {} }), resolved);
const withRule = (rules, spaceRules) => strict({ entity: { person: { propertySchemas: PERSON.propertySchemas, ...(rules ? { rules } : {}) } } }, spaceRules ? { rules: spaceRules } : {});
const ruled = (meta, properties) => validation.validateEntity(meta, recordViewOf('entity', { name: 'Ann', type: 'person', properties: { id: 'x', ...properties } }));

const BELOW = { rule: 'self.properties.b < 100.0', message: 'b must be below one hundred' };
const COMPARED = { rule: 'self.properties.a < 100.0', message: 'a must be below one hundred' };
const FILLED = { rule: 'size(self.properties.a) > 0', message: 'a must not be empty' };
/** The words each cause of a rule that could not run said before the change (`schema-rules.ts` at d7a18d17c). */
const CAUSE_WORDS = {
  engine_unavailable: 'the rule engine is not available',
  type_mismatch: 'a value of a type the rule does not compare',
  evaluation_error: 'an evaluation error',
  not_boolean: 'it did not answer true or false',
};

/**
 * One case per kind of violation: the rows its producer returns, and the row expected among them, its `reason` written as the base's
 * source wrote it. `pick` finds the row by field (and code, where one field can fail two ways).
 */
const CASES = [
  { name: 'an entity type outside the allowlist', rows: () => entity({ record: { type: 'robot' } }),
    want: { field: 'type', code: 'type_not_allowed', params: { allowlist: 'entityTypes', allowedValues: ['person', 'org', 'risky', 'lib'] },
      reason: 'not in entityTypes allowlist: person, org, risky, lib' } },
  { name: 'a fact type outside the allowlist', rows: () => validation.validateFact(strict({ fact: { claim: {} } }), recordViewOf('fact', { fact: 'f', type: 'rumour', properties: {} })),
    want: { field: 'type', code: 'type_not_allowed', params: { allowlist: 'memoryTypes', allowedValues: ['claim'] }, reason: 'not in memoryTypes allowlist: claim' } },
  { name: 'a chrono type outside the allowlist', rows: () => validation.validateChrono(strict({ chrono: { event: {} } }), recordViewOf('chrono', { title: 't', type: 'party', properties: {} })),
    want: { field: 'type', code: 'type_not_allowed', params: { allowlist: 'chronoTypes', allowedValues: ['event'] }, reason: 'not in chronoTypes allowlist: event' } },
  { name: 'an edge label outside the allowlist', rows: () => validation.validateEdge(EMPLOYS, recordViewOf('edge', { from: 'f', to: 't', label: 'likes', properties: {} }), {}),
    want: { field: 'label', code: 'type_not_allowed', params: { allowlist: 'edgeLabels', allowedValues: ['employs'] }, reason: 'not in edgeLabels allowlist: employs' } },
  { name: 'a library reference that names nothing', rows: () => entity({ record: { type: 'lib' } }),
    want: { field: '$ref', code: 'ref_unresolved', params: { entry: 'gone-entry' }, reason: "schema library entry 'gone-entry' not found — update or remove this $ref" } },
  { name: 'a naming pattern the instance declines to run', rows: () => entity({ record: { type: 'risky', name: 'aaa' } }),
    want: { field: 'name', code: 'naming_pattern_not_evaluated', params: { type: 'risky', pattern: '(a+)+' },
      reason: `naming pattern for type 'risky' not evaluated, so nothing was checked: (a+)+ — ${REDOS_REFUSAL}` } },
  { name: 'a name that does not match the naming pattern', rows: () => entity({ record: { name: 'ann' } }),
    want: { field: 'name', code: 'naming_pattern', params: { type: 'person', pattern: '^[A-Z]' }, reason: "does not match naming pattern for type 'person': ^[A-Z]" } },
  { name: 'a from end of a type the label does not admit', rows: () => edge({ fromType: 'person' }),
    want: { field: 'fromType', code: 'endpoint_type', params: { label: 'employs', end: 'from', allowedValues: ['org'] }, reason: "'employs' declares its from endpoint as one of: org" } },
  { name: 'an untyped to end the label does not admit', rows: () => edge({ toType: null }),
    want: { field: 'toType', code: 'endpoint_type', params: { label: 'employs', end: 'to', allowedValues: ['person'] }, reason: "'employs' declares its to endpoint as one of: person" } },
  { name: 'a second edge under a functional label', rows: () => edge({ otherEdgesFromSubject: 2 }),
    want: { field: 'functional', code: 'functional', params: { label: 'employs', count: 2 },
      reason: "'employs' is declared functional: one subject may have at most one. 2 other edge(s) with this label already start here" } },
  { name: 'a required property left out', rows: () => entity({ properties: { id: '' } }),
    want: { field: 'properties.id', code: 'required', params: { missingProperty: 'id' }, reason: "required property 'id' is missing or empty" } },
  { name: 'a property key the type does not declare', rows: () => entity({ properties: { zzz: 1 } }),
    want: { field: 'properties.zzz', code: 'additional_properties', params: { additionalProperty: 'zzz' }, reason: "property 'zzz' is not declared on this type",
      declared: ['a', 'age', 'b', 'id', 'nick', 'rank', 'slug'] } },
  { name: 'a value of the wrong type', rows: () => entity({ properties: { age: 'old' } }),
    want: { field: 'properties.age', code: 'type', params: { type: 'number', got: 'string' }, reason: "expected type 'number', got 'string'" } },
  { name: 'a value outside the enum', rows: () => entity({ properties: { rank: 'mid' } }),
    want: { field: 'properties.rank', code: 'enum', params: { allowedValues: ['low', 'high'] }, reason: 'must be one of: low, high' } },
  { name: 'a number below the minimum', rows: () => entity({ properties: { age: -1 } }),
    want: { field: 'properties.age', code: 'minimum', params: { comparison: '>=', limit: 0 }, reason: 'must be >= 0' } },
  { name: 'a number above the maximum', rows: () => entity({ properties: { age: 200 } }),
    want: { field: 'properties.age', code: 'maximum', params: { comparison: '<=', limit: 150 }, reason: 'must be <= 150' } },
  { name: 'a property pattern the instance declines to run', rows: () => entity({ properties: { nick: 'aa' } }),
    want: { field: 'properties.nick', code: 'pattern_not_evaluated', params: { pattern: '(a+)+' },
      reason: `pattern not evaluated, so nothing was checked: (a+)+ — ${REDOS_REFUSAL}` } },
  { name: 'a value that does not match the pattern', rows: () => entity({ properties: { slug: 'ABC' } }),
    want: { field: 'properties.slug', code: 'pattern', params: { pattern: '^[a-z]+$' }, reason: 'does not match pattern: ^[a-z]+$' } },
  { name: "a type's rule the record breaks", rows: () => ruled(withRule({ below: BELOW }), { b: 500 }),
    want: { field: 'rules.below', code: 'rule', params: { rule: 'below', message: BELOW.message, hash: hash(BELOW.rule) },
      reason: `${BELOW.message} (rule ${hash(BELOW.rule)})` } },
  { name: "a space's rule the record breaks", rows: () => ruled(withRule(undefined, { below: BELOW }), { b: 500 }),
    want: { field: 'meta.rules.below', code: 'rule', params: { rule: 'below', message: BELOW.message, hash: hash(BELOW.rule) },
      reason: `${BELOW.message} (rule ${hash(BELOW.rule)})` } },
  { name: 'a rule that could not be evaluated on the record', rows: () => ruled(withRule({ compared: COMPARED }), { a: 'text' }),
    // The cause is the engine's to say (an overload or another error); the reason is the base's words for whichever it is.
    want: (row) => ({ field: 'rules.compared', code: 'rule_not_evaluated', outcome: 'could_not_evaluate',
      params: { rule: 'compared', message: COMPARED.message, hash: hash(COMPARED.rule), cause: row.params?.cause },
      reason: `${COMPARED.message} — could not be evaluated on this record (${CAUSE_WORDS[row.params?.cause]}) (rule ${hash(COMPARED.rule)})` }) },
  { name: 'a rule over a value too large to check', rows: () => ruled(withRule({ filled: FILLED }), { a: 'x'.repeat(10_001) }),
    want: { field: 'rules.filled', code: 'rule_too_large', outcome: 'too_large',
      params: { rule: 'filled', message: FILLED.message, hash: hash(FILLED.rule), path: 'properties.a', bound: 'characters', limit: 10_000 },
      reason: `${FILLED.message} — too large to check: self.properties.a is longer than 10000 characters (rule ${hash(FILLED.rule)})` } },
  { name: 'a link taken back because its entity was deleted', rows: () => linkTargetRemovedWarnings(['e-1']),
    want: { field: 'linkEntities', code: 'link_target_removed', params: { entityId: 'e-1' },
      reason: "link_target_removed: the entity 'e-1' was deleted while this record was written, so the link to it was not kept; the record itself is written." } },
  { name: 'an edge end that names no record (strictLinkage)', rows: () => writeValidation.danglingReferenceCheck('s1', 'from', 'entity', 'id-1').all,
    want: { field: 'from', code: 'reference_not_found', params: { refField: 'from', refKind: 'entity', space: 's1', ids: ['id-1'] },
      reason: '`from` references 1 entity ID that does not exist in space \'s1\': "id-1". Create the record first, then link it — the write was refused rather than stored with a dead link.' } },
  { name: 'a record a conversion could not rewrite', rows: () => (codes.schemaViolation ? [codes.schemaViolation('conversion_error', { errorKind: 'TypeError' }, '', undefined)] : []),
    want: { field: '', code: 'conversion_error', params: { errorKind: 'TypeError' }, reason: 'TypeError' } },
];

const isPlain = (v) => ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every(x => typeof x === 'string'));
const pick = (rows, field, code) => rows.find(r => r.field === field && (r.code === undefined || r.code === code)) ;
const produced = new Set();

describe('each kind of violation carries its code and params, and its reason is built from them', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const rows = c.rows();
      const fieldOf = typeof c.want === 'function' ? c.want({}).field : c.want.field;
      const codeOf = typeof c.want === 'function' ? c.want({}).code : c.want.code;
      const row = pick(rows, fieldOf, codeOf);
      assert.ok(row, `no row on ${fieldOf}: ${JSON.stringify(rows).slice(0, 400)}`);
      assert.equal(typeof row.code, 'string', `the row carries no code: ${JSON.stringify(row).slice(0, 300)}`);
      const want = typeof c.want === 'function' ? c.want(row) : c.want;
      const { value: _v, ...said } = row;
      assert.deepEqual(said, want);
      assert.ok(Object.hasOwn(TABLE, row.code), `code '${row.code}' is not in SCHEMA_VIOLATION_CODES`);
      assert.deepEqual(Object.keys(row.params).sort(), [...TABLE[row.code].params].sort(), `params of '${row.code}' differ from the table's`);
      for (const [k, v] of Object.entries(row.params)) assert.ok(isPlain(v), `params.${k} of '${row.code}' is not a plain value: ${JSON.stringify(v)}`);
      assert.equal(row.reason, textOf(row.code, row.params), 'the reason is not the text of its code and params');
      produced.add(row.code);
    });
  }
});

describe('the table', () => {
  it('declares codes, each with its params and the standard it follows (a floor, so an empty table is not a clean one)', () => {
    const entries = Object.entries(TABLE);
    assert.ok(entries.length >= 15, `SCHEMA_VIOLATION_CODES holds ${entries.length} code(s)`);
    for (const [code, e] of entries) {
      assert.match(code, /^[a-z]+(?:_[a-z]+)*$/, `'${code}' is not lower_snake`);
      assert.ok(Array.isArray(e.params), `'${code}' names no params list`);
      assert.equal(typeof e.standard, 'string', `'${code}' says no standard`);
      assert.ok(e.standard.length > 10, `'${code}' says too little about its standard: '${e.standard}'`);
    }
  });

  it('every code it declares is raised by a case above', () => {
    assert.ok(produced.size > 0, 'no case produced a code');
    assert.deepEqual(Object.keys(TABLE).filter(c => !produced.has(c)), [], 'declared, and raised by no case');
  });
});

describe('the phrases a parameter selects are the words the base said', () => {
  const p = { rule: 'r', message: 'm', hash: 'h' };
  for (const [cause, words] of Object.entries(CAUSE_WORDS)) {
    it(`rule_not_evaluated, cause ${cause}`, () => {
      assert.equal(textOf('rule_not_evaluated', { ...p, cause }), `m — could not be evaluated on this record (${words}) (rule h)`);
    });
  }
  const BOUNDS = [
    ['characters', 10_000, 'longer than 10000 characters'],
    ['list', 100, 'a list of more than 100'],
    ['map', 200, 'a map of more than 200'],
    ['depth', 8, 'nested too deeply'],
  ];
  for (const [bound, limit, words] of BOUNDS) {
    it(`rule_too_large, bound ${bound}`, () => {
      assert.equal(textOf('rule_too_large', { ...p, path: 'tags', bound, limit }), `m — too large to check: self.tags is ${words} (rule h)`);
    });
  }
});

describe('the one renderer keeps the code and params, and bounds them', () => {
  it('a row passes through boundedRows with its code and params', () => {
    const [row] = entity({ properties: { rank: 'mid' } }).filter(r => r.field === 'properties.rank');
    const [shown] = writeValidation.boundedRows([row]);
    assert.equal(shown.code, 'enum');
    assert.deepEqual(shown.params, { allowedValues: ['low', 'high'] });
  });

  it('a list param is cut as `declared` is: fifty names, each bounded, then the count', () => {
    const many = Array.from({ length: 60 }, (_, i) => `v${i}-${'x'.repeat(400)}`);
    const meta = strict({ entity: { person: { propertySchemas: { rank: { type: 'string', enum: many } } } } });
    const [row] = validation.validateEntity(meta, recordViewOf('entity', { name: 'A', type: 'person', properties: { rank: 'nope' } }));
    assert.equal(row.params.allowedValues.length, 60, 'the row as raised holds the whole list its reason names');
    const [shown] = writeValidation.boundedRows([row]);
    assert.equal(shown.params.allowedValues.length, 51);
    assert.equal(shown.params.allowedValues.at(-1), '…(+10 more)');
    assert.ok(shown.params.allowedValues.slice(0, 50).every(v => v.length <= 260), 'a name is not bounded');
  });
});

describe('a missing edge end says the reference refusal\'s own sentence', () => {
  it('the row\'s reason is missingRefsRefusal\'s message for the same end', () => {
    const [row] = writeValidation.danglingReferenceCheck('s1', 'to', 'entity', 'id-2').all;
    assert.equal(row.reason, missingRefsRefusal('s1', 'to', 'entity', ['id-2']).message);
  });
});
