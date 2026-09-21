/**
 * Integration: a suppressed record cannot be RANKED, and is still REACHED by the expansion.
 *
 * ## The promise, and where it is made
 *
 * `suppressEmbeddings` is documented in three schema descriptions as removing the vector rather than adding
 * a filter, with the consequence spelled out: *"a suppressed record cannot be RANKED by recall even
 * deliberately… Everything that does not rank still reaches it in full — filter, list, get, the
 * `graph_traverse` tool, AND recall's own `traverse` expansion, which walks edges out of a match and never
 * consults a vector."*
 *
 * It is not an incidental property. The owner asked for it in as many words, 2026-08-15: *"excludefromvector
 * does also exclude from recalls traversal? ambigous and i want entries to be findable via traversal even if
 * they are not embedded themselves."* The field was renamed on the strength of that answer.
 *
 * **And nothing tested the half that matters.** The suite proves suppression is stored, that `false` is
 * stored rather than dropped, and that a re-embed sweep skips it. That a suppressed record is still REACHED
 * was asserted nowhere — a promise living in three descriptions and no gate, which is this repository's most
 * expensive shape: nobody reports a capability they were told they had.
 *
 * ## Why an integration test
 *
 * Both halves are runtime. "Cannot be ranked" is a property of what `$vectorSearch` holds, and "is still
 * reached" is a property of a BFS that runs against stored links. A source gate can read the flag's plumbing
 * and say nothing about either — and the neighbouring `traverse-chrono` suite exists because a source gate
 * passed on a version that returned nothing for the commonest case.
 *
 * ## The control is the point
 *
 * Every assertion below is paired with an identical UNSUPPRESSED record. Without it, "recall did not return
 * the suppressed record" is equally good evidence that recall returned nothing at all, and "the walk reached
 * it" is equally good evidence that the walk returns everything.
 *
 * Run: node --test testing/integration/a-suppressed-record-is-unranked-but-still-reached.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, readCollection, waitForIndexed } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `suppressed-reach-${RUN}`;

let tokenA;
const ids = {};
const P = (p, body) => post(INSTANCES.a, tokenA, p, body);

/** A phrase nothing else in the space says, so a recall for it can only match these two records. */
const PHRASE = `quokka telemetry cadence ${RUN}`;

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const sp = await P('/api/spaces', { id: SPACE, label: `Suppressed reach ${RUN}` });
  assert.equal(sp.status, 201, `create space: ${JSON.stringify(sp.body)}`);

  const subject = await P(`/api/brain/spaces/${SPACE}/entities`, {
    name: `Telemetry Service ${RUN}`, type: 'concept',
    description: 'The service both facts below are about, and the seed every walk starts from.',
  });
  ids.subject = subject.body?._id;
  assert.ok(ids.subject, `entity: ${JSON.stringify(subject.body)}`);

  // THE CONTROL: same subject, same distinctive phrase, ranked normally.
  const ranked = await P(`/api/brain/spaces/${SPACE}/facts`, {
    fact: `The ranked note about ${PHRASE}.`, entityIds: [ids.subject],
  });
  ids.ranked = ranked.body?._id;

  // THE SUBJECT: identical in every way except that it carries no vector.
  const quiet = await P(`/api/brain/spaces/${SPACE}/facts`, {
    fact: `The suppressed note about ${PHRASE}.`, entityIds: [ids.subject], suppressEmbeddings: true,
  });
  ids.quiet = quiet.body?._id;
  assert.ok(ids.ranked && ids.quiet, `facts: ${JSON.stringify([ranked.body, quiet.body])}`);

  /*
   * WAIT FOR THE CONTROL TO BE INDEXED, and only the control.
   *
   * This file had no wait at all and was relying on recall's fresh-write scan to answer for a record
   * written moments earlier. That scan covers a record whose embedding is still PENDING — so there is a
   * window, after the embed job finishes and before `$vectorSearch` has the vector, where neither path
   * finds it. CI landed in it: the control was absent from its own phrase and the case failed saying so,
   * which is the failure a missing wait produces and not a defect in suppression.
   *
   * The suppressed record is deliberately NOT waited for. It never gets a vector, so waiting for it would
   * time out on correct behaviour — and it is the whole subject of the file.
   */
  await waitForIndexed(INSTANCES.a, tokenA, SPACE, [ids.ranked], ['fact']);
});

