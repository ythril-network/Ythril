/**
 * A retrieval run records the request it made and tells a failed call apart from an empty answer.
 *
 * ## The first increment of `B-6`, and what it is rebuilding from
 *
 * `#1282` deleted a graded runner — 56 files, on the owner's instruction — because everything in it rested
 * on one premise: a conversation is a pile of transcript chunks. At an equal byte budget the best of twelve
 * strategies answered 50.8% at rank 1, and multi-hop scored **0.0% under every one of them**.
 *
 * So the rebuild retrieves from the graph the writer produces, and this is the half that needs no model.
 *
 * ## The two rules worth a test each
 *
 * **A failed call is not a zero score.** If a broken instance reported as "no results", a run against a
 * down service would publish a low number rather than an error, and nothing in the report would say which
 * it was. That is the single most damaging confusion a benchmark can carry.
 *
 * **A run that cannot say what it asked cannot be reproduced.** `topK` and the traversal depth are part of
 * what a figure means, and the protocol requires them named. Reconstructing them afterwards from the
 * settings a caller BELIEVES it passed is the shape that makes two runs incomparable.
 *
 * ## And it must not reach a question set
 *
 * `loadQuestions` exists. This module takes a question STRING from its caller and never imports it — the
 * separation is kept on this side of the pipeline too, because a convenience import is how the extraction
 * side would come to see an answer key.
 *
 * Run: node --test testing/standalone/a-retrieval-run-says-what-it-asked.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { retrieveOne, retrieveAll, runReport } from '../../benchmarks/harness/retrieve.mjs';

/** A client that answers from a script, and records what it was asked. */
function stubYthril(answers) {
  const asked = [];
  return {
    asked,
    recall: async (request) => {
      asked.push(request);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? { results: [] };
    },
  };
}

const hit = (over = {}) => ({ score: 0.9, type: 'fact', record: { _id: 'id-1', fact: 'Ada works at Beta.', ...over } });

describe('one question', () => {
  it('asks what it was told to and flattens the answer', async () => {
    const ythril = stubYthril([{ results: [hit()] }]);
    const r = await retrieveOne({ ythril, space: 's', question: 'where does Ada work', topK: 3, traverse: 2 });
    assert.deepEqual(ythril.asked, [{ space: 's', query: 'where does Ada work', topK: 3, traverse: 2 }]);
    assert.deepEqual(r.hits, [{ id: 'id-1', kind: 'fact', text: 'Ada works at Beta.', score: 0.9 }]);
  });

  it('returns the request alongside the answer', async () => {
    // Not decoration: `topK` and the depth are part of what a number means, and a report that
    // reconstructs them from what the caller THINKS it passed is how two runs stop being comparable.
    const ythril = stubYthril([{ results: [] }]);
    const r = await retrieveOne({ ythril, space: 's', question: 'q' });
    assert.equal(r.request.space, 's');
    assert.equal(r.request.query, 'q');
    assert.equal(typeof r.request.topK, 'number');
  });

  it('carries the superseded mark, because it changes what the text means', async () => {
    // A grader that cannot see it scores a correct historical answer as a wrong current one, or the
    // reverse. Only ever present when true.
    const ythril = stubYthril([{ results: [hit({ superseded: true }), hit({ _id: 'id-2' })] }]);
    const r = await retrieveOne({ ythril, space: 's', question: 'q' });
    assert.equal(r.hits[0].superseded, true);
    assert.equal('superseded' in r.hits[1], false, 'a current record must carry no mark at all');
  });

  it('the records the TRAVERSAL reached are hits too, once each, and say how they were reached', async () => {
    /*
     * Found 2026-09-23 on the first run against a 5.x instance. Recall nests what a traversal reaches
     * under each match's `_graph`, and this flattened `results` alone — so a run recorded `traverse: 1` in
     * its request and handed the answerer none of what the traversal found. That is the multi-hop half of
     * the graph, the half `#1282` was deleted for failing, dropped by a reader rather than by the retriever.
     */
    const reached = (id, name, label, deeper) => ({
      edges: [{ label, direction: 'out' }], node: { _id: id, name }, paths: [['m', id]],
      ...(deeper ? { _graph: deeper } : {}),
    });
    const ythril = stubYthril([{ results: [
      { ...hit({ _id: 'm' }), _graph: [reached('e1', 'Beta Corp', 'works_at', [reached('e2', 'Berlin', 'located_in')])] },
      { ...hit({ _id: 'm2', fact: 'Ada joined Beta in May.' }), _graph: [reached('e1', 'Beta Corp', 'works_at')] },
    ] }]);
    const r = await retrieveOne({ ythril, space: 's', question: 'where does Ada work', traverse: 2 });
    const ids = r.hits.map(h => h.id);
    assert.deepEqual(ids, ['m', 'm2', 'e1', 'e2'], 'matches first, then every traversed node, each once');
    const e1 = r.hits.find(h => h.id === 'e1');
    assert.equal(e1.text, 'Beta Corp');
    assert.equal(e1.via, 'traverse');
    assert.equal(e1.relation, 'works_at', 'the edge label is what makes a reached name mean something');
    assert.equal('via' in r.hits[0], false, 'a match carries no traversal mark');
  });

  it('a dated record carries its date, because for a timeline entry the date IS the content', async () => {
    const ythril = stubYthril([{ results: [
      { score: 0.8, type: 'chrono', record: { _id: 'c1', title: 'Jon visited Paris', startsAt: '2023-01-28T00:00:00Z' } },
      { score: 0.7, type: 'chrono', record: { _id: 'c2', title: 'Trip', startsAt: '2023-06-12T00:00:00Z', endsAt: '2023-06-18T00:00:00Z' } },
    ] }]);
    const r = await retrieveOne({ ythril, space: 's', question: 'when was Jon in Paris' });
    assert.equal(r.hits[0].when, '2023-01-28');
    assert.equal(r.hits[1].when, '2023-06-12 to 2023-06-18');
  });

  it('A FAILED CALL IS NOT AN EMPTY RESULT', async () => {
    // The one that matters most. Conflating them makes a run against a down instance publish a low score
    // instead of an error, and nothing in the report distinguishes them afterwards.
    const ythril = stubYthril([new Error('connect ECONNREFUSED')]);
    const r = await retrieveOne({ ythril, space: 's', question: 'q' });
    assert.match(r.error, /ECONNREFUSED/);
    assert.deepEqual(r.hits, []);
    assert.equal(r.request.query, 'q', 'the report must still be able to say which question could not be asked');
  });

  it('refuses a missing space or question rather than scoring zero for one', async () => {
    const ythril = stubYthril([]);
    await assert.rejects(() => retrieveOne({ ythril, question: 'q' }), /needs a space/);
    await assert.rejects(() => retrieveOne({ ythril, space: 's', question: '  ' }), /needs a question string/);
  });
});

