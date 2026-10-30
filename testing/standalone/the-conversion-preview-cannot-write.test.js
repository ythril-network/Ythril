/**
 * The migration preview reads, and there is no path through it that writes.
 *
 * ## What it is for (`Q-15`)
 *
 * An operator asked to convert live data to link records had not run it, and said why: they could not see
 * the scale of it beforehand, the 400 that follows lands on some other service's next write, and nothing
 * anywhere said whether it could be undone. *"An operator who believes a step is irreversible defers it,
 * which is what we are doing."*
 *
 * `--preview` is the answer to the first of those. It is only an answer while it is TRUE that it writes
 * nothing — a preview an operator does not trust is worse than none, because it costs the trust of
 * everything printed beside it.
 *
 * ## Why an ALLOWLIST of reads rather than a list of writes
 *
 * A list of forbidden calls — `insertOne`, `updateMany`, `bulkWrite` — is a list somebody has to keep
 * complete against a driver they do not own, and the day it misses one is the day it passes over the defect.
 * See *A gate concludes about MORE than it checks* in the y-flows convention `convention-a-test-derives-its-set`.
 *
 * So this inverts it: the preview may call `countDocuments` and `aggregate` on a collection, and nothing
 * else. A new call fails here until somebody looks at it, which for this function is exactly the review
 * that should happen.
 *
 * `aggregate` gets its own case, because two of its stages write — `$out` and `$merge` — and a pipeline is
 * the one place a "read" method is not one.
 *
 * Run: node --test testing/standalone/the-conversion-preview-cannot-write.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The body of one exported async function, from its signature to the closing brace at column 0. */
function functionBody(src, name) {
  const start = src.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone — this gate now guards nothing`);
  const end = src.indexOf('\n}', start);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return src.slice(start, end);
}

const conversion = readFileSync(join(repoRoot, 'server/src/brain/links-conversion.ts'), 'utf8');

test('the preview calls nothing on a collection but the two read methods', () => {
  const body = functionBody(conversion, 'previewSpaceLinks');

  // Every `.name(` on the result of `col(...)`, however the call is spelled or wrapped.
  const called = [...body.matchAll(/\bcol(?:<[^>]*>)?\([^)]*\)\s*\.\s*(\w+)/g)].map(m => m[1]);
  assert.ok(called.length >= 2, `found ${called.length} collection calls in the preview; the scan is broken`);

  const notRead = [...new Set(called)].filter(m => m !== 'countDocuments' && m !== 'aggregate');
  assert.deepEqual(notRead, [],
    `the preview calls ${notRead.join(', ')} on a collection. It is offered to operators as the safe thing `
    + 'to run first against live data, and it is only that while it reads. If one of these is genuinely a '
    + 'read, add it to the allowlist here deliberately.');
});

test('no aggregation stage in the preview writes', () => {
  const body = functionBody(conversion, 'previewSpaceLinks');
  // `$out` and `$merge` are the two stages that persist. Both are ordinary-looking keys in a pipeline
  // literal, which is why a method-name check alone does not cover `aggregate`.
  for (const stage of ['$out', '$merge']) {
    assert.ok(!body.includes(stage), `the preview's pipeline uses ${stage}, which writes its result to a collection`);
  }
});

test('the preview branch of the script returns before any conversion call', () => {
  /*
   * The other half, and the one a reader is likelier to break: the function can be spotless while the
   * script runs it and then falls through into the conversion. Asserting the ORDER is what makes
   * `--preview` a mode rather than an extra line of output.
   */
  const script = readFileSync(join(repoRoot, 'scripts/convert-links.mjs'), 'utf8');
  const branch = script.indexOf('if (preview)');
  assert.notEqual(branch, -1, 'the script no longer has a preview branch');

  const exit = script.indexOf('process.exit(0)', branch);
  assert.notEqual(exit, -1, 'the preview branch no longer exits — it now falls through into the conversion');

  for (const call of ['convertSpaceLinks(', 'convertAllLinks(']) {
    const at = script.indexOf(call, branch);
    assert.ok(at === -1 || at > exit,
      `${call} is reachable inside the preview branch, so --preview would convert. It has to exit first.`);
  }
});
