/**
 * Nothing in a client template is drawn behind a condition that can only ever be one value.
 *
 * ## What this is for (`Q-13`)
 *
 * The Media Processing page rendered the outcome of every save — the server's refusal and its reason, and
 * the confirmation that a save was stored — inside one block, and that block was guarded by a computed
 * whose whole body was the literal `false`. So it never appeared, on any tab, for any card. A refused save
 * looked exactly like a button that did nothing, and a successful one looked the same.
 *
 * An operator hit it against 4.0.0 and spent an hour not knowing which field the API was objecting to. The
 * reason had been sent, received and stored in a signal the entire time.
 *
 * ## Why the gate is on the CONSTANT and not on the message
 *
 * The obvious gate — "the refusal signal is referenced by a template" — would have been green throughout.
 * The reference existed. What made it dead was the guard around it, and that is the part a reader skims:
 * `@if (showsSave() && ...)` reads as a real condition, and the name is a promise the body does not keep.
 *
 * A condition that cannot vary is either scaffolding somebody forgot to remove or a feature that was
 * switched off in a place nobody looks. Both are the same defect from the operator's side: a control that
 * is documented, wired, and invisible. Delete the branch, or give the flag a real source.
 *
 * The `true` half is included deliberately. It is the cheaper mistake — the block renders — but it is the
 * same lie about the code, and it is what a `false` becomes when somebody "fixes" it in a hurry.
 *
 * Run: node --test testing/standalone/no-control-is-rendered-behind-a-constant.test.js
 */
import { test } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The spellings of "this value is decided here and never changes again".
 *
 * A `computed` is the one that hid, because it is the shape that looks most like real logic — it is a
 * function, so nothing about the call site suggests the answer is fixed. A `signal(false)` that is never
 * `set` is the same thing arrived at differently, and is left to a future pass: proving a signal is never
 * written needs the whole component, and a rule that is only half-checkable is worse than a narrow one
 * that is exact. See *A gate concludes about MORE than it checks* in the y-flows convention `convention-a-test-derives-its-set`.
 */
const CONSTANT_COMPUTED = /(?:readonly\s+)?(\w+)\s*=\s*computed\s*(?:<[^>]*>)?\s*\(\s*\(\s*\)\s*(?::\s*boolean\s*)?=>\s*(true|false)\s*\)/g;

test('no client computed is a hard-coded true or false', () => {
  const listed = trackedSources('client/src')
    .filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
  // A FLOOR, because an empty listing passes every loop written over it — the failure this gate would
  // otherwise report as success.
  assert.ok(listed.length > 100, `only ${listed.length} client sources found; the listing is broken`);

  const found = [];
  for (const file of listed) {
    const src = readFileSync(join(repoRoot, file), 'utf8');
    for (const m of src.matchAll(CONSTANT_COMPUTED)) {
      found.push(`${file}: ${m[1]} is always ${m[2]}`);
    }
  }

  assert.deepEqual(found, [],
    'these read as conditions and are not:\n  ' + found.join('\n  ')
    + '\n\nAnything drawn behind one is invisible to every operator, with nothing anywhere to say so — that '
    + 'is how the reason for a refused save went unshown on Media Processing for two releases. Either delete '
    + 'the branch that uses it, or give it a real source.');
});
