/**
 * A view admits a member only when its reader would read it through the view: one admission rule (`memberAdmissible`) for create, update
 * and copy, and it is `viewReadMembers`' own question (Q-531, bundle-100 row 12).
 *
 * ## The rule
 *
 * What a view reads is decided at read time by `viewReadMembers`: per member, the reader reaches it, holds `read` in the door's area, and it
 * is not held for a peer the reader is bound to. Create and update (`checkedMembers`) and copy each admitted a member by REACH alone, in
 * two spellings - so a space the reader held only a SCHEMA rung on (reach, and no area a view is read in) was listed, answered as
 * accepted, and read by no door: a view that says it reads a space and never does. The copy kept such a space for the receiver the same way.
 *
 * Both doors share the acts, so REST is enough to hold the rule; the MCP twins call the same functions.
 *
 * ## Seen red at 743562a5
 *
 * The create with a schema-only member answered 201 and listed it; the copy kept the receiver's schema-only member.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), npm run build:server, then
 *      node --test testing/standalone/a-view-admits-only-members-its-reader-reads-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openViewDoors, viewOf } from './_view-doors.mjs';

const skip = await mongoSkipReason();
const READ = 'va-read';
const SCHEMA_ONLY = 'va-schema';
let d;
const fmt = (a) => `${a.status} ${(a.text ?? '').slice(0, 200)}`;

describe('a view admits only members its reader reads (Q-531)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'b100-view-admission', spaces: [READ, SCHEMA_ONLY] });
  });
  after(async () => { await d?.close(); });

  it('create and update refuse a member the caller reaches only through a schema rung', async () => {
    const caller = await d.mint('va-caller', { [READ]: d.row({ knowledge: 'read' }), [SCHEMA_ONLY]: d.row({ schema: 'read' }) });
    const created = await d.rest(caller.key, 'POST', '/api/views', { name: 'va-mixed', members: [READ, SCHEMA_ONLY] });
    assert.ok(created.status >= 400 && created.status < 500, `a view listing a member no door reads for its owner was made: ${fmt(created)}`);
    const ok = await d.rest(caller.key, 'POST', '/api/views', { name: 'va-good', members: [READ] });
    assert.equal(ok.status, 201, `a readable member was refused: ${fmt(ok)}`);
    const changed = await d.rest(caller.key, 'PATCH', '/api/views/%40va-good', { members: [READ, SCHEMA_ONLY] });
    assert.ok(changed.status >= 400 && changed.status < 500, `an update admitted a member no door reads for its owner: ${fmt(changed)}`);
  });

  it('a copy keeps only the members the receiver would read through it', async () => {
    const admin = await d.mint('va-admin', {}, { admin: true });
    const made = await d.rest(admin.key, 'POST', '/api/views', { name: 'va-both', members: [READ, SCHEMA_ONLY] });
    assert.equal(made.status, 201, `the admin's view: ${fmt(made)}`);
    const receiver = await d.mint('va-receiver', { [READ]: d.row({ knowledge: 'read' }), [SCHEMA_ONLY]: d.row({ schema: 'read' }) });
    const copied = await d.rest(admin.key, 'POST', '/api/views/%40va-both/copy', { toTokenId: receiver.id });
    assert.ok(copied.status === 201 || copied.status === 200, `the copy: ${fmt(copied)}`);
    assert.deepEqual(viewOf(copied)?.members, [READ], 'the copy kept a member the receiver reads through no door');
  });
});
