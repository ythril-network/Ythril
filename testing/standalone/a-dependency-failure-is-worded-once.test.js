/**
 * The sentence a batch row says when what it depends on was not written is worded in ONE function (`Q-201`).
 *
 * ## The rule
 *
 * `it depends on an item of this request that was not written: <why>` — and its `$ref` form, `$ref "<key>" names an item of
 * this request that was not written: <why>` — is the answer for an edge (or any dependant) whose record or other end was not
 * written. The words "of this request that was not written" occur in the tracked `server/src` files only inside
 * `dependencyFailed`, a function of `server/src/brain/write-plan/`, and that function has at least three call sites (the commit,
 * the batch's flush, and the `$ref` resolver), so each of them says it by calling, not by retyping.
 *
 * ## The failure that bought it
 *
 * `Q-201`: the sentence was hand-written three times (`write-plan/commit.ts`, `brain/bulk.ts`, `brain/batch-refs.ts`). The
 * change that makes an edge wait for its record's FINAL outcome needed every site to say the same thing about the same
 * failure — a record that lost its race twice reports the conflict, and the edge must carry that conflict text — and three
 * copies are three places to forget. A published reason string that drifts between doors is what the write-semantics guide
 * promises cannot happen.
 *
 * Comments are stripped before matching (a comment may quote the sentence); the scan lists tracked files (`git ls-files`), not
 * a directory walk, so a build output or a scratch copy cannot satisfy or break it.
 *
 * Run: node --test testing/standalone/a-dependency-failure-is-worded-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { withoutBodyOf } from './_structural-window.mjs';

const PHRASE = 'of this request that was not written';
const HOME_DIR = 'server/src/brain/write-plan/';

/** Every tracked server source, comments out, with the function's own body taken out of the file that declares it. */
function scan() {
  const declaredIn = [];
  const outside = [];
  for (const file of trackedSources('server/src', { floor: 200 })) {
    const src = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
    const { declared, body: home, rest } = withoutBodyOf(src, 'dependencyFailed', `${file}: dependencyFailed`);
    if (declared) declaredIn.push(file);
    outside.push({ file, rest, home });
  }
  return { declaredIn, outside };
}

describe('the dependency failure sentence', () => {
  const { declaredIn, outside } = scan();

  it('is worded by one function, `dependencyFailed`, declared in the write-plan directory', () => {
    assert.equal(declaredIn.length, 1, `\`dependencyFailed\` must be declared exactly once, found: ${JSON.stringify(declaredIn)}`);
    assert.ok(declaredIn[0].startsWith(HOME_DIR), `\`dependencyFailed\` is declared in ${declaredIn[0]}, not under ${HOME_DIR}`);
    const home = outside.find(o => o.file === declaredIn[0]).home;
    assert.ok(home.includes(PHRASE), `\`dependencyFailed\` does not contain the sentence ("${PHRASE}")`);
  });

  it('occurs nowhere else in server/src, comments aside', () => {
    const offenders = [];
    for (const { file, rest } of outside) {
      // The line TEXT, not its number: the comment-stripped source has fewer lines than the file.
      for (const line of rest.split(/\r?\n/)) if (line.includes(PHRASE)) offenders.push(`${file}: ${line.trim().slice(0, 120)}`);
    }
    assert.deepEqual(offenders, [],
      `the sentence "${PHRASE}" is hand-written outside \`dependencyFailed\` at: ${offenders.join(' | ')} — call the function instead`);
  });

  it('has at least three call sites', () => {
    const calls = outside.flatMap(({ file, rest }) => (rest.match(/\bdependencyFailed\(/g) ?? []).map(() => file));
    assert.ok(calls.length >= 3, `\`dependencyFailed(\` has ${calls.length} call site(s) (${JSON.stringify(calls)}); the commit, the batch flush and the \`$ref\` resolver all say it`);
  });
});
