/**
 * A meta change that the proposer's own vote already passes is applied at once, not left waiting (`Q-49`).
 *
 * On club and pub/sub one yes passes a round, and the proposer's yes is recorded when the round opens — but nothing
 * evaluated the round then, so the change sat `vote_pending` until somebody cast the same yes again by hand or the
 * deadline expired it. Found moving the `flows` space: a publisher's usage-notes edit answered 202 and changed
 * nothing until a second, identical vote was cast.
 *
 * Run: node --test testing/integration/a-meta-change-its-own-vote-passes-is-applied.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, patch, del } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

const SPACE = `q49-meta-${Date.now()}`;
let admin, networkId;

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const s = await post(INSTANCES.a, admin, '/api/spaces', { id: SPACE, label: 'Q-49 meta' });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const n = await post(INSTANCES.a, admin, '/api/networks', { label: 'q49', type: 'club', spaces: [SPACE] });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  networkId = n.body.id;
});
after(async () => {
  if (networkId) await del(INSTANCES.a, admin, `/api/networks/${networkId}`).catch(() => {});
  await del(INSTANCES.a, admin, `/api/spaces/${SPACE}`).catch(() => {});
});

describe('a meta change on a club space proposed by the organiser', () => {
  it('is applied immediately, because the proposer\'s own yes passes it', async () => {
    const notes = `q49 notes ${Date.now()}`;
    const r = await patch(INSTANCES.a, admin, `/api/spaces/${SPACE}`, { meta: { usageNotes: notes } });
    assert.equal(r.status, 200, `a change the rules already passed must not answer vote_pending: ${r.status} ${JSON.stringify(r.body)}`);
    const m = await get(INSTANCES.a, admin, `/api/spaces/${SPACE}/meta`);
    assert.equal(m.body.usageNotes, notes, 'and the change is in the meta');
    const v = await get(INSTANCES.a, admin, `/api/networks/${networkId}/votes`);
    assert.deepEqual((v.body.rounds ?? []).filter(x => x.type === 'meta_change'), [], 'no round is left open for it');
  });
});
