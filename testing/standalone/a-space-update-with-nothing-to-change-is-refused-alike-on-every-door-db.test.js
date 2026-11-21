/**
 * A space update that names nothing to change is refused the same way whether its body is missing, empty or a tool call without arguments
 * (bundle-270, Q-754, the pre-ship sweep's P3): `PATCH /api/spaces/:id` and the tools `update_space` and `schema_update`.
 *
 * ## What it holds
 *
 * - `PATCH /api/spaces/:id` with no body at all is 400 "expected object, received undefined", and with `{}` it is 400 "At least one of ...
 *   must be provided": main's two answers. The settings write act the route calls was once handed `{}` where main's route handed `undefined`,
 *   which turned the first into the second.
 * - `update_space` and `schema_update`, called with the space alone, are refused with "At least one of ... must be provided".
 * - A refused update changes nothing: the space's version stays.
 *
 * The expected status and sentence are the ones main answers at 5c1a484e5 (read by running this file there before it was pinned).
 *
 * Run: node --test testing/standalone/a-space-update-with-nothing-to-change-is-refused-alike-on-every-door-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openViewDoors } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'emptyupdatespace';

describe('a space update that names nothing to change is refused alike on every door (real routes, real MongoDB)', { skip, timeout: 120_000 }, () => {
  let d, admin;
  before(async () => {
    d = await openViewDoors({ suite: 'empty_space_update', spaces: [SPACE] });
    admin = await d.mint('empty-update-admin', {}, { admin: true });
  });
  after(async () => { await d?.close(); });

  const versionOf = () => d.loader.getConfig().spaces.find(s => s.id === SPACE)?.meta?.version ?? 0;

  it('PATCH with no body and PATCH with {} are each the 400 main gives, and nothing changes', async () => {
    const before = versionOf();
    const none = await d.rest(admin.key, 'PATCH', `/api/spaces/${SPACE}`);
    const empty = await d.rest(admin.key, 'PATCH', `/api/spaces/${SPACE}`, {});
    assert.equal(none.status, 400, none.text.slice(0, 300));
    assert.equal(none.error, 'Invalid input: expected object, received undefined', 'the answer for a missing body is the parse refusal of a body that is not an object');
    assert.equal(empty.status, 400, empty.text.slice(0, 300));
    assert.match(empty.error, /^At least one of .+ must be provided$/, 'the answer for {} names the changes a body may carry');
    assert.equal(versionOf(), before, 'a refused update changed the space');
  });

  it('update_space and schema_update called with the space alone are refused, and nothing changes', async () => {
    const before = versionOf();
    for (const tool of ['update_space', 'schema_update']) {
      const a = await d.mcp(admin.key, tool, { space: SPACE });
      assert.equal(a.isError, true, `${tool}: ${a.text.slice(0, 300)}`);
      assert.match(a.text, /^Error: At least one of .+ must be provided$/, `${tool}: the answer`);
    }
    assert.equal(versionOf(), before, 'a refused update changed the space');
  });
});
