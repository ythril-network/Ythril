/**
 * Every reason the RDF import gives for a quad it cannot take is a row of one table, and each row has a case here with the quad that
 * triggers it, in strict and in the looser modes (bundle-270, slice S3, Q-752; plan section 3(f)).
 *
 * ## The defect this prevents
 *
 * A quad the translator cannot take that is answered by nothing is data lost without a word; a reason that refuses in warn where the table
 * says it records (or the other way round) refuses a whole import or lets a wrong record in; a reason whose message repeats a value or an
 * address leaks the record's content into every log and answer that carries the reason. `server/src/rdf/import-reasons.ts` holds the one
 * table (code, message, the modes it refuses in); `quads-to-ops.ts` answers each reason from it.
 *
 * ## What it holds
 *
 * - Each code of the table has a case below: in strict the reason is answered, refused, with the quad that triggers it among its quads; in
 *   warn and off it is refused or recorded as the table says, and a recorded reason keeps its value only where the case says it does (a
 *   language-tagged string as the plain string, a datatype a property cannot hold as its lexical form): never silently.
 * - A code added to the table without a case here fails; a case for a code the table does not hold fails.
 * - Every row refuses in strict, and its message names no value of the record: no literal and no address of the case's quads appears in it.
 * - Every answer accounts for every quad of its group.
 *
 * Run: node --test testing/standalone/every-import-reason-is-named-and-tested.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { META, BASE } from './_rdf-writer-fixtures.mjs';
import { fn, reasonTable, reverse, contextFor, assertAccounted, iri, blank, lit, tagged, q, RDF, XSD, SCHEMA_ORG } from './_quads-to-ops-doors.mjs';

const vocabulary = await import('../../server/dist/rdf/ythril-vocabulary.js');
const Y = vocabulary.YTHRIL_NS;
const V = `${BASE}vocab/`;
const TYPE = `${RDF}type`;
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const E = (id) => `${BASE}entity/${id}`;
const X = 'http://ex.org/x';

const SHARED_META = {
  ...META,
  typeSchemas: {
    entity: {
      person: { propertySchemas: { email: { type: 'string', iri: `${SCHEMA_ORG}email` } } },
      org: { propertySchemas: { email: { type: 'string', iri: `${SCHEMA_ORG}email` } } },
    },
  },
};

const mintX = () => new Map([[X, { kind: 'entity', id: 'm-x' }]]);
const storedY = () => new Map([[fn('recordKey')('entity', 'y'), { doc: { _id: 'y', name: 'Y', type: 'person' }, links: {} }]]);

/**
 * One case per reason code: the group, the index of the quad that triggers it, and in which looser modes its value is kept. `meta`,
 * `minted`, `stored`, `asserted` default to the fixture's meta and nothing.
 */