describe('many questions', () => {
  it('keeps going after one fails, and keeps the order', async () => {
    const ythril = stubYthril([{ results: [hit()] }, new Error('boom'), { results: [hit({ _id: 'id-3' })] }]);
    const rs = await retrieveAll({ ythril, space: 's', questions: ['a', 'b', 'c'] });
    assert.deepEqual(rs.map(r => r.request.query), ['a', 'b', 'c'],
      'sequential and in order — parallel calls finish differently each run and make two runs of one '
      + 'configuration produce a diff nobody can attribute');
    assert.equal(rs[1].error, 'boom');
    assert.equal(rs[2].hits[0].id, 'id-3');
  });
});

describe('the report', () => {
  it('counts asked, answered and failed apart', async () => {
    const ythril = stubYthril([{ results: [hit()] }, new Error('boom')]);
    const results = await retrieveAll({ ythril, space: 's', questions: ['a', 'b'] });
    const rep = runReport({ space: 's', conversationId: 'conv-30', results, config: { topK: 10, traverse: 1 } });
    assert.deepEqual([rep.asked, rep.answered, rep.failed], [2, 1, 1]);
  });

  it('names the model and seed fields even when nothing ran', async () => {
    // Present-and-null says "no model ran", which is a fact about the run. A report that OMITS what it did
    // not use reads identically to one written before anybody thought to record it — and `B-2`'s whole
    // complaint about self-reported figures is the column they leave out.
    const rep = runReport({ space: 's', conversationId: 'c', results: [] });
    for (const k of ['answererModel', 'judgeModel', 'seed', 'commit']) {
      assert.ok(k in rep.config, `the report does not mention ${k}, so a reader cannot tell it was unused`);
      assert.equal(rep.config[k], null);
    }
  });
});

describe('the separation from the question set', () => {
  it('the module does not import the question loader', () => {
    // Enforced rather than promised. `loadQuestions` is one import away, and the day somebody adds it for
    // convenience is the day the extraction side can reach an answer key through this file.
    const src = readFileSync('benchmarks/harness/retrieve.mjs', 'utf8');
    assert.equal(/^\s*import[^\n]*loadQuestions/m.test(src), false,
      'retrieve.mjs imports the question loader. It takes a question STRING from its caller; choosing '
      + 'which questions to ask is a different module with a different contract.');
    assert.equal(/from '.*locomo\/loader/.test(src), false, 'and it does not reach the corpus loader either');
  });
});
