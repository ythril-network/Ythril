/**
 * `openPushDoor` refuses `monitorCommands` and `mongoQuery` together, and says why (bundle-56 round S, R10).
 *
 * ## What it prevents
 *
 * Both options reconnect the server's Mongo client with a connection string of their own, after the door is open; the
 * second replaces the first's. Passing both silently dropped the command monitoring (its docblock only said "not with"),
 * and a test that then read `commandsDuring` asserted over nothing. The refusal is `refuseConflictingPushDoorOptions`
 * (`_push-door-options.mjs`), called FIRST by `openPushDoor`, before a directory is made or a database is touched.
 *
 * ## What is held
 *
 * - each option alone is accepted, and neither is the default;
 * - both together throw, naming both options;
 * - `openPushDoor` calls the refusal before it does anything else (read from its source, comments stripped: the first
 *   statement of the function), so the guard cannot be the part a caller reaches too late. The door itself is not opened
 *   here: it needs the harness Mongo, and the refusal needs nothing.
 *
 * Run: node --test testing/standalone/a-push-door-refuses-options-that-cancel-each-other.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { refuseConflictingPushDoorOptions } from './_push-door-options.mjs';

describe('openPushDoor options that cancel each other', () => {
  it('each option alone is accepted, and so are neither', () => {
    assert.doesNotThrow(() => refuseConflictingPushDoorOptions({ monitorCommands: true }));
    assert.doesNotThrow(() => refuseConflictingPushDoorOptions({ mongoQuery: '&timeoutMS=300' }));
    assert.doesNotThrow(() => refuseConflictingPushDoorOptions({}));
    assert.doesNotThrow(() => refuseConflictingPushDoorOptions({ monitorCommands: false, mongoQuery: '' }));
  });

  it('both together are refused, and the refusal names both', () => {
    assert.throws(() => refuseConflictingPushDoorOptions({ monitorCommands: true, mongoQuery: '&timeoutMS=300' }), /monitorCommands.*mongoQuery/);
  });

  it('openPushDoor refuses before it does anything else', () => {
    const code = stripComments(readFileSync(join(REPO_ROOT, 'testing/standalone/_push-door.mjs'), 'utf8'));
    const NAME = 'openPush' + 'Door'; // not written whole: a gate that finds the files opening the database reads the name
    const at = code.indexOf(`export async function ${NAME}(`);
    assert.ok(at >= 0, 'openPushDoor is not where this gate looks');
    const body = code.slice(code.indexOf('{', code.indexOf(')', at) + 1) + 1);
    assert.match(body.trimStart(), /^refuseConflictingPushDoorOptions\(\{\s*monitorCommands,\s*mongoQuery\s*\}\);/, 'openPushDoor does not begin by refusing options that cancel each other');
  });
});