const CASES = {
  'types-of-two-kinds': { quads: [q(X, TYPE, `${Y}Entity`), q(X, TYPE, `${Y}Fact`), q(X, LABEL, lit('n'))], trigger: 1 },
  'several-types-of-one-kind': { quads: [q(X, TYPE, `${Y}Entity`), q(X, TYPE, `${V}entity/person`), q(X, TYPE, `${V}entity/org`)], trigger: 2, minted: mintX },
  'blank-node-subject': { quads: [q(blank('b1'), TYPE, `${Y}Entity`), q(blank('b1'), LABEL, lit('a name'))], trigger: 1 },
  'language-tagged-literal': { quads: [q(X, TYPE, `${Y}Entity`), q(X, LABEL, tagged('a name', 'en'))], trigger: 1, minted: mintX, kept: true },
  'datatype-refused': { quads: [q(X, TYPE, `${V}entity/person`), q(X, `${V}entity/person#age`, lit('2001', `${XSD}gYear`))], trigger: 1, minted: mintX, kept: true },
  'predicate-without-term': { quads: [q(X, TYPE, `${Y}Entity`), q(X, 'http://ex.org/p', lit('value'))], trigger: 1, minted: mintX },
  'class-without-term': { quads: [q(X, TYPE, `${Y}Entity`), q(X, TYPE, 'http://ex.org/Class')], trigger: 1, minted: mintX },
  'annotation-on-unasserted-triple': {
    quads: [q(`${BASE}edge/k9`, TYPE, `${V}edge/knows`), q(`${BASE}edge/k9`, `${RDF}reifies`, { kind: 'triple', subject: iri(E('a')), predicate: iri(`${V}edge/knows`), object: iri(E('b')) })],
    trigger: 1, noAsserted: true,
  },
  'not-an-address-the-export-writes': { quads: [q(`${BASE}nokind/x`, TYPE, `${Y}Entity`), q(`${BASE}nokind/x`, LABEL, lit('a name'))], trigger: 0 },
  'shared-term-unsettled': { quads: [q(X, TYPE, `${Y}Entity`), q(X, `${SCHEMA_ORG}email`, lit('someone@example.org'))], trigger: 1, minted: mintX, meta: SHARED_META },
  'several-values': { quads: [q(X, TYPE, `${Y}Entity`), q(X, LABEL, lit('first name')), q(X, LABEL, lit('second name'))], trigger: 2, minted: mintX },
  'object-not-a-plain-value': { quads: [q(X, TYPE, `${V}entity/person`), q(X, `${V}entity/person#age`, blank('nested'))], trigger: 1, minted: mintX },
  'edge-end-unknown': { quads: [q(X, TYPE, `${Y}Entity`), q(X, `${V}edge/knows`, 'http://ex.org/nowhere')], trigger: 1, minted: mintX },
  'contradicting-kind': { quads: [q(E('e1'), TYPE, `${Y}Fact`), q(E('e1'), `${SCHEMA_ORG}text`, lit('a text'))], trigger: 0 },
  'no-kind': { quads: [q(X, LABEL, lit('a name'))], trigger: 0 },
  'field-not-of-this-kind': { quads: [q(X, TYPE, `${Y}Entity`), q(X, `${SCHEMA_ORG}text`, lit('a text'))], trigger: 1, minted: mintX },
  'property-of-another-type': { quads: [q(X, TYPE, `${V}entity/person`), q(X, `${V}entity/org#founded`, lit('1990'))], trigger: 1, minted: mintX },
  'link-has-no-class': { quads: [q(X, TYPE, `${Y}Entity`), q(X, 'http://purl.org/dc/terms/references', E('y'))], trigger: 1, minted: mintX, stored: storedY },
  'edge-without-statement': { quads: [q(`${BASE}edge/k9`, TYPE, `${V}edge/knows`), q(`${BASE}edge/k9`, `${Y}weight`, lit('1', `${XSD}decimal`))], trigger: 0 },
};

function run(code, mode) {
  const c = CASES[code];
  const meta = c.meta ?? META;
  const names = reverse.addressNames(meta);
  const ctx = contextFor({ meta, names, quads: c.quads, mode, minted: c.minted?.() ?? new Map(), stored: c.stored?.() ?? new Map() });
  if (c.noAsserted) ctx.asserted.clear();
  const out = fn('quadsToOps')(c.quads, ctx);
  assertAccounted(c.quads, out, `${code} in ${mode}`);
  return out;
}

/** The literal values and addresses of a case: none may appear in a reason's message. */
function valuesOf(quads) {
  const out = new Set();
  const add = (t) => {
    if (t.kind === 'iri' || t.kind === 'literal') out.add(t.value);
    if (t.kind === 'triple') { add(t.subject); add(t.object); }
  };
  for (const x of quads) { add(x.subject); add(x.object); }
  return [...out].filter(v => v.length >= 3);
}

