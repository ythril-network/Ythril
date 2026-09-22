/**
 * Integration: a link written through `linkEntities` is one a reader can see — on a BRAND NEW space.
 *
 * ## The defect, and why it depended on when the instance last rebooted
 *
 * A link lived in two shapes through 4.x: the ARRAY on the record (`fact.entityIds` and its five
 * siblings) and a LINK RECORD in the space's `links` collection. Readers picked per space, by a marker
 * the BOOT conversion set — and nothing held the WRITER to the same choice. `reconcileLinks` writes a
 * link record and nothing else, so on a space whose readers were still on the array path the row it
 * wrote was one every reader looked away from. Measured 2026-09-18 against a live instance, with a
 * control:
 *
 * | a fact created with | its `entityIds` | link record written | reached by a reader |
 * |---|---|---|---|
 * | `entityIds: [pid]`   | `[pid]` | yes | YES |
 * | `linkEntities: [pid]`| `[]`    | yes | no  |
 *
 * Both link records existed. It was not a failed write; it was a write nobody read.
 *
 * **A space created between two boots was the case that hid it**, because it kept the array path until
 * the next restart — so the same call succeeded or silently lost the link depending on whether the
 * instance had rebooted since the space was made.
 *
 * ## What 5.0 changed, and why this suite is kept
 *
 * There is one shape. The arrays are gone, space creation marks a space converted, and a space whose
 * conversion FAILED is refused rather than read. So the two paths that could disagree no longer exist —
 * and what this suite asserts is the outcome that mattered: a link written on a space made moments ago
 * is reached by the walk. That claim outlives the mechanism it was written against.
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
 * A space created HERE, in this test, which is the whole point.
 *
 * It was the UNCONVERTED case when the two shapes coexisted; it is now the space that was created
 * between two boots, which is the one a reader would still expect to be special.
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
