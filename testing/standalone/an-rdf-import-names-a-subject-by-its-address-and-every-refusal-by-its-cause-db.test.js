/**
 * A schema-less file whose typed subjects state no `rdfs:label` lands in a strict space, and every refusal the import still answers names its
 * real cause (bundle-271, Q-759, found by its benchmark).
 *
 * ## The defect
 *
 * The BSBM benchmark's file states no `rdfs:label` on its offers, reviews and persons. The translator maps only `rdfs:label` to an entity's
 * `name` (a chrono entry's `title`), so each such subject was planned with an empty name and refused by the planner's required-field check:
 * 30 503 records reported as `plan_refused`, with a sentence blaming "a bound, a link, a reference or its version". Every edge that ended at
 * one of them was then refused for its dangling end and reported as `schema_violation`, "breaks the space's schema", though no schema rule
 * was broken. The guide promises that such a file lands in a strict space when its subjects are typed addresses; the report did not say what
 * to change.
 *
 * ## What this spec holds
 *
 * - An entity with no label takes its address's local name as its `name`, a chrono entry its `title`, and the edges between them land.
 * - A fact with no `schema:text` stays refused (a fact has no sensible default), as `missing-required-field` naming `fact`, and its message
 *   is the planner's own sentence.
 * - An edge whose end was refused in this import is reported as `end-refused`, naming that end's subject, never as a schema violation.
 * - The default name is the address's local name, trimmed; an address that gives none (a trailing slash, blanks, a control character) is
 *   refused as `address-gives-no-name`, naming the subject, and an edge that ends at it is `end-refused` (review F4, F5).
 * - A fact whose stored link points at a record that does not exist is refused as `stored-link-dangling`, in a generic sentence that quotes
 *   no stored id, and so is a fact that also links a record this import refused (review F1, F5).
 *
 * Run: node --test testing/standalone/an-rdf-import-names-a-subject-by-its-address-and-every-refusal-by-its-cause-db.test.js (server build
 * and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportDoors, rdfMeta, baseOf } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const LANDS = 'rdfnolabel';
const REFUSES = 'rdfnotext';
const DANGLES = 'rdfdangle';
const MIXED = 'rdfmixed';
const YTHRIL = 'https://w3id.org/ythril/ns#';
const REFERENCES = '<http://purl.org/dc/terms/references>';
const STORED_FACT = '66666666-6666-4666-8666-666666666666';
/** The id a stored link points at, which no record holds: the file never says it, so no answer may. */
const GHOST = '77777777-7777-4777-8777-777777777777';
const NONAME = 'rdfnoname';
const SPACES = [LANDS, REFUSES, NONAME, DANGLES, MIXED];
const SCHEMA_TEXT = '<http://schema.org/text>';
const SCHEMA_START = '<http://schema.org/startDate>';
const RDFS_LABEL = '<http://www.w3.org/2000/01/rdf-schema#label>';

/** A strict space with a type of each kind the file states, and the edge labels between them: nothing in the file is a term it lacks. */
const strictMeta = (id) => rdfMeta(id, {
  validationMode: 'strict', strictLinkage: true,
  typeSchemas: {
    entity: { person: {} }, fact: { note: {} }, chrono: { event: {} },
    edge: { knows: {}, attends: {}, cites: {} },
  },
});

/** The report an import door answers: the body itself, or under `report` beside a refusal's `error` and `code`. */
const reportOf = (r) => r.body?.report ?? r.body;

const ANN ='http://people.example/ann%20lee';
const BO = 'http://people.example/bo';
const LAUNCH = 'http://events.example/launch';
const NOTE = 'http://notes.example/n1';