describe('every import reason is named and tested', () => {
  it('the table and the cases name the same codes', () => {
    const table = reasonTable();
    assert.deepEqual(Object.keys(table).sort(), Object.keys(CASES).sort(), 'each reason of IMPORT_REASONS has a case here, and each case a reason');
  });

  it('every reason refuses in strict and its message names no value', () => {
    for (const [code, row] of Object.entries(reasonTable())) {
      assert.equal(row.code, code, `${code}: the row carries its own code`);
      assert.ok(row.refusesIn.includes('strict'), `${code}: refuses in strict`);
      assert.ok(row.refusesIn.every(m => ['strict', 'warn', 'off'].includes(m)), `${code}: names only the three modes`);
      assert.doesNotMatch(row.message, /https?:|urn:|"/, `${code}: the message carries no address or quoted value`);
    }
  });

  for (const code of Object.keys(CASES)) {
    it(`${code}: answered with its quad in strict, refused or recorded as the table says in warn and off`, () => {
      const row = reasonTable()[code];
      assert.ok(row, `${code} is no row of IMPORT_REASONS`);
      const c = CASES[code];
      for (const mode of ['strict', 'warn', 'off']) {
        const out = run(code, mode);
        const hit = out.reasons.filter(r => r.code === code);
        assert.ok(hit.length > 0, `${code} in ${mode}: no reason ${code} was answered (got ${out.reasons.map(r => r.code).join(', ') || 'none'})`);
        const r = hit.find(x => x.quads.includes(c.quads[c.trigger]));
        assert.ok(r, `${code} in ${mode}: the reason does not hold the quad that triggers it`);
        assert.equal(r.outcome, row.refusesIn.includes(mode) ? 'refused' : 'recorded', `${code} in ${mode}: refused or recorded against the table`);
        assert.equal(r.kept, mode !== 'strict' && r.outcome === 'recorded' && c.kept === true, `${code} in ${mode}: whether the value is kept`);
        for (const v of valuesOf(c.quads)) assert.ok(!r.message.includes(v), `${code} in ${mode}: the message repeats a value of the record`);
        if (r.kept) assert.equal(out.ops.length, 1, `${code} in ${mode}: a kept value is in an operation`);
      }
    });
  }

  it("a value is read by its property's declared type, not by what it looks like", () => {
    const names = reverse.addressNames(META);
    const ask = (quads, mode) => fn('quadsToOps')(quads, contextFor({ meta: META, names, quads, mode, minted: mintX() }));
    const person = q(X, TYPE, `${V}entity/person`);
    for (const [quad, what] of [
      [q(X, `${V}entity/person#age`, lit('36')), 'a plain literal on a number property'],
      [q(X, `${V}entity/person#born`, lit('yesterday')), 'a plain literal on a date property'],
      [q(X, `${V}entity/person#born`, lit('3', `${XSD}decimal`)), 'a decimal on a date property'],
    ]) {
      const strict = ask([person, quad], 'strict');
      assert.deepEqual(strict.reasons.map(r => [r.code, r.outcome]), [['datatype-refused', 'refused']], `${what} is refused in strict`);
      const warn = ask([person, quad], 'warn');
      assert.deepEqual(warn.reasons.map(r => [r.code, r.outcome, r.kept]), [['datatype-refused', 'recorded', true]], `${what} is recorded in warn and kept`);
      assert.equal(typeof Object.values(warn.ops[0].fields.properties)[0], 'string', `${what} is kept as its lexical form`);
    }
    const typed = ask([person, q(X, `${V}entity/person#age`, lit('36', `${XSD}integer`)), q(X, `${V}entity/person#born`, lit('1815-12-10', `${XSD}date`))], 'strict');
    assert.deepEqual(typed.reasons, [], 'an integer on a number property and a date on a date property are taken');
    assert.deepEqual(typed.ops[0].fields.properties, { age: 36, born: '1815-12-10' });
  });

  it('a language-tagged string is never read as a plain one in silence', () => {
    for (const mode of ['strict', 'warn', 'off']) {
      const out = run('language-tagged-literal', mode);
      const name = out.ops[0]?.fields?.name;
      if (mode === 'strict') assert.equal(name, undefined, 'strict takes no tagged string');
      else assert.equal(name, 'a name', `${mode} keeps the text, with the reason recorded`);
    }
  });
});
