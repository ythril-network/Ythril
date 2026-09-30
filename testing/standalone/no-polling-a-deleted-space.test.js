/**
 * The index-readiness poll stops when its space is deleted, and the ordering that makes that safe is pinned.
 *
 * ## What was wasted
 *
 * `finalizeSpaceIndexReady` already knows about a space vanishing mid-build and handles it at the WRITE — *"space
 * was deleted while its indexes built"*. The polling before the write did not, so a deleted space kept up to six
 * pollers alive, each issuing a `listSearchIndexes` every second, for the whole window: 60 s off the boot path
 * and **600 s on it**, three spaces at a time.
 *
 * Measured in CI on 2026-08-19: twelve consecutive 60-second give-ups for two `gov-…` spaces, every one reporting
 * `index not present (saw: none)` — which is what an empty catalogue looks like once the collections are gone.
 *
 * It is also precisely the case the terminal-absence guard does NOT cover. That one requires the backend to have
 * listed OTHER indexes on the collection, so it can tell "not there" from "not asked yet"; an empty listing stays
 * ambiguous. A missing SPACE settles it outright, which is why this is a separate check rather than a loosening
 * of that one.
 *
 * ## The ordering half, which is the part that could break silently
 *
 * `createSpace` builds a space's indexes BEFORE pushing it into config — deliberately, so a space always has a
 * backing database. That is only compatible with this check because it passes `waitForVectorReady: false`, so the
 * creation path never reaches the poll. **If someone reorders that, or drops the flag, this fix would start
 * abandoning legitimate builds** and the symptom would be a space stuck at `building` with nothing logged above
 * debug. So the ordering is asserted here, next to the thing that depends on it.
 *
 * Run: node --test testing/standalone/no-polling-a-deleted-space.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { blockAfter, bodyOf } from './_structural-window.mjs';

const vector = stripComments(readFileSync('server/src/spaces/vector-index.ts', 'utf8'));
const lifecycle = stripComments(readFileSync('server/src/spaces/lifecycle.ts', 'utf8'));

/*
 * The local `bodyOf` that used to live here was the FOURTH independent hand-roll of the same bound, and it was
 * narrower than it looked: it matched `export async function ${name}(` only, so it could not have found
 * `spaceStillExists`, which is a plain non-exported function. The shared helper matches any top-level
 * declaration, which is why the assertion below could move onto it at all.
 */

describe('the poll abandons a space that no longer exists', () => {
  const body = bodyOf(vector, 'pollVectorIndexReady');

  it('checks inside the loop, so it fires on every attempt rather than once', () => {
    // Once, before the loop, would only catch a space already deleted when the poll started — not the case that
    // costs anything, which is a space deleted DURING its own build.
    const loop = body.indexOf('for (let attempt = 0;');
    const check = body.indexOf('if (!spaceStillExists(spaceId))');
    assert.ok(loop > -1, 'the poll loop is gone — re-anchor this gate');
    assert.ok(check > loop, 'the existence check must be inside the attempt loop');
  });

  it('and BEFORE the listing, so a gone space costs no round trip at all', () => {
    const check = body.indexOf('if (!spaceStillExists(spaceId))');
    const listing = body.indexOf('await coll.listSearchIndexes()');
    assert.ok(listing > -1, 're-anchor: the listing call moved');
    assert.ok(check < listing, 'checking after the listing would still pay for the query it exists to avoid');
  });

  it('abandons rather than continues — a `continue` would spin at full speed', () => {
    const at = body.indexOf('if (!spaceStillExists(spaceId))');
    assert.ok(at > -1, 'the existence check is gone — re-anchor this gate');
    assert.match(blockAfter(body, at, 'the abandon branch'), /return false;/,
      'the check must return, not continue');
  });

  it('CANNOT TELL reads as "still exists", or early boot abandons its own builds', () => {
    /*
     * `getConfig()` throws before the first successful load, and index builds can run in that window. A `catch`
     * returning `false` would make every such poll conclude its space was deleted — the fix causing the outage
     * it was written to prevent, and quietly, since the log line is `debug`.
     */
    assert.match(bodyOf(vector, 'spaceStillExists'), /catch \{ return true; \}/,
      'an unreadable config must read as "the space still exists"');
  });
});

describe('the creation ordering this check depends on', () => {
  it('createSpace builds indexes WITHOUT waiting, before it commits the space', () => {
    /*
     * The precondition, asserted next to the thing that relies on it. Indexes are built before the config push so
     * a space always has a backing database; that is fine only because the build does not poll. Flip the flag and
     * the poll would run against a space that is not in config yet, see it missing, and abandon a healthy build.
     */
    const call = lifecycle.indexOf("await initSpace(opts.id, { waitForVectorReady: false });");
    const push = lifecycle.indexOf('cfg.spaces.push(space);');
    assert.ok(call > -1, 'createSpace no longer builds indexes with waitForVectorReady: false — READ THE GATE '
      + 'DOC: the readiness poll now abandons a space that is not in config, so a waiting build here would be '
      + 'abandoned before the space is committed');
    assert.ok(push > call, 'the config push must still come after the index build');
  });

  it('and finalizeSpaceIndexReady is kicked off only AFTER the commit', () => {
    // That one DOES poll, so it must never start before the space is visible in config.
    const push = lifecycle.indexOf('cfg.spaces.push(space);');
    const finalize = lifecycle.indexOf('void finalizeSpaceIndexReady(opts.id);');
    assert.ok(finalize > push, 'the polling finalizer must start after the space is committed');
  });

  it('every initSpace caller that POLLS already has its space in config', () => {
    /*
     * The callers taking the default `waitForVectorReady: true` do poll, so each must run against a committed
     * space. Counted rather than described: a new default-true caller placed before a config push is the way this
     * fix breaks, and it would look entirely reasonable at the call site.
     *
     * SWEPT ACROSS BOTH FILES that call it, not just this one. `app.ts` has a default-true caller too, and a gate
     * scoped to `lifecycle.ts` would have reported the set complete while missing it — which is the
     * one-file-sweep mistake, not a detail.
     *
     * Matches with a newline in them are the FUNCTION DECLARATION's own parameter list, which spans lines. The
     * first version of this assertion counted that as a caller.
     */
    const app = stripComments(readFileSync('server/src/app.ts', 'utf8'));
    const callers = [lifecycle, app]
      .flatMap(src => [...src.matchAll(/initSpace\((?![^)]*waitForVectorReady)[^)]*\)/g)].map(m => m[0]))
      .filter(m => !m.includes('\n'));
    assert.deepEqual(callers.sort(), ["initSpace('general')", 'initSpace(space.id)'],
      'a new initSpace caller relies on the default (waitForVectorReady: true) and therefore POLLS — confirm its '
      + 'space is in config first, then add it here');

    // `initSpace('general')` sits after the built-in space is pushed and saved.
    assert.ok(lifecycle.indexOf("await initSpace('general');") > lifecycle.indexOf("id: 'general',"));
    // `app.ts` iterates the RELOADED config, so its space is committed by construction — `concreteSpaces()` reads
    // the live config, and is the concrete-space walk since `Q-98`.
    const iterates = app.indexOf('for (const space of concreteSpaces())');
    assert.ok(iterates > -1 && app.indexOf('await initSpace(space.id);') > iterates,
      'the app.ts caller must still be iterating spaces read from config');
  });
});