describe('a subject with no label is named by its address, and every refusal names its cause (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer;
  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_nolabel', spaces: SPACES.map(id => ({ id, meta: strictMeta(id) })) });
    writer = await d.mint('rdf-import-nolabel-writer', Object.fromEntries(SPACES.map(s => [s, d.row({ knowledge: 'write' })])));
  });
  after(async () => { await d?.close(); });

  it('typed entity and chrono subjects with no label land under their local names, and the edges between them land too', async () => {
    const v = `${baseOf(LANDS)}vocab/`;
    const file = [
      `<${ANN}> a <${v}entity/person> .`,
      `<${BO}> a <${v}entity/person> .`,
      `<${LAUNCH}> a <${v}chrono/event> ; ${SCHEMA_START} "2026-01-01T00:00:00Z" .`,
      `<${ANN}> <${v}edge/knows> <${BO}> .`,
      `<${BO}> <${v}edge/attends> <${LAUNCH}> .`,
      '',
    ].join('\n');
    const r = await d.importRest(writer.key, LANDS, file);
    const report = reportOf(r);
    assert.equal(report?.status, 'completed', `the import lands: ${JSON.stringify(report?.reasons ?? r.text).slice(0, 600)}`);
    const entities = await d.records(LANDS, 'entities');
    const byName = Object.fromEntries(entities.map(e => [e.name, e]));
    assert.deepEqual(Object.keys(byName).sort(), ['ann lee', 'bo'], 'each entity is named by its address\'s local name, percent-decoded');
    const chrono = await d.records(LANDS, 'chrono');
    assert.deepEqual(chrono.map(c => c.title), ['launch'], 'the chrono entry is titled by its address\'s local name');
    const edges = (await d.records(LANDS, 'edges')).map(e => `${e.from} ${e.label} ${e.to}`).sort();
    assert.deepEqual(edges, [`${byName['ann lee']._id} knows ${byName.bo._id}`, `${byName.bo._id} attends ${chrono[0]._id}`].sort(), 'both edges land between the records');
  });

  describe('a fact with no text, and an edge from it', () => {
    let report;
    before(async () => {
      const v = `${baseOf(REFUSES)}vocab/`;
      const file = [
        `<${NOTE}> a <${v}fact/note> .`,
        `<${BO}> a <${v}entity/person> ; ${RDFS_LABEL} "Bo" .`,
        `<${NOTE}> <${v}edge/cites> <${BO}> .`,
        '',
      ].join('\n');
      const r = await d.importRest(writer.key, REFUSES, file);
      assert.equal(r.status, 409, r.text.slice(0, 500));
      report = reportOf(r);
    });

    it('the fact is refused as missing-required-field naming fact, with the planner\'s own sentence', async () => {
      const fact = report.reasons.filter(x => x.kind === 'fact');
      assert.deepEqual(fact.map(x => [x.code, x.subject, x.fields]), [['missing-required-field', NOTE, ['fact']]], JSON.stringify(report.reasons).slice(0, 600));
      // The planner's sentence for a fact with no text: the shape check of its blank `fact`, asked of the server's own check.
      const { shapeError } = await import('../../server/dist/brain/write-shape.js');
      assert.equal(fact[0].message, shapeError('fact', { fact: '' }), 'the message is the planner\'s sentence');
    });

    it('the edge from the refused fact is end-refused, naming the fact\'s subject, never a schema violation', () => {
      const edge = report.reasons.filter(x => x.kind === 'edge');
      assert.deepEqual(edge.map(x => [x.code, x.end]), [['end-refused', NOTE]], JSON.stringify(report.reasons).slice(0, 600));
      assert.match(edge[0].message, /refused in this import/);
      assert.doesNotMatch(edge[0].message, /schema/);
      assert.equal(report.reasonsByCode.schema_violation, undefined, 'no reason is a schema violation');
    });
  });

  describe('an address that gives no name', () => {
    const v = `${baseOf(NONAME)}vocab/`;
    const KNOWN = 'http://people.example/known';
    /** Import one typed, unlabelled subject at `address`, with an edge to it from a labelled one; answers the report. */
    async function importAt(address, status) {
      const file = [
        `<${address}> a <${v}entity/person> .`,
        `<${KNOWN}> a <${v}entity/person> ; ${RDFS_LABEL} "Known" .`,
        `<${KNOWN}> <${v}edge/knows> <${address}> .`,
        '',
      ].join('\n');
      const r = await d.importRest(writer.key, NONAME, file);
      assert.equal(r.status, status, r.text.slice(0, 500));
      return reportOf(r);
    }

    for (const [title, address] of [
      ['a trailing slash', 'http://people.example/folder/'],
      ['a tail of blanks only', 'http://people.example/%20%20'],
      ['a control character in the tail', 'http://people.example/a%0Ab'],
    ]) {
      it(`${title} is refused as address-gives-no-name, naming the subject; the edge to it is end-refused`, async () => {
        const report = await importAt(address, 409);
        const entity = report.reasons.filter(x => x.kind === 'entity');
        assert.deepEqual(entity.map(x => [x.code, x.subject]), [['address-gives-no-name', address]], JSON.stringify(report.reasons).slice(0, 600));
        assert.doesNotMatch(entity[0].message, /http|%/, 'the sentence is generic: it quotes no part of the address');
        assert.deepEqual(report.reasons.filter(x => x.kind === 'edge').map(x => [x.code, x.end]), [['end-refused', address]]);
        assert.equal(report.reasonsByCode['missing-required-field'], undefined, 'it is not the generic required-field refusal');
      });
    }

    it('the local name is trimmed: blanks around it are not part of the name', async () => {
      const report = await importAt('http://people.example/%20padded%20', 200);
      assert.equal(report.status, 'completed', JSON.stringify(report.reasons).slice(0, 400));
      assert.deepEqual((await d.records(NONAME, 'entities')).map(e => e.name).sort(), ['Known', 'padded']);
    });
  });

  describe('a stored fact whose link points at a record that is not there (strict linkage turned on after the link was written)', () => {
    /** Seed the stored fact and its dangling link row in `space`; answers the import of the fact said again, with `more` statements added. */
    async function reimport(space, more = []) {
      await d.seed(space, 'fact', [{ _id: STORED_FACT, fact: 'a stored fact' }]);
      await d.seed(space, 'link', [{ _id: `dangling-${space}`, spaceId: space, from: STORED_FACT, fromKind: 'fact', to: GHOST, toKind: 'entity' }]);
      const v = `${baseOf(space)}vocab/`;
      const file = [`<${baseOf(space)}fact/${STORED_FACT}> a <${YTHRIL}Fact> ; ${SCHEMA_TEXT} "a stored fact, said again" .`, ...more.map(m => m(v)), ''].join('\n');
      const r = await d.importRest(writer.key, space, file);
      assert.equal(r.status, 409, r.text.slice(0, 500));
      return reportOf(r);
    }

    it('is stored-link-dangling in a generic sentence that quotes no id the file did not send', async () => {
      const report = await reimport(DANGLES);
      const fact = report.reasons.filter(x => x.kind === 'fact');
      assert.deepEqual(fact.map(x => x.code), ['stored-link-dangling'], JSON.stringify(report.reasons).slice(0, 600));
      assert.match(fact[0].message, /link this record already holds points at a record that does not exist; remove that link or turn strict linkage off/i);
      assert.equal(fact[0].end, undefined, 'no end is named: the end is not one the file sent');
      assert.ok(!JSON.stringify(report).includes(GHOST), 'the stored id appears nowhere in the report');
    });

    it('is still stored-link-dangling when the fact also links a record this import refused', async () => {
      const report = await reimport(MIXED, [
        (v) => `<http://people.example/blank-label> a <${v}entity/person> ; ${RDFS_LABEL} "" .`,
        () => `<${baseOf(MIXED)}fact/${STORED_FACT}> ${REFERENCES} <http://people.example/blank-label> .`,
      ]);
      const fact = report.reasons.filter(x => x.kind === 'fact');
      assert.deepEqual(fact.map(x => x.code), ['stored-link-dangling'], `the stored link is the cause that stays after the refused end is fixed: ${JSON.stringify(report.reasons).slice(0, 700)}`);
      assert.ok(!JSON.stringify(report).includes(GHOST), 'the stored id appears nowhere in the report');
    });
  });
});
