/**
 * A config reload never drops a space silently (S-10).
 *
 * `applyConfigFromDisk` took `config.json` as the truth: a space in memory and absent from the file left config, its
 * collections stayed in Mongo as orphans, and nothing but the watcher's "reloading" line said so. Any writer of the
 * file — a deploy step, a second replica on the same volume, a restore, a hand edit — deleted spaces as far as every
 * surface could see.
 *
 * Now a space missing from the reloaded file is KEPT unless the file names it in `removeSpaces`, or an in-flight
 * rename or delete (`pendingSpaceOp`) is what removes it. Every space a reload adds, removes or keeps is named, so the
 * caller can audit each one. The decision is `reloadSpaceDiff`, pure, tested here without a stack.
 *
 * Run: node --test testing/standalone/a-reload-never-drops-a-space-silently.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let reloadSpaceDiff;
before(async () => { ({ reloadSpaceDiff } = await import('../../server/dist/config/reload-space-diff.js')); });

const sp = (id) => ({ id, label: id });

describe('what a reload does to the space list', () => {
  it('a space missing from the file is kept, and named', () => {
    const d = reloadSpaceDiff([sp('general'), sp('research')], { spaces: [sp('general')] });
    assert.deepEqual(d.kept.map(s => s.id), ['research'], 'the in-memory entry is restored');
    assert.deepEqual(d.removed, []);
  });

  it('a space the file lists in removeSpaces is removed, and named', () => {
    const d = reloadSpaceDiff([sp('general'), sp('research')], { spaces: [sp('general')], removeSpaces: ['research'] });
    assert.deepEqual(d.removed, ['research']);
    assert.deepEqual(d.kept, []);
  });

  it('a space an in-flight rename or delete takes away is not kept against it', () => {
    for (const op of [{ type: 'rename', spaceId: 'old', newId: 'new', startedAt: 'x' }, { type: 'delete', spaceId: 'old', startedAt: 'x' }]) {
      const d = reloadSpaceDiff([sp('general'), sp('old')], { spaces: [sp('general')], pendingSpaceOp: op });
      assert.deepEqual(d.kept, [], `${op.type}: the marker is the operator's own removal`);
      assert.deepEqual(d.removed, ['old']);
    }
  });

  it('a space the file adds is named as added', () => {
    const d = reloadSpaceDiff([sp('general')], { spaces: [sp('general'), sp('fresh')] });
    assert.deepEqual(d.added, ['fresh']);
    assert.deepEqual([d.kept, d.removed], [[], []]);
  });

  it('removeSpaces naming a space the file still lists removes nothing', () => {
    // Contradictory input: the file keeps the space. Keeping wins; the marker is not a delete switch.
    const d = reloadSpaceDiff([sp('general'), sp('research')], { spaces: [sp('general'), sp('research')], removeSpaces: ['research'] });
    assert.deepEqual([d.added, d.removed, d.kept], [[], [], []]);
  });
});

describe('the reload goes through the diff and audits it', () => {
  const app = stripComments(readFileSync('server/src/app.ts', 'utf8'));
  const at = app.indexOf('async function applyConfigFromDisk(');
  const body = app.slice(at, app.indexOf('startConfigWatcher(', at));
  it('applyConfigFromDisk decides with reloadSpaceDiff', () => {
    assert.ok(at > -1, 'applyConfigFromDisk is gone — re-anchor this gate');
    assert.match(body, /reloadSpaceDiff\(/);
  });
  it('and writes an audit entry per space added, removed or kept', () => {
    for (const op of ['space.reload_added', 'space.reload_removed', 'space.reload_kept']) assert.ok(body.includes(op) || app.includes(`'${op}'`), `${op} is never audited`);
  });
});
