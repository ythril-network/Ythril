/**
 * The shared source listing refuses to answer with nothing.
 *
 * ## What this guards, and why it is not obvious
 *
 * Ten gates ask "what does the server contain" and then assert something about every answer. If the listing
 * ever returns empty — a `git` that failed, a path typed wrong, a rename — every one of those loops runs
 * zero times and every one of them passes. The gate then reports a green tick about a set it never read,
 * which is precisely the defect the whole `Q-6` sweep exists to remove, one level up.
 *
 * So the floor lives inside `trackedSources` and THROWS. These cases are what make that a fact rather than
 * an intention: a helper whose failure mode has never been observed is a claim.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources, readTrackedSources, REPO_ROOT, SERVER_CODE_ROOTS } from './_sources.mjs';

describe('the listing answers with the repository', () => {
  it('finds the server sources', () => {
    const files = trackedSources(SERVER_CODE_ROOTS);
    assert.ok(files.length > 100, `found ${files.length}`);
    assert.ok(files.every(f => f.endsWith('.ts')), 'the extension filter let something else through');
    assert.ok(files.includes('server/src/config/types.ts'), 'a file everyone knows is there is missing');
  });

  it('takes more than one directory, and more than one extension', () => {
    const mixed = trackedSources([...SERVER_CODE_ROOTS, 'docs'], { ext: ['.ts', '.md'] });
    assert.ok(mixed.some(f => f.endsWith('.md')), 'no markdown came back from docs/');
    assert.ok(mixed.some(f => f.endsWith('.ts')), 'no typescript came back from server/src');
  });

  it('drops an excluded path, which is how a definer is left out', () => {
    // Every sweep of "who copies X" has to exclude the module that DECLARES X, or it reports the source of
    // truth as a copy of itself.
    const without = trackedSources(SERVER_CODE_ROOTS, { exclude: ['server/src/config/types.ts'] });
    assert.ok(!without.includes('server/src/config/types.ts'));
  });

  it('never returns a declaration file, without being asked', () => {
    // Every caller that hand-rolled this excluded `.d.ts`, which is what makes it a default rather than an
    // option — and a default nobody has to remember is one nobody can forget.
    assert.ok(!trackedSources(SERVER_CODE_ROOTS).some(f => f.endsWith('.d.ts')));
  });

  it('and leaves specs out on request, which is the one real second question', () => {
    const withSpecs = trackedSources('client/src', { floor: 100 });
    const without = trackedSources('client/src', { floor: 100, specs: false });
    assert.ok(withSpecs.some(f => f.endsWith('.spec.ts')), 'the client has specs; none came back');
    assert.ok(!without.some(f => f.endsWith('.spec.ts')), 'specs: false still returned specs');
    assert.ok(without.length < withSpecs.length);
  });

  it('paths are repo-relative with forward slashes, on any platform', () => {
    // They are used as `join(REPO_ROOT, f)` and compared against literals in assertion messages. A backslash
    // here would make every `exclude` silently miss on Windows.
    const files = trackedSources(SERVER_CODE_ROOTS);
    assert.ok(!files.some(f => f.includes('\\')), 'a backslash reached a path');
    assert.ok(REPO_ROOT.length > 0);
  });
});

describe('and it fails loudly rather than reporting nothing', () => {
  it('throws when the floor is not met', () => {
    /*
     * The case the whole module is for. A caller that received `[]` would loop over nothing and pass — so
     * this must not be a returned empty array under any circumstance a caller can reach.
     */
    assert.throws(() => trackedSources(SERVER_CODE_ROOTS, { floor: 100_000 }), /listing is broken/);
  });

  it('throws on a path that matches nothing at all', () => {
    // The realistic version: a directory renamed, or a typo in the argument. Both give an empty listing, and
    // an empty listing that returns quietly is a gate reporting success about a set it never read.
    assert.throws(() => trackedSources('server/does-not-exist'), /listing is broken/);
  });

  it('the reader carries the floor too, not just the lister', () => {
    // `readTrackedSources` is the convenience wrapper, and a wrapper that skipped the check would be the
    // easier thing to reach for — which is how the guard gets lost.
    assert.throws(() => readTrackedSources(SERVER_CODE_ROOTS, { floor: 100_000 }), /listing is broken/);
  });

  it('the reader returns text beside the path', () => {
    const read = readTrackedSources(SERVER_CODE_ROOTS, { floor: 100 });
    const one = read.find(r => r.file === 'server/src/config/types.ts');
    assert.ok(one, 'a known file did not come back');
    assert.ok(one.text.includes('CHRONO_STATUSES'), 'the text is not the file');
  });
});
