/**
 * Integration: a record's relationships can be changed after it is written — on both doors.
 *
 * ## The gap
 *
 * `applyConnections` turns a body's `link*` and `edges` into storage, and every CREATE path called it.
 * No update path did, and no update allowlist named a connection field — so
 * `PATCH /api/brain/spaces/<s>/facts/<id>` with `linkEntities` answered
 * `400 "At least one field must be provided"`. The field was not rejected; it was not seen.
 *
 * **On a converted space that left no way at all.** `entityIds` was the way round, and
 * `array-write-refusal` refuses it outright once a space is `completeLinkage` — so a record's links
 * were settled the moment it was created, by either door, and the gap grew as spaces converted.
 *
 * ## What is asserted, and why each half matters
 *
 * Adding is the obvious half. **Removing is the one that would be easy to half-ship**: links REPLACE per
 * class, so `linkEntities: []` has to detach rather than mean "no change". A writer that honoured the
 * field only when it was non-empty would leave a link nobody could remove.
 *
 * And `edges` rides in the same body, so it is exercised too — a create that can draw a labelled edge and
 * an update that cannot is the same gap one field over.
 *
 * Run: node --test testing/integration/an-update-can-change-a-records-links.test.js
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
const SPACE = `update-links-${RUN}`;

let tokenA;
let personId;
const P = (p, body) => post(INSTANCES.a, tokenA, p, body);

const patch = async (coll, id, body) => {
  const res = await fetch(`${INSTANCES.a}/api/brain/spaces/${SPACE}/${coll}/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

function must(label, res, pick = (b) => b?._id) {
  const id = pick(res.body);
  assert.ok(res.status < 400 && id, `fixture '${label}' failed: ${res.status} ${JSON.stringify(res.body)}`);
  return id;
}

/** What a READER sees — the walk that follows links, whichever shape the space stores them in. */
async function reachableFromPerson() {
  const res = await P(`/api/brain/spaces/${SPACE}/traverse`,
    { startId: personId, maxDepth: 1, includeMemories: true, includeChrono: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body?.nodes ?? []).map(n => n._id);
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const sp = await P('/api/spaces', { id: SPACE, label: `Update links ${RUN}` });
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

describe('an update can change a record\'s links', () => {
  it('HTTP: a fact created with none gains one, and the reader sees it', async () => {
    const id = must('bare fact', await P(`/api/brain/spaces/${SPACE}/facts`, { fact: `rest add ${RUN}` }));
    assert.ok(!(await reachableFromPerson()).includes(id), 'precondition: it must start unlinked');

    const res = await patch('facts', id, { linkEntities: [personId] });
    assert.ok(res.status < 400, `PATCH refused: ${res.status} ${JSON.stringify(res.body)}`);
    assert.ok((await reachableFromPerson()).includes(id),
      'the update was accepted and the link is reached by nothing — a 200 with no link written is worse '
      + 'than the 400 it replaced');
  });

  it('HTTP: an empty class DETACHES, because links replace per class', async () => {
    // The half that would be easy to half-ship. Without it there is no way to remove a link added above.
    const id = must('linked fact', await P(`/api/brain/spaces/${SPACE}/facts`,
      { fact: `rest detach ${RUN}`, linkEntities: [personId] }));
    assert.ok((await reachableFromPerson()).includes(id), 'precondition: it must start linked');

    const res = await patch('facts', id, { linkEntities: [] });
    assert.ok(res.status < 400, `detach refused: ${res.status} ${JSON.stringify(res.body)}`);
    assert.ok(!(await reachableFromPerson()).includes(id), 'an empty class must detach');
  });

  it('HTTP: a connection field ALONE is a field, not "nothing provided"', async () => {
    // The refusal that started this row. `linkEntities` was not in the allowlist, so a body plainly
    // carrying one field was reported as carrying none.
    const id = must('bare fact', await P(`/api/brain/spaces/${SPACE}/facts`, { fact: `rest only ${RUN}` }));
    const res = await patch('facts', id, { linkEntities: [personId] });
    assert.notEqual(res.status, 400,
      `a body with one connection field was refused as empty: ${JSON.stringify(res.body)}`);
  });

  it('HTTP: chrono takes them on update as well, so the rule is the DOOR SET and not facts', async () => {
    // Asserting the rule rather than one site: a case naming facts survives nobody covering chrono.
    const id = must('chrono', await P(`/api/brain/spaces/${SPACE}/chrono`,
      { title: `rest chrono ${RUN}`, type: 'event', startsAt: '2026-08-01T09:00:00.000Z' }));
    const res = await patch('chrono', id, { linkEntities: [personId] });
    assert.ok(res.status < 400, `chrono PATCH refused: ${res.status} ${JSON.stringify(res.body)}`);
    assert.ok((await reachableFromPerson()).includes(id), 'the chrono entry must now be reachable');
  });

  it('MCP: the same call through the tool door does the same thing', async () => {
    // One capability, two doors, same commit — `CLAUDE.md`'s first rule. A tool that declares the field
    // and does not apply it is the REST defect wearing a different door.
    const id = must('tool fact', await P('/api/save_fact',
      { space: SPACE, fact: `tool add ${RUN}` }, ), b => b?.data?._id);
    assert.ok(!(await reachableFromPerson()).includes(id), 'precondition: it must start unlinked');

    const res = await P('/api/update_fact', { space: SPACE, id, linkEntities: [personId] });
    assert.ok(res.status < 400 && res.body?.ok !== false,
      `update_fact refused: ${res.status} ${JSON.stringify(res.body)}`);
    assert.ok((await reachableFromPerson()).includes(id),
      'the tool accepted the field and wrote no link');
  });

  it('MCP: an edge can be drawn by an update too, since it rides in the same body', async () => {
    const other = must('company', await P(`/api/brain/spaces/${SPACE}/entities`,
      { name: `Beta ${RUN}`, type: 'company' }));
    const res = await P('/api/update_entity',
      { space: SPACE, id: personId, edges: [{ to: other, label: 'works_at' }] });
    assert.ok(res.status < 400 && res.body?.ok !== false,
      `update_entity refused an edge: ${res.status} ${JSON.stringify(res.body)}`);

    const edges = await P('/api/filter', { space: SPACE, collection: 'edges', filter: { label: 'works_at' } });
    const rows = edges.body?.data?.results ?? [];
    assert.equal(rows.length, 1, `exactly one edge should exist: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].to, other, 'and it must point where the update said');
  });
});
