/**
 * ID IS ID: a record's identity is minted by the server, never supplied by the caller.
 *
 * Owner ruling, 2026-08-12: *"we do not accept custom ids. on write time one is mongodb-generated … they can use
 * name or description for descriptive fields. id is id."*
 *
 * ## What it used to do
 *
 * `save_chrono`, `remember`, `save_entity` and `save_bulk` all adopted a supplied id when it named nothing:
 *
 *     _id: fields.id ?? uuidv4()
 *
 * documented as an idempotency feature — retry with the same id and converge on the same record. That made the
 * caller a co-author of our primary key, and it has a sharp edge across a network: the natural way to get a
 * stable id is to DERIVE it from a stable key, so two instances following one convention collide **by design**.
 * Inbound sync resolves a collision purely by `seq` (`api/sync/docs.ts` — replaceOne when the incoming seq is
 * higher), with no author comparison, so the loser is overwritten silently. The link-violation machinery cannot
 * see it either: both records are internally valid and every reference still resolves, to whichever survived.
 *
 * A supplied id may still ADDRESS an existing record — that is what an id is for. It may not become one.
 *
 * ## Why this is a gate rather than four fixes
 *
 * Because it was four, and the report that prompted the audit named two. A rule enforced by reading every write
 * path is a rule; four correct lines are a coincidence that holds until someone adds a fifth collection.
 *
 * ## This file replaced the gate that enforced the opposite
 *
 * It was `idempotent-writes-contract.test.js`, and it asserted the old contract explicitly — *"memory: a supplied
 * id becomes the new record's identity"*, and that the docs *"tell the reader to generate the id BEFORE the first
 * attempt"*. Those were correct assertions about a contract that no longer exists.
 *
 * It keeps the old FILENAME on purpose: `scripts/release-gate.mjs` lists it by name, and the release gate must go
 * on checking this area. A gate whose subject is reversed gets rewritten, not deleted — deleting it would have
 * removed the release gate's only check here and nothing would have said so.
 *
 * The behavioural half — how many records exist after a second call — is a database question and lives in
 * `testing/integration/idempotent-writes.test.js`, which needs Docker and runs in CI.
 *
 * Run: node --test testing/standalone/idempotent-writes-contract.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const strip = s => s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const serverFiles = execSync('git ls-files "server/src/**/*.ts"', { encoding: 'utf8' })
  .trim().split('\n').filter(f => f && !f.endsWith('.spec.ts'));

describe('identity is minted by the server', () => {
  it('finds the write paths it is meant to be checking', () => {
    // A sweep that enumerates nothing passes vacuously. Every record family must assign an `_id` somewhere.
    const assigning = serverFiles.filter(f => /_id:\s*uuidv4\(\)|_id:\s*randomUUID\(\)/.test(strip(readFileSync(f, 'utf8'))));
    assert.ok(assigning.length >= 3,
      `expected the create paths that mint an id, found ${assigning.length} — if these moved, re-point this test`);
  });

  it('no write path adopts a caller-supplied id as the record identity', () => {
    // The exact shape that shipped, in every spelling of it. `?? uuidv4()` is the tell: a fallback means the
    // first operand was a caller's value.
    const bad = [];
    for (const f of serverFiles) {
      const src = strip(readFileSync(f, 'utf8'));
      for (const m of src.matchAll(/_id:\s*([^,\n]*\?\?\s*(?:uuidv4|randomUUID)\(\))/g)) {
        bad.push(`${f}: ${m[1].trim()}`);
      }
    }
    assert.deepEqual(bad, [],
      'these adopt a caller-supplied id as a new record\'s identity, which makes the caller a co-author of the '
      + `primary key and lets two instances collide by design across sync:\n  ${bad.join('\n  ')}`);
  });

  it('the tool schemas do not advertise choosing an id', () => {
    // The docs promised idempotency-by-id. Leaving that text while removing the behaviour is worse than either:
    // a caller reads the description, retries with the same id, and gets a second record.
    const tools = execSync('git ls-files "server/src/mcp/tools/*.ts"', { encoding: 'utf8' })
      .trim().split('\n').filter(f => f && !f.endsWith('.spec.ts'));
    const stale = [];
    for (const f of tools) {
      const src = readFileSync(f, 'utf8');
      if (/Optional UUID v4/.test(src)) stale.push(`${f.split('/').pop()} still says "Optional UUID v4"`);
      if (/inserts with this ID/.test(src)) stale.push(`${f.split('/').pop()} still promises insert-with-id`);
      if (/make this call IDEMPOTENT/.test(src)) stale.push(`${f.split('/').pop()} still promises idempotency by id`);
    }
    assert.deepEqual(stale, [],
      `a description that outlives its behaviour is how a caller builds on a contract that is gone:\n  ${stale.join('\n  ')}`);
  });

  it('an id may still ADDRESS an existing record', () => {
    // The half that must NOT be removed. Update and delete take an id, and records written before this ruling
    // may carry a non-UUID one — so those paths stay permissive, or the junk they created becomes undeletable.
    const chrono = strip(readFileSync('server/src/brain/chrono.ts', 'utf8'));
    assert.match(chrono, /_id: fields\.id, spaceId/,
      'the lookup-by-supplied-id path is gone, so an update can no longer find its record');
  });
});
