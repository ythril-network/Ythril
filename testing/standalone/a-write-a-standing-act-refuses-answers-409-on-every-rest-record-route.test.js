/**
 * Every mounted REST record write route has a request, or a reason it is not a record write (bundle-157, Q-560 finding 1; split out by Q-969).
 *
 * The database half, `a-write-a-standing-act-refuses-answers-409-on-every-rest-record-route-db.test.js`, sends one request per route while a
 * `restore` act stands and holds that each answers `409` with the act's code. Which routes it must send to is the question asked here, and it needs
 * no database: the subjects are DERIVED, every mounted non-GET route under `/api/brain/spaces/:spaceId/` (`_routes.mjs`, the mount graph,
 * floored), and each is either a row in REQUESTS or a row in NOT_A_RECORD_WRITE with the reason it is not a record write
 * (`_act-held-409-requests.mjs`, the one table both files read). A route mounted next month fails here, in the local preflight, and not a
 * bundle cycle later in the Full run: bundle-272's run 45779013515 failed on the SPARQL Update door, which this case sat in the `-db` file
 * for and the pure tier never ran.
 *
 * Run: node --test testing/standalone/a-write-a-standing-act-refuses-answers-409-on-every-rest-record-route.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REQUESTS, subjects, FLOOR, PREFIX } from './_act-held-409-requests.mjs';

describe('every REST record write route a standing act must refuse has a request', () => {
  it('the subjects are derived from the mounts, have a floor, and every one has a request', async () => {
    const { SPACE_ACT_KINDS } = await import('../../server/dist/config/types-space-acts.js');
    const wantCode = SPACE_ACT_KINDS?.restore?.writeRefusalCode;
    assert.ok(subjects.length >= FLOOR, `only ${subjects.length} record write route(s) derived under ${PREFIX}, fewer than the floor of ${FLOOR}: ${subjects.join(', ')}`);
    const missing = subjects.filter(k => !REQUESTS[k]);
    assert.deepEqual(missing, [], 'a record write route under the prefix has no request here and no reason in NOT_A_RECORD_WRITE');
    const stale = Object.keys(REQUESTS).filter(k => !subjects.includes(k));
    assert.deepEqual(stale, [], 'a request names a route the server does not mount');
    assert.equal(typeof wantCode, 'string', 'SPACE_ACT_KINDS.restore has no writeRefusalCode to compare against');
  });
});
