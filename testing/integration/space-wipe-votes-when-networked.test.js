/**
 * Integration test: wiping a NETWORKED space opens a vote instead of emptying it (X-5).
 *
 * The standalone gate proves the wiring — one planner, both doors, three conclusion sites, the types riding
 * on the round. What it cannot prove is that a round actually opens against a real config, which is the
 * whole behaviour the owner ruled for: *"thats a voting thing."*
 *
 * Modelled on `space-deletion.test.js`'s networked case, because a wipe is now governed the same way a
 * deletion is, and the two should stay recognisably one pattern.
 *
 * The negative case matters as much as the positive: an UNNETWORKED wipe must still be immediate. That half
 * is the promise made to every existing operator, and a change that broke it would look like this feature
 * working.
 *
 * Run: node --test testing/integration/space-wipe-votes-when-networked.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, del, delWithBody, filterRest } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let token;
const RUN_ID = Date.now();

describe('Space wipe — governed when the space is in a network', () => {
  before(() => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  });

  it('a space in NO network still wipes immediately, with counts', async () => {
    // The unchanged half, asserted first: every existing operator depends on it, and a regression here
    // would be invisible behind the new feature apparently working.
    const spaceId = `wipe-solo-${RUN_ID}`;
    const createR = await post(INSTANCES.a, token, '/api/spaces', { id: spaceId, label: 'Wipe Solo' });
    assert.equal(createR.status, 201, `create: ${JSON.stringify(createR.body)}`);

    await post(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/facts`, { fact: 'solo wipe subject' });

    const wipeR = await post(INSTANCES.a, token, `/api/admin/spaces/${spaceId}/wipe`, {});
    assert.equal(wipeR.status, 200, `Expected an immediate wipe, got ${wipeR.status}: ${JSON.stringify(wipeR.body)}`);
    assert.ok(wipeR.body?.deleted, 'an ungoverned wipe answers with counts');
    assert.equal(wipeR.body.status, undefined, 'and must NOT report a pending vote');

    await delWithBody(INSTANCES.a, token, `/api/spaces/${spaceId}`, { confirm: true }).catch(() => {});
  });

  it('a space in a network opens a vote round and wipes nothing yet', async () => {
    const spaceId = `wipe-networked-${RUN_ID}`;
    const createR = await post(INSTANCES.a, token, '/api/spaces', { id: spaceId, label: 'Wipe Networked' });
    assert.equal(createR.status, 201, `create: ${JSON.stringify(createR.body)}`);

    const factR = await post(INSTANCES.a, token, `/api/brain/spaces/${spaceId}/facts`,
      { fact: 'this must survive the vote being opened' });
    assert.equal(factR.status, 201, `seed fact: ${JSON.stringify(factR.body)}`);

    const netR = await post(INSTANCES.a, token, '/api/networks', {
      label: `Wipe-Net-${RUN_ID}`,
      type: 'closed',
      spaces: [spaceId],
    });
    assert.equal(netR.status, 201, `network create: ${JSON.stringify(netR.body)}`);
    const networkId = netR.body.id;

    const wipeR = await post(INSTANCES.a, token, `/api/admin/spaces/${spaceId}/wipe`, {});
    assert.equal(wipeR.status, 202, `Expected 202 (vote opened), got ${wipeR.status}: ${JSON.stringify(wipeR.body)}`);
    assert.equal(wipeR.body?.status, 'vote_pending', 'the status names what happened');
    assert.ok(wipeR.body?.rounds?.length > 0, 'at least one round must be open');
    assert.equal(wipeR.body.rounds[0].networkId, networkId, 'the round belongs to the network holding the space');

    // The point of the whole change: the data is still there. A vote that emptied the space anyway would
    // pass every assertion above and be the exact bug this replaces.
    const stillR = await filterRest(INSTANCES.a, token, { space: spaceId, ...({ collection: 'facts', filter: {} }) });
    assert.equal(stillR.status, 200, `query after vote opened: ${JSON.stringify(stillR.body)}`);
    assert.ok((stillR.body?.results?.length ?? 0) > 0,
      'the memory must survive: the wipe happens when the round PASSES, not when it opens');

    await del(INSTANCES.a, token, `/api/networks/${networkId}`).catch(() => {});
    await delWithBody(INSTANCES.a, token, `/api/spaces/${spaceId}`, { confirm: true }).catch(() => {});
  });
});
