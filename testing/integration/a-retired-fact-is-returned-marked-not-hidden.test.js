/**
 * Integration: a fact that is no longer true still ranks, and says so.
 *
 * ## The decision, and the option it rejected
 *
 * Owner, 2026-09-19: *"superseded status and a supersedes edge win i think"* — answering a proposal that a
 * retired fact be stored with no vector, the way an attributed claim is. The objection was a question:
 *
 * > *"what if you ask 'where did ada work?' or 'list all workplaces' - A kills that."*
 *
 * It does. A record with no vector cannot be ranked even deliberately, so suppressing the loser would make
 * every historical question unanswerable to buy a fix for one present-tense one. **So the mark does not
 * touch the vector.** A superseded fact embeds, ranks and is returned exactly as before, carrying one extra
 * field that says it has been overtaken. The caller decides what that means; retrieval does not decide for
 * them.
 *
 * ## Why the status and the edge are not two copies of one fact
 *
 * They answer different questions, and either can be true without the other:
 *
 * | | says | stands alone when |
 * |---|---|---|
 * | `superseded: true` on the record | this is no longer true | nothing replaced it — Ada left Acme and is not working |
 * | a `supersedes` edge | THIS replaced THAT | the reader wants the current answer, not just a warning |
 *
 * Writing the winner's id into a field as well would be the second copy, and the one that goes stale.
 *
 * ## The edge half is walkable, which is why it is half the answer
 *
 * Measured 2026-09-19, with the failed run of the same probe as its control — the only difference between
 * them being whether the edge write landed:
 *
 * | edge | walk from the newer fact |
 * |---|---|
 * | none (the write 400'd) | 1 node: itself |
 * | `supersedes` stored | 2 nodes, reaching the older fact |
 *
 * A fact→fact edge IS followed as of 5.0. The earlier measurement that said otherwise started its walk at
 * the ENTITY both facts hang off, where each is reached by a LINK — and a linked record is a leaf that does
 * not join the next frontier, so the edge between them could never have appeared. One mechanism checked,
 * both concluded about.
 *
 * Run: node --test testing/integration/a-retired-fact-is-returned-marked-not-hidden.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `superseded-${RUN}`;

let tokenA;
let ada;
let older;
let newer;
const P = (p, body) => post(INSTANCES.a, tokenA, p, body);

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const sp = await P('/api/spaces', { id: SPACE, label: `Superseded ${RUN}` });
  assert.equal(sp.status, 201, `create space: ${JSON.stringify(sp.body)}`);

  const e = await P(`/api/brain/spaces/${SPACE}/entities`, {
    name: `Ada ${RUN}`, type: 'person', description: 'The person both claims are about.',
  });
  ada = e.body?._id;
  assert.ok(ada, `entity: ${JSON.stringify(e.body)}`);

  // The retired claim is written already marked, which is the create half of the capability: an agent that
  // learns the correction and the history in one turn must not need two writes and a window between them.
  const o = await P(`/api/brain/spaces/${SPACE}/facts`, {
    fact: `Ada ${RUN} works at Acme as a platform engineer.`,
    linkEntities: [ada], superseded: true, waitForEmbedding: true,
  });
  assert.equal(o.status, 201, `older fact: ${JSON.stringify(o.body)}`);
  older = o.body._id;

  const n = await P(`/api/brain/spaces/${SPACE}/facts`, {
    fact: `Ada ${RUN} left Acme and works at Beta as a platform engineer.`,
    linkEntities: [ada], waitForEmbedding: true,
  });
  assert.equal(n.status, 201, `newer fact: ${JSON.stringify(n.body)}`);
  newer = n.body._id;

  const edge = await P(`/api/brain/spaces/${SPACE}/edges`, {
    from: newer, fromKind: 'fact', to: older, toKind: 'fact', label: 'supersedes',
  });
  assert.equal(edge.status, 201, `supersedes edge: ${JSON.stringify(edge.body)}`);
});

describe('the retired fact is still ranked', () => {
  it('a recall for the present-tense question returns BOTH claims', async () => {
    const res = await P('/api/brain/recall', { space: SPACE, query: `where does Ada ${RUN} work`, topK: 10 });
    assert.equal(res.status, 200, `recall: ${JSON.stringify(res.body)}`);
    const ids = (res.body?.results ?? []).map(r => r.record?._id);

    // THE CONTROL FOR THE WHOLE DESIGN. If the mark suppressed the vector — the option the owner rejected —
    // this is the assertion that would fail, and "where did Ada work?" would have no answer at all.
    assert.ok(ids.includes(older),
      'a superseded fact must keep its vector and keep ranking; hiding it is what kills the historical '
      + `question. Got ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(newer), `the current fact must rank too — got ${JSON.stringify(ids)}`);
  });

  it('and the caller can tell which of the two is retired', async () => {
    const res = await P('/api/brain/recall', { space: SPACE, query: `where does Ada ${RUN} work`, topK: 10 });
    const byId = new Map((res.body?.results ?? []).map(r => [r.record?._id, r.record]));
    assert.equal(byId.get(older)?.superseded, true,
      'the retired claim comes back unmarked, so a caller reading the answer has two contradictory facts '
      + 'and nothing to choose between them — which is the whole defect.');
    assert.ok(byId.get(newer)?.superseded === undefined || byId.get(newer)?.superseded === false,
      'the current claim must NOT be marked');
  });
});

describe('the edge carries what replaced it', () => {
  it('a walk starting at the current fact reaches the one it retired', async () => {
    const res = await P(`/api/brain/spaces/${SPACE}/traverse`, {
      startId: newer, maxDepth: 2, direction: 'both',
    });
    assert.equal(res.status, 200, `traverse: ${JSON.stringify(res.body)}`);
    const ids = (res.body?.nodes ?? []).map(n => n._id);
    assert.ok(ids.includes(older),
      'the `supersedes` edge is what tells a reader WHICH claim replaced this one. A status with no edge '
      + `says only "do not trust me" — got ${JSON.stringify(ids)}`);
  });
});

describe('the mark is an ordinary field, so it filters', () => {
  it('a query can ask for only what is still believed', async () => {
    // `/api/filter` is the `query` tool behind the generic tool door, so the envelope is `{ok, text, data}`
    // and the Mongo grammar is the one it speaks — `$ne`, not recall's bare `ne`.
    const res = await P('/api/filter', {
      space: SPACE, collection: 'facts', filter: { superseded: { $ne: true } }, limit: 50,
    });
    assert.equal(res.status, 200, `filter: ${JSON.stringify(res.body)}`);
    const ids = (res.body?.data?.results ?? []).map(r => r._id);
    assert.ok(ids.includes(newer), `the current fact must survive the filter — got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes(older),
      'a caller that wants only current facts must be able to say so on the read side, or the mark is '
      + `decoration — got ${JSON.stringify(ids)}`);
  });
});
