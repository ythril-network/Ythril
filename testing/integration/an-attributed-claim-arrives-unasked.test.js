/**
 * Integration: a recall brings the ATTRIBUTED claims of its matches, and nothing else it was not asked for.
 *
 * ## The decision
 *
 * Owner, 2026-09-19. A claim an AI assistant originated must not compete for a ranked slot — *"(2) fills
 * context very often with stuff thats not interesting"* — and must not be hidden either. So: stored with no
 * vector, and reached as context.
 *
 * Reaching it means following `fact.entityIds`, and that link class is off by default for a reason written
 * into the schema: *"a match is counted with its whole `_graph` subtree, so every record admitted by default
 * is paid for in matches that no longer fit."* Admitting the class wholesale would drag every linked fact
 * into every answer, which is the cost the decision was about. So the default admits it NARROWED to
 * attributed records.
 *
 * ## What each case is really for
 *
 * The ten ordinary facts are the control, and they are the whole test. Without them *"the attributed claim
 * arrived"* is equally good evidence that the walk now returns every linked fact — which is the failure this
 * narrowing exists to prevent, and it would look identical from the outside.
 *
 * `includeMemories: false` still meaning false is the second half. A default that quietly overrode an
 * explicit refusal would make the flag stop meaning what its own description says, which is worse than the
 * gap it closes.
 *
 * ## Measured on a live instance before it was believed
 *
 * | call | bytes | graph nodes | attributed | ordinary |
 * |---|---|---|---|---|
 * | default | 2 894 | 1 | yes | 0 |
 * | `includeMemories: false` | 2 332 | 0 | no | 0 |
 * | `includeMemories: true` | 6 485 | 7 | yes | 6 |
 *
 * The default costs one record, not a flood.
 *
 * Run: node --test testing/integration/an-attributed-claim-arrives-unasked.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, waitForIndexed } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `attributed-context-${RUN}`;

/** How many ordinary linked facts stand as the control. Enough that admitting the class would be obvious. */
const ORDINARY = 10;

let tokenA;
let subject;
const P = (p, body) => post(INSTANCES.a, tokenA, p, body);
const ATTRIBUTED_TEXT = 'The assistant listed three providers that support instant settlement.';

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const sp = await P('/api/spaces', { id: SPACE, label: `Attributed context ${RUN}` });
  assert.equal(sp.status, 201, `create space: ${JSON.stringify(sp.body)}`);

  const e = await P(`/api/brain/spaces/${SPACE}/entities`, {
    name: `Payments Service ${RUN}`, type: 'concept',
    description: 'The subject every fact below names, and the seed a recall matches.',
  });
  subject = e.body?._id;
  assert.ok(subject, `entity: ${JSON.stringify(e.body)}`);

  for (let i = 0; i < ORDINARY; i++) {
    await P(`/api/brain/spaces/${SPACE}/facts`, {
      fact: `Ordinary note ${i} about the payments service, written by a person.`, linkEntities: [subject],
    });
  }
  const att = await P(`/api/brain/spaces/${SPACE}/facts`, {
    fact: ATTRIBUTED_TEXT, linkEntities: [subject],
    suppressEmbeddings: true, properties: { attributed: true, speaker: 'assistant' },
  });
  assert.ok(att.body?._id, `attributed fact: ${JSON.stringify(att.body)}`);

  /*
   * The SUBJECT has to be rankable before a query can reach it, and the attributed fact deliberately
   * must not be — it is written `suppressEmbeddings: true`, so it has no vector and the walk is the only
   * thing that can produce it. That is the case. Waiting on the subject alone is what makes a failure
   * here mean "the walk did not carry the claim" rather than "the seed had not been indexed yet".
   */
  await waitForIndexed(INSTANCES.a, tokenA, SPACE, [subject], ['entity']);
});

/** Every record the walk nested under a match, as its text or name. */
function nested(res) {
  const out = [];
  for (const m of res.body?.results ?? []) for (const g of m._graph ?? []) out.push(g.node?.fact ?? g.node?.name);
  return out.map(String);
}
const recall = (traverse) => P('/api/brain/recall', {
  space: SPACE, query: `Payments Service ${RUN}`, topK: 5, traverse,
});

describe('a recall that asks for nothing still gets the attributed claim', () => {
  it('brings it, and brings none of the ordinary facts', async () => {
    const res = await recall(1);
    assert.equal(res.status, 200, `recall: ${JSON.stringify(res.body)}`);
    const got = nested(res);
    assert.ok(got.some(t => t.includes('instant settlement')),
      `the attributed claim must arrive without being asked for — nested ${JSON.stringify(got)}`);

    // THE CONTROL. Ten ordinary facts hang off the same entity; if the narrowing were not applied, the
    // walk would return them too and the assertion above would pass for entirely the wrong reason.
    const ordinary = got.filter(t => t.includes('Ordinary note'));
    assert.deepEqual(ordinary, [],
      `only ATTRIBUTED claims are admitted by default, but ${ordinary.length} ordinary facts arrived. `
      + 'Admitting the whole class is the cost this narrowing exists to avoid.');
  });
});

describe('an explicit refusal is still a refusal', () => {
  it('includeMemories: false brings nothing, attributed included', async () => {
    const res = await recall({ depth: 1, includeMemories: false });
    assert.equal(res.status, 200, `recall: ${JSON.stringify(res.body)}`);
    const got = nested(res);
    assert.ok(!got.some(t => t.includes('instant settlement')),
      '`false` is "I said no", and a default that overrode it would make the flag stop meaning what its '
      + `own description says — nested ${JSON.stringify(got)}`);
  });
});

describe('asking for everything still gets everything', () => {
  it('includeMemories: true brings the ordinary facts as well', async () => {
    const res = await recall({ depth: 1, includeMemories: true });
    assert.equal(res.status, 200, `recall: ${JSON.stringify(res.body)}`);
    const got = nested(res);
    assert.ok(got.filter(t => t.includes('Ordinary note')).length > 0,
      `the flag must still admit the whole class — nested ${JSON.stringify(got)}`);
    assert.ok(got.some(t => t.includes('instant settlement')),
      'and the attributed claim is a fact like any other when the whole class is asked for');
  });
});
