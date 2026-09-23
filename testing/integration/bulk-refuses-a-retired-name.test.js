/**
 * `/bulk` refuses a retired name by name, like every other write door.
 *
 * ## What was reported (`Q-41`)
 *
 * The fleet integrator, 2026-09-23T0930Z: `POST /api/brain/spaces/:id/bulk` with the 4.x key `memories`
 * answers **207, nothing inserted, and an empty `errors` array** — the same answer a body that legitimately
 * wrote nothing gives. Around thirty of their builders had been writing into that key and seeing success.
 *
 * The 5.0 notes promise that a retired name is refused BY NAME with its replacement in the message, and
 * every other door keeps that promise: `entityIds` gets a 400 naming `linkEntities`, `POST .../memories`
 * is a 404. `/bulk` was the one door where the old spelling read as success, because the handler spread
 * `req.body` through a bare cast and nothing downstream ever looked at the key.
 *
 * ## Two levels, one rule
 *
 * The reported case is the TOP-LEVEL key. Reading the handler for it turned up the same shape one level
 * down: an ITEM carrying `entityIds`, `memoryIds` or `chronoIds` was dropped just as quietly, because the
 * batch writer never mentions those names either — and a batch is where it costs most, since one accepted
 * request can carry hundreds of items.
 *
 * Both are the same rule — a retired name is refused by name — so both are checked here, against the same
 * shared module every single-record door already calls.
 *
 * Run: node --test testing/integration/bulk-refuses-a-retired-name.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let token;
const SPACE = 'general';

before(() => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
});

const bulk = (body) => post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/bulk`, body);

describe('the top-level key', () => {
  it('refuses the retired `memories` and names `facts` as the replacement', async () => {
    const r = await bulk({ memories: [{ fact: 'a fact under the old key' }] });
    assert.equal(r.status, 400, `accepted the retired key: ${JSON.stringify(r.body)}`);
    const said = JSON.stringify(r.body);
    assert.ok(said.includes('memories'), `the refusal must name what was sent: ${said}`);
    assert.ok(said.includes('facts'), `the refusal must name the replacement: ${said}`);
  });

  it('refuses any other unknown key and says which keys it takes', async () => {
    // The generic half. Naming `memories` alone would leave the next caller to find the next gap — which
    // is what the single-record doors learned, and why the refusal is by SHAPE and not by a list of one.
    const r = await bulk({ totallyMadeUp: [] });
    assert.equal(r.status, 400, `accepted an unknown key: ${JSON.stringify(r.body)}`);
    const said = JSON.stringify(r.body);
    assert.ok(said.includes('totallyMadeUp'), `the refusal must name the offender: ${said}`);
    assert.ok(said.includes('facts') && said.includes('entities'),
      `the refusal must say which keys ARE accepted: ${said}`);
  });

  it('still accepts a body made only of the keys it declares', async () => {
    // The half that breaks callers if the refusal is wrong. A legitimate batch must be untouched.
    const r = await bulk({ facts: [{ fact: `bulk-strict-ok-${Date.now()}` }] });
    assert.equal(r.status, 207, `a valid body was refused: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.errors?.length ?? 0, 0, JSON.stringify(r.body));
  });

  it('accepts an empty body rather than treating "nothing asked for" as an error', async () => {
    // `{}` has no unknown keys. It writes nothing, which is what it asked for, and 207 is the honest answer
    // to that — unlike the reported case, where the caller asked for something and was told it happened.
    const r = await bulk({});
    assert.equal(r.status, 207, JSON.stringify(r.body));
  });
});

describe('an ITEM carrying a retired link array', () => {
  for (const [field, replacement] of [
    ['entityIds', 'linkEntities'],
    ['memoryIds', 'linkFacts'],
    ['chronoIds', 'linkChronos'],
  ]) {
    it(`refuses \`${field}\` and names \`${replacement}\``, async () => {
      const r = await bulk({ facts: [{ fact: 'a fact with a 4.x link array', [field]: [] }] });
      assert.equal(r.status, 400, `accepted \`${field}\` on an item: ${JSON.stringify(r.body)}`);
      const said = JSON.stringify(r.body);
      assert.ok(said.includes(field), `the refusal must name what was sent: ${said}`);
      assert.ok(said.includes(replacement), `the refusal must name the replacement: ${said}`);
    });
  }

  it('accepts the CURRENT spelling on an item', async () => {
    const e = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/entities`,
      { name: `bulk-link-target-${Date.now()}`, type: 'concept' });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    const r = await bulk({ facts: [{ fact: 'a fact linked the 5.0 way', linkEntities: [e.body.id ?? e.body._id] }] });
    assert.equal(r.status, 207, `the current spelling was refused: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.errors?.length ?? 0, 0, JSON.stringify(r.body));
  });
});
