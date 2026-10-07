/**
 * A held file tombstone refuses an arriving version of a file's metadata by THE SAME rule a held record tombstone
 * refuses an arriving record: who issued the deletion, who it was stored for, who wrote the version and who delivered it.
 *
 * ## The finding this holds (bundle-51 pre-ship lens sweep, data-integrity 5(a))
 *
 * The record side asks who (`tombSeqFor` in `sync/upsert-plan.ts`): a tombstone another instance issued does not refuse
 * a record its proven author delivers, and one stored for an upstream does not refuse that upstream's later version. The
 * file side asked only the version (`shadowDecision` in `files/tombstones.ts`: `rowSeq >= seq`). A file's path is
 * predictable where a record's id is not, so any peer allowed to push could store a tombstone with a high `rowSeq` for a
 * path nobody held yet, and every later version of a file at that path, from every author, was refused as `tombstoned`.
 *
 * ## The rule, asserted over the whole truth table rather than one case
 *
 * For every combination of issuer, `storedVia`, author and deliverer, a held tombstone above the arriving version gives
 * the file arrival the verdict the record arrival gets. Weakening either surface — the file side ignoring the issuer
 * again, or the record side losing its `storedVia` exception — fails it.
 *
 * ## Mutation that turns it red
 *
 * Drop the who-check from `shadowDecision`'s metadata half (the state before this test), or from `tombSeqFor`.
 *
 * Run: node --test testing/standalone/a-held-file-tombstone-refuses-by-the-record-rule.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

let files;
let plan;
before(async () => {
  files = await loadDistModule('../../server/dist/files/tombstones.js', import.meta.url);
  plan = await loadDistModule('../../server/dist/sync/upsert-plan.js', import.meta.url);
});

const HELD_SEQ = 10;
const ARRIVING_SEQ = 5;
const AUTHOR = 'inst-author';
const UPSTREAM = 'inst-upstream';
const OTHER = 'inst-other';

const optional = (v) => (v === undefined ? {} : v);

function recordRefused(planArrivals, { issuer, storedVia, author, deliveredBy }) {
  const doc = { _id: 'r1', seq: ARRIVING_SEQ, ...(author === undefined ? {} : { author: { instanceId: author } }) };
  const held = { seq: HELD_SEQ, ...optional(issuer && { issuer }), ...optional(storedVia && { storedVia }) };
  const p = planArrivals([doc], { kind: 'entities', door: 'push', stored: new Map(), tombstones: new Map([['r1', held]]), deliveredBy });
  return p.verdicts[0] === 'tombstoned';
}

function fileShadowed(shadowDecision, { issuer, storedVia, author, deliveredBy }) {
  const held = [{ rowSeq: HELD_SEQ, ...optional(issuer && { issuer }), ...optional(storedVia && { storedVia }) }];
  return shadowDecision(held, { kind: 'meta', seq: ARRIVING_SEQ, author, deliveredBy });
}

const ISSUERS = [undefined, AUTHOR, OTHER, UPSTREAM];
const VIAS = [undefined, UPSTREAM, OTHER];
const AUTHORS = [undefined, AUTHOR];
const DELIVERERS = [undefined, AUTHOR, UPSTREAM, OTHER];

describe('a held deletion refuses a file version exactly when it refuses a record version', () => {
  it('every combination of issuer, storedVia, author and deliverer: one verdict on both surfaces', () => {
    const { planArrivals } = needModule(plan, ['planArrivals'], 'record rule');
    const { shadowDecision } = needModule(files, ['shadowDecision'], 'file rule');
    let refused = 0, passed = 0;
    for (const issuer of ISSUERS) for (const storedVia of VIAS) for (const author of AUTHORS) for (const deliveredBy of DELIVERERS) {
      const c = { issuer, storedVia, author, deliveredBy };
      const want = recordRefused(planArrivals, c);
      assert.equal(fileShadowed(shadowDecision, c), want, `file side disagrees with the record side for ${JSON.stringify(c)}`);
      if (want) refused++; else passed++;
    }
    // Floor: the table is not vacuous on either side of the rule.
    assert.ok(refused > 0 && passed > 0, `refused ${refused}, passed ${passed}`);
  });

  it('a tombstone another peer planted for a path does not refuse the version its proven author delivers', () => {
    const { shadowDecision } = needModule(files, ['shadowDecision'], 'planted');
    assert.equal(fileShadowed(shadowDecision, { issuer: OTHER, author: AUTHOR, deliveredBy: AUTHOR }), false);
  });

  it('a tombstone stored for the upstream does not refuse that upstream\'s later version', () => {
    const { shadowDecision } = needModule(files, ['shadowDecision'], 'storedVia');
    assert.equal(fileShadowed(shadowDecision, { issuer: OTHER, storedVia: UPSTREAM, author: OTHER, deliveredBy: UPSTREAM }), false);
  });

  it('the issuer\'s own deletion still refuses its erased version, whoever delivers it', () => {
    const { shadowDecision } = needModule(files, ['shadowDecision'], 'own');
    for (const deliveredBy of DELIVERERS) {
      assert.equal(fileShadowed(shadowDecision, { issuer: AUTHOR, author: AUTHOR, deliveredBy }), true, `deliveredBy ${deliveredBy}`);
    }
  });
});