describe('the fixture is what the assertions assume', () => {
  it('both facts are stored, and only one of them says it is suppressed', async () => {
    // A floor. If the write silently dropped the flag, every assertion below would be about two identical
    // records and would pass for the wrong reason.
    const r = await readCollection(INSTANCES.a, tokenA, SPACE, 'facts', { limit: 50 });
    const rows = r.results ?? [];
    const quiet = rows.find(x => x._id === ids.quiet);
    const ranked = rows.find(x => x._id === ids.ranked);
    assert.ok(quiet && ranked, 'both facts must be readable through a structured read');
    assert.equal(quiet.suppressEmbeddings, true, 'the suppressed one must carry the flag as stored');
    assert.notEqual(ranked.suppressEmbeddings, true, 'the control must NOT be suppressed');
  });
});

describe('a suppressed record cannot be ranked', () => {
  it('recall returns the control for the phrase and never the suppressed one', async () => {
    const res = await P('/api/brain/recall', { space: SPACE, query: PHRASE, topK: 20 });
    assert.equal(res.status, 200, `recall: ${JSON.stringify(res.body)}`);
    const got = (res.body?.results ?? []).map(x => x.record?._id ?? x._id);

    // The control proves the query works. Without it an empty answer would satisfy the next line.
    assert.ok(got.includes(ids.ranked),
      `the unsuppressed control must be ranked for its own phrase — got ${JSON.stringify(got)}`);
    assert.ok(!got.includes(ids.quiet),
      'a suppressed record has no vector, so nothing can rank it — not even a query made of its own words');
  });
});

describe('and is still reached, which is the half nothing tested', () => {
  it('the graph_traverse tool reaches it from the entity it names', async () => {
    const res = await P(`/api/brain/spaces/${SPACE}/traverse`, {
      startId: ids.subject, maxDepth: 1, direction: 'both', includeMemories: true,
    });
    assert.equal(res.status, 200, `traverse: ${JSON.stringify(res.body)}`);
    const reached = (res.body?.nodes ?? []).map(n => n._id ?? n.record?._id);
    assert.ok(reached.includes(ids.quiet),
      `the walk follows links and never consults a vector, so it must reach the suppressed record — `
      + `reached ${JSON.stringify(reached)}`);
    assert.ok(reached.includes(ids.ranked), 'and the control, or the walk is not returning facts at all');
  });

  it("recall's own expansion reaches it from a match", async () => {
    /*
     * The property everything else rests on. The seed is the ENTITY — matched on its own description — and
     * the suppressed fact is reached through `fact.entityIds` at one hop, nested under the match.
     *
     * `includeMemories` is passed explicitly because it defaults FALSE: the expansion follows stored edges
     * always and link classes only when asked. That default is the reason a record being reachable here is
     * not the same as it being reachable by an ordinary call.
     */
    const res = await P('/api/brain/recall', {
      space: SPACE, query: `Telemetry Service ${RUN}`, topK: 5,
      traverse: { depth: 1, includeMemories: true },
    });
    assert.equal(res.status, 200, `recall+traverse: ${JSON.stringify(res.body)}`);

    const nested = [];
    for (const m of res.body?.results ?? []) {
      for (const g of m._graph ?? []) nested.push(g.node?._id ?? g.node?.record?._id);
    }
    assert.ok(nested.includes(ids.quiet),
      `the expansion walks links and never consults a vector, so a suppressed record must arrive nested `
      + `under the match that reached it — nested ${JSON.stringify(nested)}`);
  });
});
