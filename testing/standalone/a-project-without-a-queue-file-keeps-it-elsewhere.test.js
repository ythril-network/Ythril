/**
 * `todo:check` without a queue file: the queue lives elsewhere, unless open work is still sitting in `todo/`.
 *
 * Owner's y-* build, 2026-09-26: the project's queue, trackers, plans and parked decisions moved to tickets in a
 * y-tickets space, checked by the flows' own tracker check, and the tracker files left `todo/`. The script answered
 * that with `_TODO-ORDERED.md is missing — there is no index` and exit 1, so every local preflight failed.
 *
 * The missing index is not always harmless, which is why this is two cases rather than a relaxed check: an index
 * that is gone while open items still sit in a tracker file is the original failure — work nothing will reach —
 * and must still fail. Only a `todo/` holding no open items at all means the queue is kept somewhere else.
 *
 * Run: node --test testing/standalone/a-project-without-a-queue-file-keeps-it-elsewhere.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const run = (dir) => spawnSync(process.execPath, ['scripts/todo-consistency.mjs'], { encoding: 'utf8', env: { ...process.env, TODO_CHECK_DIR: dir } });
let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'todo-check-')); });
after(() => rmSync(dir, { recursive: true, force: true }));

describe('a todo/ with no queue file', () => {
  it('passes when it holds only reference pages: the queue is kept elsewhere', () => {
    // An item-shaped heading on a reference page is rationale, not open work (NOT_A_QUEUE).
    writeFileSync(join(dir, '_REFERENCE.md'), '# Reference\n\n### G-15. A resolved thing\n\nIts rationale, kept for reference.\n');
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /no queue file/i, 'it says why it passed, so a pass is not mistaken for a checked queue');
  });

  it('still fails when a tracker file holds open work that no index reaches', () => {
    writeFileSync(join(dir, 'QA-TODO.md'), '- [ ] **Q-1 — something open.** Found today.\n\n  **Verify:** still open while `grep -c "x" README.md` returns 0.\n');
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /Q-1/, 'and names the open item nothing will reach');
  });
});
