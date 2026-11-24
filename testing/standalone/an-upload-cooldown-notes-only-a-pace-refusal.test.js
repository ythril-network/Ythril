/**
 * A caller is cooled down by a pace refusal and by nothing else, and every upload door asks and notes through the cooldown itself (bundle-270,
 * Q-953, lens finding D2).
 *
 * ## What it holds
 *
 * - A cooldown made with a door's pace codes notes the caller of a request refused with one of them, so the next request of that caller is told
 *   to wait (at least one second), and a refusal with any other code, or with none (the admin import's older refusals), notes nobody.
 * - The cooldown is the caller's: a token's, else its address's; another caller is not touched, and a table of its own belongs to each door.
 * - **No door spells the sequence by hand.** Each of the three doors (the RDF import, the schema-from-RDF door, the admin import) asks `waitOf`
 *   and notes through `noteRefusal`, and none of them asks the caller's key, so a door cannot ask without the pace codes or note without the
 *   check (the sources are read as syntax trees).
 *
 * Run: node --test testing/standalone/an-upload-cooldown-notes-only-a-pace-refusal.test.js (server build)
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { parseSource, walkEveryNode, ts } from '../_shared/syntax-tree.mjs';

const built = await import('../../server/dist/util/upload-cooldown.js').catch(() => ({}));
const PACE = new Set(['a_door_stalled', 'a_door_too_slow']);
const DOORS = ['server/src/api/brain/rdf-import.ts', 'server/src/api/spaces-schema-rdf.ts', 'server/src/api/admin-space-transfer.ts'];

/** A request as the cooldown reads it: its token's id, else its address. */
const requestOf = (tokenId, ip = '203.0.113.7') => ({ authToken: tokenId === undefined ? undefined : { id: tokenId }, ip, socket: { remoteAddress: ip } });
const cooldown = () => {
  assert.equal(typeof built.uploadCooldown, 'function', 'uploadCooldown is not exported by server/src/util/upload-cooldown.ts');
  return built.uploadCooldown(PACE);
};

describe('a cooldown is started by a pace refusal and by nothing else', () => {
  afterEach(() => built.forgetUploadCooldownsForTest?.());

  it('a refusal with one of the door\'s pace codes cools its caller down', () => {
    const c = cooldown();
    const req = requestOf('t1');
    assert.equal(c.waitOf(req), undefined, 'nobody is cooled down before a refusal');
    for (const code of PACE) {
      c.noteRefusal(req, code);
      const wait = c.waitOf(req);
      assert.ok(Number.isInteger(wait) && wait >= 1, `${code}: the caller waits at least one whole second (${wait})`);
      built.forgetUploadCooldownsForTest();
    }
  });

  it('a refusal with any other code, or with none, cools nobody down', () => {
    const c = cooldown();
    const req = requestOf('t2');
    for (const code of ['rdf_bound_exceeded', 'a_door_busy', 'a_door_stalled_not', '', undefined]) {
      c.noteRefusal(req, code);
      assert.equal(c.waitOf(req), undefined, `${JSON.stringify(code)} started a cooldown`);
    }
  });

  it('the cooldown is its caller\'s: its token, else its address, and no other caller is told to wait', () => {
    const c = cooldown();
    c.noteRefusal(requestOf('t3'), 'a_door_stalled');
    assert.ok(c.waitOf(requestOf('t3', '198.51.100.1')) >= 1, 'the token is the caller wherever it connects from');
    assert.equal(c.waitOf(requestOf('t4')), undefined, 'another token is not cooled down');
    assert.equal(c.waitOf(requestOf(undefined)), undefined, 'the address of that token is not cooled down');
    c.noteRefusal(requestOf(undefined, '198.51.100.9'), 'a_door_too_slow');
    assert.ok(c.waitOf(requestOf(undefined, '198.51.100.9')) >= 1, 'a caller with no token is its address');
    assert.equal(c.waitOf(requestOf(undefined, '198.51.100.10')), undefined, 'another address is not cooled down');
  });

  it('each door\'s table is its own', () => {
    const one = cooldown();
    const other = cooldown();
    one.noteRefusal(requestOf('t5'), 'a_door_stalled');
    assert.equal(other.waitOf(requestOf('t5')), undefined);
  });
});

describe('every upload door asks and notes through its cooldown', () => {
  /** The names called as `<x>.<name>(…)` or `<name>(…)` in `file`'s code. */
  const callsOf = (file) => {
    const names = new Set();
    walkEveryNode(parseSource(file, readFileSync(join(REPO_ROOT, file), 'utf8')), (n) => {
      if (!ts.isCallExpression(n)) return;
      const e = n.expression;
      if (ts.isPropertyAccessExpression(e)) names.add(e.name.text);
      else if (ts.isIdentifier(e)) names.add(e.text);
    });
    return names;
  };
  for (const file of DOORS) {
    it(`${file} asks waitOf and notes through noteRefusal, and never reads the caller's key`, () => {
      const calls = callsOf(file);
      assert.ok(calls.has('waitOf'), 'it never asks whether the caller is cooled down');
      assert.ok(calls.has('noteRefusal'), 'it never notes a refusal');
      for (const hand of ['uploadCallerKey', 'retryAfterSeconds', 'note']) assert.ok(!calls.has(hand), `it spells ${hand} by hand`);
    });
  }
});
