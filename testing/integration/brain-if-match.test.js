/**
 * Integration: `If-Match` on brain-record PATCH — the 412 path, against a running instance.
 *
 * The standalone suite pins the decision functions and asserts, on the source, that the precondition is
 * enforced inside the update's own `findOneAndUpdate` filter. Neither of those can tell you that a stale
 * `If-Match` actually refuses a write, or that the refused write left the record alone. That is what this
 * file is for, and it is the half that matters: the whole feature is a promise about what did NOT happen.
 *
 * ## Why it is table-driven
 *
 * All four record types or none — the asymmetry this codebase keeps finding is one rule shipped on two
 * surfaces with the newer one weaker. A per-type copy of these tests is how the fourth quietly ends up
 * missing an assertion, so the types are a table and every case runs over all of it.
 *
 * Run: node --test testing/integration/brain-if-match.test.js
 * (requires the docker test stack — see testing/docker-compose.test.yml)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, patch } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now().toString(36);

let tok;
const A = () => INSTANCES.a;

/** Each type: how to make one, where it lives, and a field a PATCH can move. */
const TYPES = [
  {
    name: 'fact',
    collection: 'facts',
    create: () => ({ fact: `if-match memory ${RUN}`, tags: ['if-match'] }),
    edit: (n) => ({ fact: `if-match memory ${RUN} v${n}` }),
    read: (body) => body.fact,
  },
  {
    name: 'entity',
    collection: 'entities',
    create: () => ({ name: `IfMatchEnt-${RUN}`, type: 'concept' }),
    edit: (n) => ({ description: `v${n}` }),
    read: (body) => body.description,
  },
  {
    name: 'chrono',
    collection: 'chrono',
    create: () => ({ title: `IfMatchChrono-${RUN}`, type: 'event', startsAt: new Date().toISOString() }),
    edit: (n) => ({ description: `v${n}` }),
    read: (body) => body.description,
  },
];

const url = (t, id) => `/api/brain/spaces/general/${t.collection}/${id}`;
const ifMatch = (v) => ({ 'If-Match': String(v) });

/** Create one record of the given type and return `{ id, seq }`. */
async function make(t) {
  const r = await post(A(), tok, `/api/brain/spaces/general/${t.collection}`, t.create());
  assert.equal(r.status, 201, `${t.name} create failed: ${JSON.stringify(r.body)}`);
  assert.equal(typeof r.body.seq, 'number', `${t.name} has no seq to condition a write on`);
  return { id: r.body._id, seq: r.body.seq };
}

/** Edges need two entities, so they are built separately rather than from the table's `create`. */
async function makeEdge() {
  const a = await post(A(), tok, '/api/brain/spaces/general/entities', { name: `IfMatchEdgeFrom-${RUN}`, type: 'concept' });
  const b = await post(A(), tok, '/api/brain/spaces/general/entities', { name: `IfMatchEdgeTo-${RUN}`, type: 'concept' });
  const e = await post(A(), tok, '/api/brain/spaces/general/edges', {
    from: a.body._id, to: b.body._id, label: `if-match-${RUN}`,
  });
  assert.equal(e.status, 201, `edge create failed: ${JSON.stringify(e.body)}`);
  return { id: e.body._id, seq: e.body.seq };
}

before(() => {
  tok = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  // Edges join the table here so every case below runs over all four types without a fourth copy of the
  // assertions. Its create needs two entities, which is the only reason it is not a plain table row.
  TYPES.push({
    name: 'edge',
    collection: 'edges',
    create: null,
    make: makeEdge,
    edit: (n) => ({ description: `v${n}` }),
    read: (body) => body.description,
  });
});

const create = (t) => (t.make ? t.make() : make(t));

describe('If-Match on brain records — the write is conditional', () => {
  it('a matching seq lets the write through, and the seq moves', async () => {
    for (const t of TYPES) {
      const rec = await create(t);
      const r = await patch(A(), tok, url(t, rec.id), t.edit(1), ifMatch(rec.seq));
      assert.equal(r.status, 200, `${t.name}: a matching If-Match was refused: ${JSON.stringify(r.body)}`);
      assert.equal(t.read(r.body), t.read(t.edit(1)), `${t.name}: the write did not take effect`);
      assert.notEqual(r.body.seq, rec.seq, `${t.name}: seq did not advance, so the next If-Match would be wrong`);
    }
  });

  it('a stale seq is refused with 412 and the record is left alone', async () => {
    for (const t of TYPES) {
      const rec = await create(t);
      const first = await patch(A(), tok, url(t, rec.id), t.edit(1), ifMatch(rec.seq));
      assert.equal(first.status, 200, `${t.name}: setup write failed: ${JSON.stringify(first.body)}`);

      // The second writer still holds the seq they read before the first write landed.
      const stale = await patch(A(), tok, url(t, rec.id), t.edit(2), ifMatch(rec.seq));
      assert.equal(stale.status, 412, `${t.name}: a stale If-Match was ACCEPTED: ${JSON.stringify(stale.body)}`);
      assert.equal(stale.body.currentSeq, first.body.seq,
        `${t.name}: the 412 did not hand back a usable seq to retry with`);

      // The promise is about what did not happen, so read it back rather than trusting the status.
      const after = await get(A(), tok, url(t, rec.id));
      assert.equal(t.read(after.body), t.read(first.body),
        `${t.name}: the refused write changed the record anyway`);
    }
  });

  it('retrying with the seq from the 412 succeeds', async () => {
    // The 412 is only useful if it tells you how to make progress. This is the whole read-modify-write loop.
    for (const t of TYPES) {
      const rec = await create(t);
      await patch(A(), tok, url(t, rec.id), t.edit(1), ifMatch(rec.seq));
      const refused = await patch(A(), tok, url(t, rec.id), t.edit(2), ifMatch(rec.seq));
      assert.equal(refused.status, 412, `${t.name}: expected a refusal to retry from`);
      const retry = await patch(A(), tok, url(t, rec.id), t.edit(2), ifMatch(refused.body.currentSeq));
      assert.equal(retry.status, 200,
        `${t.name}: the seq handed back by the 412 was itself stale: ${JSON.stringify(retry.body)}`);
    }
  });
});

