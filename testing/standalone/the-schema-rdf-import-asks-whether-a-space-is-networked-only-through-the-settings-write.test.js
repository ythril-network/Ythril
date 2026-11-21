/**
 * The schema-from-RDF act asks whether the space is in a network once, through the settings write it calls with `refuseIfNetworked` (bundle-270,
 * Q-754, the pre-ship sweep's P7).
 *
 * ## What it prevents
 *
 * The act read the networks itself a step before the settings write read them again (`refuseIfNetworked`, asked in the step that applies). Two
 * askers of one question drift: a change of the rule (what counts as networked) made at one would leave the other answering the old way, and
 * the first asker ran before the test seam that joins a space to a network between the planner's verdict and the write, so that case was never
 * the write's to refuse. The write's own refusal already answers 409 `schema_rdf_networked` with the proposal (`chainRefusal`), so the act
 * keeps no copy of the question: it neither reads `networks` from the configuration nor names the write's networked code beyond mapping it.
 *
 * The behaviour itself, both doors and the late join, is held by `a-schema-rdf-import-refuses-a-networked-space-and-opens-no-round-db.test.js`.
 *
 * Run: node --test testing/standalone/the-schema-rdf-import-asks-whether-a-space-is-networked-only-through-the-settings-write.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const ACT = 'server/src/spaces/schema-rdf-import-act.ts';
const WRITE = 'server/src/spaces/space-meta-write-act.ts';
const read = (rel) => stripComments(fs.readFileSync(`${root}/${rel}`, 'utf8').replaceAll('\r\n', '\n'));

describe('the schema-from-RDF act keeps no second copy of the networked question', () => {
  it('does not read the configured networks itself', () => {
    const src = read(ACT);
    assert.doesNotMatch(src, /\.networks\b/, `${ACT} reads the networks: ask through writeSpaceMeta with refuseIfNetworked`);
  });

  it('asks the settings write to refuse a networked space, and that write answers the code the act maps', () => {
    assert.match(read(ACT), /refuseIfNetworked:\s*true/, `${ACT} no longer asks the write to refuse a networked space`);
    const write = read(WRITE);
    assert.match(write, /refuseIfNetworked === true && getConfig\(\)\.networks\.some\(/, `${WRITE} no longer holds the question`);
    assert.match(write, /SPACE_META_WRITE_NETWORKED/, `${WRITE} no longer answers the networked code`);
  });
});
