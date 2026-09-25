/**
 * Integration tests: Gossip / notify channel
 *
 * Covers:
 *  - POST /api/notify: all supported event types, error paths, unauthenticated
 *  - GET  /api/notify: event log, networkId filter, limit parameter
 *  - POST /api/networks/:id/sync: the trigger that replaced POST /api/notify/trigger
 *
 * All tests run against instance A (port 3200) only. No multi-instance setup required.
 *
 * Run: node --test testing/integration/notify.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, waitFor } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let token;
let networkId;
// instanceId of the member we register so we can send valid notify events.
// Must be a string of at least 1 character (Zod min(1)); does not need to be UUID.
const MEMBER_ID = 'notify-test-member-peer';

describe('Notify channel', () => {
  before(async () => {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

    // Create a braintree network — braintree uses direct member add (no vote round)
    // so the member is immediately queryable.
    const netR = await post(INSTANCES.a, token, '/api/networks', {
      label: `Notify Test Network ${Date.now()}`,
      type: 'braintree',
      spaces: ['general'],
      votingDeadlineHours: 1,
    });
    assert.equal(netR.status, 201, `Create test network failed: ${JSON.stringify(netR.body)}`);
    networkId = netR.body.id;

    // Add a fake peer member so we have a valid instanceId to notify from
    const addR = await post(INSTANCES.a, token, `/api/networks/${networkId}/members`, {
      instanceId: MEMBER_ID,
      label: 'Notify Test Peer',
      url: 'http://notify-test-peer.internal:3200',
      token: 'ythril_notify_test_peer_token',
      direction: 'push',
    });
    assert.equal(addR.status, 201, `Add peer member failed: ${JSON.stringify(addR.body)}`);
  });

  after(async () => {
    if (networkId) {
      await del(INSTANCES.a, token, `/api/networks/${networkId}`).catch(() => {});
    }
  });

  // ── POST /api/notify — event ingestion ─────────────────────────────────────

  it('ping event returns 204', async () => {
    const r = await post(INSTANCES.a, token, '/api/notify', {
      networkId,
      instanceId: MEMBER_ID,
      event: 'ping',
    });
    assert.equal(r.status, 204, JSON.stringify(r.body));
  });

  it('sync_available event returns 204 AND actually starts a sync cycle', async () => {
    // Baseline: how many sync-history records exist before the event.
    const before = await get(INSTANCES.a, token, `/api/networks/${networkId}/sync-history?limit=100`);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    const baseline = before.body.history?.length ?? 0;

    const r = await post(INSTANCES.a, token, '/api/notify', {
      networkId,
      instanceId: MEMBER_ID,
      event: 'sync_available',
    });
    assert.equal(r.status, 204, JSON.stringify(r.body));

    // A 204 from a handler that does nothing would pass the assertion above —
    // the real effect is a sync cycle, which unconditionally appends a
    // sync-history record when it completes (even when the peer is
    // unreachable, as here — the record then has status failed/partial).
    await waitFor(async () => {
      const after = await get(INSTANCES.a, token, `/api/networks/${networkId}/sync-history?limit=100`);
      return (after.body.history?.length ?? 0) > baseline;
    }, 30_000, 500, 'sync_available never produced a sync-history record — the event did not start a sync cycle');
  });

  it('vote_pending event returns 204', async () => {
    const r = await post(INSTANCES.a, token, '/api/notify', {
      networkId,
      instanceId: MEMBER_ID,
      event: 'vote_pending',
      data: { roundId: 'fake-round-001' },
    });
    assert.equal(r.status, 204, JSON.stringify(r.body));
  });

  it('space_deletion_pending event returns 204', async () => {
    const r = await post(INSTANCES.a, token, '/api/notify', {
      networkId,
      instanceId: MEMBER_ID,
      event: 'space_deletion_pending',
    });
    assert.equal(r.status, 204, JSON.stringify(r.body));
  });

  it('Event data payload is stored and returned in event log', async () => {
    const roundId = `test-round-${Date.now()}`;
    await post(INSTANCES.a, token, '/api/notify', {
      networkId,
      instanceId: MEMBER_ID,
      event: 'vote_pending',
      data: { roundId },
    });
    const r = await get(INSTANCES.a, token, `/api/notify?networkId=${networkId}&limit=200`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const match = r.body.events.find(e => e.event === 'vote_pending' && e.data?.roundId === roundId);
    assert.ok(match, 'vote_pending event with matching data.roundId must be in the log');
    assert.ok(match.receivedAt, 'Event must have a receivedAt timestamp');
    assert.ok(match.id, 'Event must have an id');
    assert.equal(match.instanceId, MEMBER_ID, 'Event must record the sending instanceId');
  });

  it('member_departed event returns 204', async () => {
    const r = await post(INSTANCES.a, token, '/api/notify', {
      networkId,
      instanceId: MEMBER_ID,
      event: 'member_departed',
    });
    assert.equal(r.status, 204, JSON.stringify(r.body));
  });

  it('unknown event type returns 400', async () => {
    const r = await post(INSTANCES.a, token, '/api/notify', {
      networkId,
      instanceId: MEMBER_ID,
      event: 'not_a_real_event',
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('missing event field returns 400', async () => {
    const r = await post(INSTANCES.a, token, '/api/notify', {
      networkId,
      instanceId: MEMBER_ID,
      // event omitted intentionally
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('missing networkId returns 400', async () => {
    const r = await post(INSTANCES.a, token, '/api/notify', {
      instanceId: MEMBER_ID,
      event: 'ping',
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('non-existent network returns 404', async () => {
    const r = await post(INSTANCES.a, token, '/api/notify', {
      networkId: '00000000-0000-0000-0000-nonexistent01',
      instanceId: MEMBER_ID,
      event: 'ping',
    });
    assert.equal(r.status, 404, `Expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('non-member instanceId returns 403', async () => {
    const r = await post(INSTANCES.a, token, '/api/notify', {
      networkId,
      instanceId: 'completely-unknown-member',
      event: 'ping',
    });
    assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('unauthenticated request returns 401', async () => {
    const r = await post(INSTANCES.a, '', '/api/notify', {
      networkId,
      instanceId: MEMBER_ID,
      event: 'ping',
    });
    assert.equal(r.status, 401, `Expected 401, got ${r.status}`);
  });
  it('non-admin token without peerInstanceId is rejected for remote instanceId (403)', async () => {
    // Ensure a member exists for the claimed instanceId (earlier tests may have
    // removed MEMBER_ID via member_departed). Use a unique instanceId.
    const peerId = `non-admin-peer-${Date.now()}`;
    const addR = await post(INSTANCES.a, token, `/api/networks/${networkId}/members`, {
      instanceId: peerId,
      label: 'Non-Admin Test Peer',
      url: 'http://non-admin-test-peer.internal:3200',
      token: 'ythril_non_admin_test_peer_token',
      direction: 'push',
    });
    assert.equal(addR.status, 201, `Add peer failed: ${JSON.stringify(addR.body)}`);

    // Create a non-admin, space-scoped token — it has no peerInstanceId,
    // so it must not be able to impersonate a remote peer.
    const createR = await post(INSTANCES.a, token, '/api/tokens', {
      name: `notify-non-admin-${Date.now()}`,
      rights: legacyRights({ spaces: ['general'] })
    });
    assert.equal(createR.status, 201, `Create token failed: ${JSON.stringify(createR.body)}`);
    const nonAdminToken = createR.body.plaintext;

    const r = await post(INSTANCES.a, nonAdminToken, '/api/notify', {
      networkId,
      instanceId: peerId,
      event: 'ping',
    });
    assert.equal(r.status, 403, `Expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(
      r.body.error?.includes('not authorised'),
      `Error must mention authorisation: ${JSON.stringify(r.body)}`,
    );
  });
  // ── GET /api/notify — event log ─────────────────────────────────────────────

  it('GET /api/notify returns event log with events array', async () => {
    // Submit a ping first so there is at least one event to find
    await post(INSTANCES.a, token, '/api/notify', {
      networkId,
      instanceId: MEMBER_ID,
      event: 'ping',
    });
    const r = await get(INSTANCES.a, token, '/api/notify');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.events), 'events must be an array');
    assert.ok(r.body.events.length >= 1, 'At least one event should be present');
  });

  it('GET /api/notify filtered by networkId contains only matching events', async () => {
    await post(INSTANCES.a, token, '/api/notify', {
      networkId,
      instanceId: MEMBER_ID,
      event: 'ping',
    });
    const r = await get(INSTANCES.a, token, `/api/notify?networkId=${networkId}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.events), 'events must be an array');
    assert.ok(r.body.events.every(e => e.networkId === networkId), 'All events must match the requested networkId');
    assert.ok(r.body.events.length >= 1, 'At least one event for this network expected');
  });

  it('GET /api/notify with limit=1 returns at most one event', async () => {
    // Ensure there is more than one event total before testing the limit
    await post(INSTANCES.a, token, '/api/notify', { networkId, instanceId: MEMBER_ID, event: 'ping' });
    await post(INSTANCES.a, token, '/api/notify', { networkId, instanceId: MEMBER_ID, event: 'ping' });
    const r = await get(INSTANCES.a, token, '/api/notify?limit=1');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.events), 'events must be an array');
    assert.ok(r.body.events.length <= 1, `limit=1 must return at most 1 event, got ${r.body.events.length}`);
  });

  it('GET /api/notify unauthenticated returns 401', async () => {
    const r = await get(INSTANCES.a, '', '/api/notify');
    assert.equal(r.status, 401, `Expected 401, got ${r.status}`);
  });

  // ── the sync trigger, on the door that names its subject ────────────────────

  it('POST /api/networks/:id/sync returns 200 AND a sync cycle actually runs', async () => {
    // Baseline sync-history count — the echoed {status:'triggered'} alone is
    // satisfied by a handler that does nothing (exactly how the notify
    // rate-limit bug hid); the observable effect is a new history record.
    const before = await get(INSTANCES.a, token, `/api/networks/${networkId}/sync-history?limit=100`);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    const baseline = before.body.history?.length ?? 0;

    const r = await post(INSTANCES.a, token, `/api/networks/${networkId}/sync`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'triggered', JSON.stringify(r.body));
    assert.equal(r.body.networkId, networkId, 'Response must echo the networkId');

    await waitFor(async () => {
      const after = await get(INSTANCES.a, token, `/api/networks/${networkId}/sync-history?limit=100`);
      return (after.body.history?.length ?? 0) > baseline;
    }, 30_000, 500, 'trigger never produced a sync-history record — no sync cycle ran');

    // The completed record must be a real cycle result, not a placeholder.
    const after = await get(INSTANCES.a, token, `/api/networks/${networkId}/sync-history?limit=100`);
    const rec = after.body.history[0];
    assert.ok(rec.completedAt, 'history record must carry completedAt');
    assert.ok(['success', 'partial', 'failed'].includes(rec.status), `unexpected history status: ${rec.status}`);
  });

  it('POST /api/networks/:id/sync unauthenticated returns 401', async () => {
    const r = await post(INSTANCES.a, '', `/api/networks/${networkId}/sync`, {});
    assert.equal(r.status, 401, `Expected 401, got ${r.status}`);
  });
});
