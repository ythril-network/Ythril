/**
 * Integration: a link written through `linkEntities` is one a reader can see — on ANY space.
 *
 * ## The defect, and why it depends on when the instance last rebooted
 *
 * A link lives in two shapes during the 4.x→5.0 transition: the ARRAY on the record (`fact.entityIds` and
 * its five siblings) and a LINK RECORD in the space's `links` collection. `usesLinkRecords` picks which a
 * space is read through, and `link-adjacency.ts` says of it: *"the ONLY place that decides."*
 *
 * **That is true of readers. Nothing held the WRITER to it.** `reconcileLinks` writes a link record and
 * nothing else, so on a space whose readers are still on the array path the row it writes is one every
 * reader looks away from. Measured 2026-09-18 against a live instance, with a control:
 *
 * | a fact created with | its `entityIds` | link record written | reached by a reader |
 * |---|---|---|---|
 * | `entityIds: [pid]`   | `[pid]` | yes | YES |
 * | `linkEntities: [pid]`| `[]`    | yes | no  |
 *
 * Both link records exist. It is not a failed write; it is a write nobody reads.
 *
 * **`completeLinkage` is set by the BOOT conversion**, which walks every space that does not have it. A
 * space created after that boot keeps the array path until the next restart. So the same call succeeds or
 * silently loses the link depending on whether the instance has rebooted since the space was made — the
 * shape of bug a reporter cannot reproduce and a responder can.
 *
 * ## Why the fix is not "make new spaces converted"
 *
 * `link-adjacency.ts` records the intent: *"Both shapes answer all six classes… running the conversion is
 * a performance and consistency upgrade rather than a **correctness prerequisite**. An operator who
 * upgrades and runs nothing gets the fix."* An unconverted space is a SUPPORTED state, so the writer has
 * to work on one.
 *
 * ## Seen red
 *
 * Every case below except its controls, against a freshly created space.
 *
 * Run: node --test testing/integration/a-link-reaches-a-reader-on-any-space.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
/**
 * A space created HERE, in this test, and therefore unconverted — which is the whole point.
 *
 * A suite that reused a space seeded before a boot would exercise the converted path and pass throughout.
 */
const SPACE = `link-writer-${RUN}`;

let tokenA;
let personId;
const P = (p, body) => post(INSTANCES.a, tokenA, p, body);

function must(label, res, pick = (b) => b?._id) {
  const id = pick(res.body);
  assert.ok(res.status < 400 && id, `fixture '${label}' failed: ${res.status} ${JSON.stringify(res.body)}`);
  return id;
}

/** What a READER sees: the walk that follows links, whichever shape the space stores them in. */
async function reachableFromPerson() {
  const res = await P(`/api/brain/spaces/${SPACE}/traverse`,
    { startId: personId, maxDepth: 1, includeMemories: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body?.nodes ?? []).map(n => n._id);
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const sp = await P('/api/spaces', { id: SPACE, label: `Link writer ${RUN}` });
  assert.equal(sp.status, 201, `create space: ${JSON.stringify(sp.body)}`);
  personId = must('person', await P(`/api/brain/spaces/${SPACE}/entities`,
    { name: `Ada ${RUN}`, type: 'person' }));
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

describe('a link written on an unconverted space is a link a reader can see', () => {
  it('the control: `entityIds` lands and is reachable', async () => {
    // First, so a failure below cannot be read as "the walk is broken" or "the space is empty".
    const id = must('fact via entityIds', await P(`/api/brain/spaces/${SPACE}/facts`,
      { fact: `via entityIds ${RUN}`, entityIds: [personId] }));
    assert.ok((await reachableFromPerson()).includes(id),
      'the control link is unreachable — the reader or the fixture is broken, not the writer');
  });

  it('`linkEntities` lands too, and that is the same question asked the other way', async () => {
    const id = must('fact via linkEntities', await P(`/api/brain/spaces/${SPACE}/facts`,
      { fact: `via linkEntities ${RUN}`, linkEntities: [personId] }));
    const reached = await reachableFromPerson();
    assert.ok(reached.includes(id),
      `a 201 was answered and the link is reached by nothing. \`linkEntities\` is the shape that survives `
      + `the conversion and the one the MCP schema publishes, so this is the spelling an agent is told to `
      + `use. reached: ${JSON.stringify(reached)}`);
  });

  it('detaching keeps the two shapes in step, so a link can be removed as well as added', async () => {
    // A writer that honoured the selector for ADDS and not for removals would be the same defect with a
    // smaller blast radius: the link would come back on the next reader that looked.
    const id = must('fact to detach', await P(`/api/brain/spaces/${SPACE}/facts`,
      { fact: `detach me ${RUN}`, linkEntities: [personId] }));
    assert.ok((await reachableFromPerson()).includes(id), 'precondition: it must be linked before detaching');

    const res = await fetch(`${INSTANCES.a}/api/brain/spaces/${SPACE}/facts/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityIds: [] }),
    });
    assert.ok(res.status < 400, `detach refused: ${res.status} ${await res.text()}`);
    assert.ok(!(await reachableFromPerson()).includes(id),
      'a link written through `linkEntities` must be removable — otherwise the two spellings disagree '
      + 'about how to undo one another');
  });

  it('the UPDATE verb honours it too, and the selector has to hold there as well', async () => {
    /*
     * This case was written the other way round, asserting the `400` — no update route called
     * `applyConnections`, so the refusal was honest and was filed as `Q-30` rather than fixed here. Its
     * own note said what to do when that landed: *"the capability landed and this assertion should
     * become the positive one."* `Q-30` landed, this went red, and here is the positive one.
     *
     * It belongs in THIS file and not only in `Q-30`'s, because the update path reaches the same writer:
     * a new caller of `reconcileLinks` on an unconverted space is exactly how the defect this file
     * guards would come back.
     */
    const id = must('bare fact', await P(`/api/brain/spaces/${SPACE}/facts`, { fact: `bare ${RUN}` }));
    const res = await fetch(`${INSTANCES.a}/api/brain/spaces/${SPACE}/facts/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ linkEntities: [personId] }),
    });
    assert.ok(res.status < 400, `PATCH refused \`linkEntities\`: ${res.status} ${await res.text()}`);
    assert.ok((await reachableFromPerson()).includes(id),
      'the update was accepted and the link is reached by nothing — the writer took the array path on '
      + 'the create and not on the update, which is this file\'s defect with a smaller blast radius');
  });
});