describe('If-Match on brain records — the forms of the header', () => {
  it('no header writes unconditionally, exactly as before', async () => {
    // The compatibility promise. Every existing client sends no header and must be unaffected.
    for (const t of TYPES) {
      const rec = await create(t);
      await patch(A(), tok, url(t, rec.id), t.edit(1), ifMatch(rec.seq));   // move it out from under
      const r = await patch(A(), tok, url(t, rec.id), t.edit(2));            // no header
      assert.equal(r.status, 200, `${t.name}: a write with no precondition was refused: ${JSON.stringify(r.body)}`);
    }
  });

  it('`*` asks only that the record exist', async () => {
    for (const t of TYPES) {
      const rec = await create(t);
      await patch(A(), tok, url(t, rec.id), t.edit(1), ifMatch(rec.seq));
      const r = await patch(A(), tok, url(t, rec.id), t.edit(2), ifMatch('*'));
      assert.equal(r.status, 200, `${t.name}: '*' was refused on an existing record: ${JSON.stringify(r.body)}`);
    }
  });

  it('quoted and weak spellings behave identically to the bare form', async () => {
    // One rule, one parse. A surface honouring only the bare form would be silently weaker.
    for (const t of TYPES) {
      for (const spell of [(s) => `"${s}"`, (s) => `W/"${s}"`]) {
        const rec = await create(t);
        const r = await patch(A(), tok, url(t, rec.id), t.edit(1), ifMatch(spell(rec.seq)));
        assert.equal(r.status, 200,
          `${t.name}: the ${spell('N')} spelling was refused: ${JSON.stringify(r.body)}`);
      }
    }
  });

  it('an unparseable value is a 400, never ignored', async () => {
    // The dangerous alternative is a 200: the client would come away believing its write was protected.
    for (const t of TYPES) {
      const rec = await create(t);
      const r = await patch(A(), tok, url(t, rec.id), t.edit(1), ifMatch('not-a-seq'));
      assert.equal(r.status, 400, `${t.name}: a malformed If-Match was not refused: ${JSON.stringify(r.body)}`);

      const after = await get(A(), tok, url(t, rec.id));
      assert.equal(after.body.seq, rec.seq, `${t.name}: the rejected request wrote anyway`);
    }
  });
});

describe('the surfaces that decline the header say so', () => {
  it('the removed POST-as-update on chrono is a 404, with or without the header', async () => {
    // This case used to assert the legacy form worked and REFUSED `If-Match` with a 400. 3.0 removed the
    // route, so the interesting answer is now 404 — and it must be 404 with the header too. A route that
    // 404s bare but 400s with a header would mean something still matches the path.
    const rec = await make(TYPES.find(t => t.name === 'chrono'));
    const r = await post(A(), tok, `/api/brain/spaces/general/chrono/${rec.id}`,
      { title: `IfMatchChrono-${RUN}-legacy` });
    assert.equal(r.status, 404, `POST-as-update was removed in 3.0: ${JSON.stringify(r.body)}`);

    const withHeader = await fetch(`${A()}/api/brain/spaces/general/chrono/${rec.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok}`, 'If-Match': String(rec.seq) },
      body: JSON.stringify({ title: `IfMatchChrono-${RUN}-legacy2` }),
    });
    assert.equal(withHeader.status, 404, 'the header must not resurrect a route that is gone');

    // And PATCH — the verb that carries the capability — still honours it, so this is not passing because
    // the whole router stopped responding.
    const patched = await fetch(`${A()}/api/brain/spaces/general/chrono/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok}`, 'If-Match': String(rec.seq) },
      body: JSON.stringify({ title: `IfMatchChrono-${RUN}-patch` }),
    });
    assert.equal(patched.status, 200, 'PATCH with a matching If-Match must still succeed');
  });

  it('file metadata refuses it, because those records carry no seq', async () => {
    const r = await patch(A(), tok, '/api/brain/spaces/general/files?path=/whatever.txt',
      { description: 'x' }, ifMatch(1));
    assert.equal(r.status, 400,
      'file metadata accepted an If-Match it cannot evaluate');
    assert.match(r.body.error ?? '', /If-Match/, 'the 400 does not say which header was the problem');
  });
});
