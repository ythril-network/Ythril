/**
 * A SPARQL Update is evaluated into a change set, never into the records: the statements it removes and the statements it inserts, part by
 * part, bounded, with every wall of the query path kept (bundle-272, Q-965; design f, r2 R11, vet-1 S1 and S4).
 *
 * ## The rules
 *
 * 1. **The change set.** INSERT DATA gives its statements as inserted, DELETE DATA as removed, DELETE/INSERT WHERE both, each in the space's
 *    own graph (a statement written without a graph is the space's). The source the WHERE reads is never written.
 * 2. **Part by part.** A composite (`;`) is evaluated in order: each part reads the source plus the change set of the parts before it, so an
 *    INSERT sees an earlier part's insert and no longer sees what an earlier part deleted.
 * 3. **Bounded.** A cross-product INSERT stops at the quad cap with `413 sparql_too_many_changes`; the change set's store refuses
 *    `deleteGraph` and `removeMatches`.
 * 4. **An allowlist.** Only INSERT DATA, DELETE DATA, DELETE/INSERT and their composites run. CLEAR, DROP, CREATE, ADD, MOVE, COPY, LOAD and
 *    any GRAPH, USING, WITH or `using-graph-uri` naming a graph other than the space's own are `400 sparql_graph_management_refused`; the
 *    space's own graph named the same ways runs (the control).
 * 5. **The query door is unchanged.** A query text that is an update is still `400 sparql_update_not_here`, and an update's algebra handed to
 *    the query runner (`runSparql`) is refused by its read-only context and writes nothing into its source.
 *
 * ## Seen red
 *
 * On 3f48206ac: `server/src/rdf/sparql-update-eval.ts` does not exist, and `sparql-engine.ts` exports no `checkSparqlUpdateAlgebra`.
 * Mutations of the built server after, each seen red: `readOnly` dropped from the query context together with `runSparql`'s refusal of a
 * void result made to execute it (rule 5: "the query runner wrote an update into its source"; either wall alone holds the rule, and with
 * only the second removed the rule stays green); each part reading the source without the earlier parts laid over it (rule 2); the fold
 * recording a taken-back insert as removed (rule 2's DELETE case); the meter's statement cap check removed (rule 3); the graph-name check
 * of the update walk removed (rule 4).
 *
 * Run: npm run build:server, then node --test testing/standalone/a-sparql-update-is-evaluated-into-a-bounded-change-set.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { Store, DataFactory } from 'n3';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

const { namedNode, literal, quad } = DataFactory;
const G = 'https://rdf.example.org/ld/upd/';
const OTHER = 'https://rdf.example.org/ld/other/';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const KNOWS = `${G}vocab/knows`;
const TAG = `${G}vocab/tag`;
const e = (n) => `${G}entity/${n}`;

/** The source: three people with labels, in the space's graph. */
const sourceStore = () => new Store(['a', 'b', 'c'].map(n => quad(namedNode(e(n)), namedNode(LABEL), literal(`Name ${n}`), namedNode(G))));

/** A statement as one comparable line. */
const line = (q) => [q.subject, q.predicate, q.object, q.graph].map(t => (t.termType === 'Literal' ? `"${t.value}"` : `<${t.value}>`)).join(' ');
const lines = (qs) => qs.map(line).sort();

let engine, evalMod, storeMod;
const deadline = () => Date.now() + 20_000;

/** Check `text` as an Update of the space G and evaluate it over `store`; the refusal, or the change set. */
async function update(text, store, opts = {}) {
  const { checkSparqlUpdateAlgebra } = needModule(engine, ['checkSparqlUpdateAlgebra'], 'the SPARQL engine\'s update check');
  const { changeSetOf } = needModule(evalMod, ['changeSetOf'], 'the update evaluation');
  const checked = await checkSparqlUpdateAlgebra(text, G, opts.using);
  if ('refusal' in checked) return { refusal: checked.refusal };
  try {
    return { changes: await changeSetOf(checked.algebra, store, G, { deadline: deadline(), ...opts }) };
  } catch (err) {
    return { error: err };
  }
}

const must = (got) => {
  assert.equal(got.refusal, undefined, `refused: ${JSON.stringify(got.refusal)}`);
  assert.ifError(got.error);
  return got.changes;
};

