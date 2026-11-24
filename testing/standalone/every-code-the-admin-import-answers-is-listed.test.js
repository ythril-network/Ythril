/**
 * Every code the admin import (`POST /api/admin/spaces/:spaceId/import`) answers is in its refusal list and in the admin guide's import
 * section, and the refusals it answers without a code stay without one (bundle-270, Q-953, test 6).
 *
 * ## What it prevents
 *
 * The door gained coded refusals for an upload that stalls or trickles, and a cooldown for the caller refused; a list written by hand beside
 * them drifts, as the RDF import's did (nine codes answered and listed nowhere). The codes are derived here from the door's source, never from
 * the list under test: a `code: '<literal>'` or `code: <CONSTANT>` in the import's part of `api/admin-space-transfer.ts`, and the import act
 * kind's `writeRefusalCode` (its busy answer). A code answered and not listed fails, a listed code nobody answers fails, and so does one the
 * guide's import section omits. The older refusals (400, 413, 415, 507) answer no code and are named so in the guide: a code added to one of
 * them is a change this test sees.
 *
 * Run: node --test testing/standalone/every-code-the-admin-import-answers-is-listed.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const read = (rel) => fs.readFileSync(`${root}/${rel}`, 'utf8').replaceAll('\r\n', '\n');
const code = (rel) => stripComments(read(rel));

const DOOR = 'server/src/api/admin-space-transfer.ts';
const GUIDE = 'docs/integration-guide/12-admin-api.md';
const source = code(DOOR);
/** The import's part of the door's file: from the import's first declaration to the end (the export comes before it). */
const importPart = source.slice(source.indexOf('class OverCeiling'));
const consts = Object.fromEntries([...source.matchAll(/(?:export )?const ([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/g)].map(m => [m[1], m[2]]));

function answered() {
  const found = new Set();
  // A constant, not the head of a member path (`SPACE_ACT_KINDS.import.writeRefusalCode` is read below, from its table).
  for (const m of importPart.matchAll(/\bcode:\s*(?:'([^']+)'|([A-Z][A-Z0-9_]*)\b(?![.\w]))/g)) {
    if (m[1]) found.add(m[1]);
    else { assert.ok(consts[m[2]], `the constant ${m[2]} a refusal names is a string constant of ${DOOR}`); found.add(consts[m[2]]); }
  }
  if (/code:\s*SPACE_ACT_KINDS\.import\.writeRefusalCode/.test(importPart)) found.add(busyCode());
  return found;
}

function listed() {
  const body = source.match(/SPACE_IMPORT_REFUSAL_CODES[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1];
  assert.ok(body !== undefined, `SPACE_IMPORT_REFUSAL_CODES is not in ${DOOR}`);
  const list = new Set([...body.matchAll(/'([^']+)'|\b([A-Z][A-Z0-9_]*)\b(?![.\w])/g)].map(m => m[1] ?? consts[m[2]]).filter(Boolean));
  if (/writeRefusalCode/.test(body)) list.add(busyCode());
  return list;
}

/** The import act kind's busy code, from the act kinds' table. */
function busyCode() {
  const busy = code('server/src/config/types-space-acts.ts').match(/\bimport:\s*\{[\s\S]*?writeRefusalCode:\s*'([a-z_]+)'/)?.[1];
  assert.ok(busy, 'the import act kind\'s writeRefusalCode was read');
  return busy;
}

function guideSection() {
  const guide = read(GUIDE);
  const start = guide.indexOf('### Import Space');
  assert.ok(start >= 0, `${GUIDE} has no import section`);
  const next = guide.indexOf('\n### ', start + 1);
  return guide.slice(start, next < 0 ? undefined : next);
}

describe('every code the admin import answers is listed', () => {
  const codes = answered();

  it('the door answers codes, and the derivation found them (a probe that cannot read answers nothing)', () => {
    for (const c of ['space_being_imported', 'shutting_down', 'space_import_upload_stalled', 'space_import_upload_too_slow', 'space_import_upload_cooldown']) {
      assert.ok(codes.has(c), `${c} is among the codes derived from ${DOOR}`);
    }
  });

  it('every answered code is in SPACE_IMPORT_REFUSAL_CODES, and the list names nothing nobody answers', () => {
    const list = listed();
    assert.deepEqual([...codes].filter(c => !list.has(c)).sort(), [], 'answered but not listed');
    assert.deepEqual([...list].filter(c => !codes.has(c)).sort(), [], 'listed but answered by no source');
  });

  it('every answered code is in the guide\'s import section, and the pace refusals are named 408 there', () => {
    const section = guideSection();
    const inGuide = new Set([...section.matchAll(/`([a-z][a-z0-9_]*_[a-z0-9_]+)`/g)].map(m => m[1]));
    assert.deepEqual([...codes].filter(c => !inGuide.has(c)).sort(), [], 'answered but not in the guide');
    for (const c of ['space_import_upload_stalled', 'space_import_upload_too_slow']) {
      assert.ok(section.split('\n').some(l => l.includes(`\`${c}\``) && l.includes('408')), `the guide does not name ${c} with 408`);
    }
    assert.ok(!/5 minutes/.test(section), 'the guide still says a body may take the request timeout\'s five minutes');
  });
});