describe('a SPARQL Update is evaluated into a bounded change set', () => {
  before(async () => {
    engine = await loadDistModule('../../server/dist/rdf/sparql-engine.js', import.meta.url);
    evalMod = await loadDistModule('../../server/dist/rdf/sparql-update-eval.js', import.meta.url);
    storeMod = await loadDistModule('../../server/dist/rdf/change-set-store.js', import.meta.url);
  });

  it('INSERT DATA and DELETE DATA give their statements as inserted and removed, in the space\'s graph, and the source is not written', async () => {
    const store = sourceStore();
    const ins = must(await update(`INSERT DATA { <${e('a')}> <${KNOWS}> <${e('b')}> }`, store));
    assert.deepEqual(lines(ins.inserted), [`<${e('a')}> <${KNOWS}> <${e('b')}> <${G}>`]);
    assert.deepEqual(ins.removed, []);
    const del = must(await update(`DELETE DATA { <${e('a')}> <${LABEL}> "Name a" }`, store));
    assert.deepEqual(lines(del.removed), [`<${e('a')}> <${LABEL}> "Name a" <${G}>`]);
    assert.deepEqual(del.inserted, []);
    assert.equal(store.size, 3, 'the evaluation wrote into its source');
  });

  it('DELETE/INSERT WHERE gives the removed and inserted statements its WHERE binds', async () => {
    const store = sourceStore();
    const got = must(await update(`DELETE { ?s <${LABEL}> ?n } INSERT { ?s <${TAG}> ?n } WHERE { ?s <${LABEL}> ?n FILTER(?n != "Name c") }`, store));
    assert.deepEqual(lines(got.removed), [`<${e('a')}> <${LABEL}> "Name a" <${G}>`, `<${e('b')}> <${LABEL}> "Name b" <${G}>`]);
    assert.deepEqual(lines(got.inserted), [`<${e('a')}> <${TAG}> "Name a" <${G}>`, `<${e('b')}> <${TAG}> "Name b" <${G}>`]);
    assert.equal(store.size, 3, 'the evaluation wrote into its source');
  });

  it('a composite is evaluated part by part: an INSERT sees an earlier part\'s insert', async () => {
    const got = must(await update([
      `INSERT DATA { <${e('a')}> <${KNOWS}> <${e('b')}> }`,
      `INSERT { ?x <${TAG}> "known" } WHERE { ?s <${KNOWS}> ?x }`,
    ].join(' ;\n'), sourceStore()));
    assert.deepEqual(lines(got.inserted), [`<${e('a')}> <${KNOWS}> <${e('b')}> <${G}>`, `<${e('b')}> <${TAG}> "known" <${G}>`]);
    assert.equal(got.parts, 2);
  });

  it('a composite DELETE: a later part no longer sees what an earlier part deleted, and a re-insert cancels the removal', async () => {
    const got = must(await update([
      `DELETE DATA { <${e('a')}> <${LABEL}> "Name a" }`,
      `INSERT { ?s <${TAG}> "still" } WHERE { ?s <${LABEL}> ?n }`,
      `INSERT DATA { <${e('b')}> <${KNOWS}> <${e('c')}> }`,
      `DELETE DATA { <${e('b')}> <${KNOWS}> <${e('c')}> }`,
    ].join(' ;\n'), sourceStore()));
    assert.deepEqual(lines(got.removed), [`<${e('a')}> <${LABEL}> "Name a" <${G}>`]);
    assert.deepEqual(lines(got.inserted), [`<${e('b')}> <${TAG}> "still" <${G}>`, `<${e('c')}> <${TAG}> "still" <${G}>`],
      'the second part read a statement the first part deleted, or the last part\'s delete left its own insert standing');
  });

  it('a cross-product INSERT stops at the quad cap with 413 sparql_too_many_changes', async () => {
    const store = sourceStore();
    const got = await update(`INSERT { ?a <${KNOWS}> ?b } WHERE { ?a <${LABEL}> ?x . ?b <${LABEL}> ?y }`, store, { maxQuads: 5 });
    assert.equal(got.refusal, undefined, `refused before it ran: ${JSON.stringify(got.refusal)}`);
    assert.equal(got.changes, undefined, `a change set of ${got.changes?.inserted?.length} statements came back past a cap of 5`);
    assert.equal(got.error?.code, 'sparql_too_many_changes', `answered ${got.error?.message}`);
    assert.equal(got.error.status, 413);
    const under = must(await update(`INSERT { ?a <${KNOWS}> ?b } WHERE { ?a <${LABEL}> ?x . ?b <${LABEL}> ?y }`, store, { maxQuads: 9 }));
    assert.equal(under.inserted.length, 9, 'the control at the cap');
  });

  it('the change set\'s store refuses deleteGraph and removeMatches', () => {
    const { ChangeSetStore, ChangeMeter } = needModule(storeMod, ['ChangeSetStore', 'ChangeMeter'], 'the change set store');
    const s = new ChangeSetStore({ graph: G, meter: new ChangeMeter(100, 1_000_000) });
    for (const [what, call] of [['deleteGraph', () => s.deleteGraph(namedNode(G))], ['removeMatches', () => s.removeMatches()]]) {
      assert.throws(call, (err) => err.code === 'sparql_graph_management_refused' && err.status === 400, `${what} was not refused`);
    }
  });

  const REFUSED = [
    ['CLEAR GRAPH', `CLEAR GRAPH <${G}>`],
    ['CLEAR ALL', 'CLEAR ALL'],
    ['DROP', `DROP GRAPH <${G}>`],
    ['CREATE', `CREATE GRAPH <${OTHER}>`],
    ['ADD', `ADD <${G}> TO <${OTHER}>`],
    ['MOVE', `MOVE <${G}> TO <${OTHER}>`],
    ['COPY', `COPY <${G}> TO <${OTHER}>`],
    ['LOAD', `LOAD <${OTHER}doc>`],
    ['GRAPH naming another graph in WHERE', `INSERT { ?s <${TAG}> "x" } WHERE { GRAPH <${OTHER}> { ?s ?p ?o } }`],
    ['GRAPH naming another graph in the template', `INSERT { GRAPH <${OTHER}> { ?s <${TAG}> "x" } } WHERE { ?s ?p ?o }`],
    ['INSERT DATA into another graph', `INSERT DATA { GRAPH <${OTHER}> { <${e('a')}> <${TAG}> "x" } }`],
    ['USING another graph', `INSERT { ?s <${TAG}> "x" } USING <${OTHER}> WHERE { ?s ?p ?o }`],
    ['USING NAMED another graph', `INSERT { ?s <${TAG}> "x" } USING NAMED <${OTHER}> WHERE { ?s ?p ?o }`],
    ['WITH another graph', `WITH <${OTHER}> INSERT { ?s <${TAG}> "x" } WHERE { ?s ?p ?o }`],
    ['a part of a composite', `INSERT DATA { <${e('a')}> <${TAG}> "x" } ; DROP ALL`],
  ];
  for (const [what, text] of REFUSED) {
    it(`${what} is refused 400 sparql_graph_management_refused`, async () => {
      const store = sourceStore();
      const got = await update(text, store);
      assert.equal(got.refusal?.code, 'sparql_graph_management_refused', `${what} answered ${JSON.stringify(got.refusal ?? got.error?.message ?? got.changes)}`);
      assert.equal(got.refusal.status, 400);
      assert.equal(store.size, 3);
    });
  }

  it('using-graph-uri naming another graph is refused; naming the space\'s own runs', async () => {
    const text = `INSERT { ?s <${TAG}> "x" } WHERE { ?s <${LABEL}> "Name a" }`;
    const other = await update(text, sourceStore(), { using: { defaultGraphUri: [OTHER] } });
    assert.equal(other.refusal?.code, 'sparql_graph_management_refused', JSON.stringify(other.refusal ?? other.changes));
    const named = await update(text, sourceStore(), { using: { namedGraphUri: [OTHER] } });
    assert.equal(named.refusal?.code, 'sparql_graph_management_refused', JSON.stringify(named.refusal ?? named.changes));
    const own = must(await update(text, sourceStore(), { using: { defaultGraphUri: [G] } }));
    assert.deepEqual(lines(own.inserted), [`<${e('a')}> <${TAG}> "x" <${G}>`]);
  });

  it('the space\'s own graph named by GRAPH, WITH and USING runs (the control for the refusals)', async () => {
    for (const text of [
      `INSERT { GRAPH <${G}> { ?s <${TAG}> "x" } } WHERE { GRAPH <${G}> { ?s <${LABEL}> "Name a" } }`,
      `WITH <${G}> INSERT { ?s <${TAG}> "x" } WHERE { ?s <${LABEL}> "Name a" }`,
      `INSERT { ?s <${TAG}> "x" } USING <${G}> WHERE { ?s <${LABEL}> "Name a" }`,
    ]) {
      const got = must(await update(text, sourceStore()));
      assert.deepEqual(lines(got.inserted), [`<${e('a')}> <${TAG}> "x" <${G}>`], text);
    }
  });

  it('a query text on the update path is refused, and SERVICE and REGEX keep their walls there', async () => {
    const q = await update(`SELECT * WHERE { ?s ?p ?o }`, sourceStore());
    assert.equal(q.refusal?.code, 'sparql_not_an_update', JSON.stringify(q.refusal ?? q.changes));
    const svc = await update(`INSERT { ?s <${TAG}> "x" } WHERE { SERVICE <http://127.0.0.1:1/> { ?s ?p ?o } }`, sourceStore());
    assert.equal(svc.refusal?.code, 'sparql_federation_refused', JSON.stringify(svc.refusal ?? svc.changes));
    const rx = await update(`INSERT { ?s <${TAG}> "x" } WHERE { ?s ?p ?o FILTER(REGEX(?o, "(a+)+$")) }`, sourceStore());
    assert.equal(rx.refusal?.code, 'sparql_pattern_refused', JSON.stringify(rx.refusal ?? rx.changes));
  });

  it('the query door still refuses an update text, and the query runner writes nothing when handed an update\'s algebra', async () => {
    const { checkSparqlAlgebra, runSparql, checkSparqlUpdateAlgebra } = needModule(engine, ['checkSparqlAlgebra', 'runSparql', 'checkSparqlUpdateAlgebra'], 'the SPARQL engine');
    const text = `INSERT DATA { <${e('a')}> <${KNOWS}> <${e('b')}> }`;
    const asQuery = await checkSparqlAlgebra(text);
    assert.equal(asQuery.refusal?.code, 'sparql_update_not_here', JSON.stringify(asQuery));
    const checked = await checkSparqlUpdateAlgebra(text, G);
    assert.ok('algebra' in checked, JSON.stringify(checked.refusal));
    const store = sourceStore();
    await assert.rejects(async () => { const r = await runSparql(checked.algebra, store, { deadline: deadline() }); await r.rows(); });
    assert.equal(store.size, 3, 'the query runner wrote an update into its source');
  });
});
