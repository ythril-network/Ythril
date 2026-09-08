/**
 * The space retention tier as five buckets — the merge rules, and the legacy scalar that must keep working.
 *
 * ## Why this is a gate and not three assertions
 *
 * There are three shapes on the wire (number, object, `null`) and two in storage (a pre-split number, a
 * post-split object), so a write has six cases. Every one of them can silently lose a window an operator set,
 * and the failure is invisible until records stop expiring — or start.
 *
 * The case that drove the design: a canary operator's `tickets` space holds ticket **entities** that must outlive
 * their status-change **chronos**, and `alerts` holds durable `alert-rule` entities beside `episode` chronos that
 * are pure telemetry. A scalar cannot express either, and the schema tier does not help — it keys on a type NAME
 * while this is about a whole collection.
 *
 * **Five buckets, not four**, and they spotted why: `04-brain-api.md` makes `recordTtlDays` the default for file
 * uploads too, so splitting it four ways would have silently attached files to whichever bucket was picked.
 *
 * Run: node --test testing/standalone/record-ttl-buckets.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './_strip-comments.mjs';

const {
  normaliseRecordTtl, recordTtlWindows, TTL_BUCKETS,
} = await import('../../server/dist/spaces/record-ttl.js');
const { spaceTtlDays } = await import('../../server/dist/brain/chrono-retention.js');

const ROOT = process.cwd();
const ALL5 = { entity: 90, memory: 90, edge: 90, chrono: 90, file: 90 };

describe('the space retention tier has five buckets', () => {
  it('names all five, with file last', () => {
    assert.deepEqual([...TTL_BUCKETS], ['entity', 'memory', 'edge', 'chrono', 'file']);
  });

  it('reads a legacy scalar as every bucket — forever, not migrated', () => {
    // A space that set `recordTtlDays: 90` before the split keeps behaving identically. This is local config, so
    // a read-side widening is enough and no boot migration can half-apply across a network.
    for (const b of TTL_BUCKETS) assert.equal(spaceTtlDays({ recordTtlDays: 90 }, b), 90, b);
    assert.deepEqual(recordTtlWindows(90), ALL5);
  });

  it('reads an object per bucket, with absent meaning no window', () => {
    const stored = { chrono: 90, file: 30 };
    assert.equal(spaceTtlDays({ recordTtlDays: stored }, 'chrono'), 90);
    assert.equal(spaceTtlDays({ recordTtlDays: stored }, 'file'), 30);
    assert.equal(spaceTtlDays({ recordTtlDays: stored }, 'entity'), undefined);
    assert.deepEqual(recordTtlWindows(stored),
      { entity: null, memory: null, edge: null, chrono: 90, file: 30 });
  });

  it('treats a 0, a null and an absent bucket the same: no window', () => {
    // There is no tier above the space, so a third meaning would have nothing to point at.
    assert.equal(spaceTtlDays({ recordTtlDays: { chrono: 0 } }, 'chrono'), undefined);
    assert.equal(spaceTtlDays({ recordTtlDays: { chrono: null } }, 'chrono'), undefined);
    assert.equal(spaceTtlDays({ recordTtlDays: {} }, 'chrono'), undefined);
    assert.equal(spaceTtlDays({}, 'chrono'), undefined);
  });

  it('rejects a value the API would refuse, rather than storing it', () => {
    for (const bad of [-5, 1.5, '90', NaN, Infinity]) {
      assert.equal(spaceTtlDays({ recordTtlDays: { chrono: bad } }, 'chrono'), undefined, String(bad));
    }
  });
});

describe('normaliseRecordTtl — what a write stores', () => {
  it('a partial object MERGES over what was stored', () => {
    // The opposite of the typeSchemas rule one level down, and deliberately: there a named type is a whole
    // definition the caller holds; here each bucket is one independent number.
    assert.deepEqual(normaliseRecordTtl({ entity: 365, chrono: 90 }, { chrono: 30 }),
      { entity: 365, chrono: 30 });
  });

  it('a partial object over a stored SCALAR keeps the other four on that number', () => {
    // The scalar meant "all five". Mentioning one bucket must not silently drop the other four to nothing.
    assert.deepEqual(normaliseRecordTtl(90, { chrono: 30 }),
      { entity: 90, memory: 90, edge: 90, chrono: 30, file: 90 });
  });

  it('a per-bucket 0 or null clears just that bucket', () => {
    assert.deepEqual(normaliseRecordTtl(ALL5, { chrono: 0 }),
      { entity: 90, memory: 90, edge: 90, file: 90 });
    assert.deepEqual(normaliseRecordTtl(ALL5, { file: null }),
      { entity: 90, memory: 90, edge: 90, chrono: 90 });
  });

  it('a bare number REPLACES the whole object', () => {
    // Someone sending the legacy shape means all five; merging it in would invent an intent they never expressed.
    assert.equal(normaliseRecordTtl({ chrono: 30 }, 365), 365);
  });

  it('a bare null or 0 clears everything', () => {
    assert.equal(normaliseRecordTtl(ALL5, null), undefined);
    assert.equal(normaliseRecordTtl(ALL5, 0), undefined);
  });

  it('collapses an all-cleared object to undefined — one representation of "no retention"', () => {
    // Two shapes that read differently in the UI and compare unequal in a dirty-check would be a bug factory.
    assert.equal(normaliseRecordTtl({ chrono: 90 }, { chrono: null }), undefined);
    assert.equal(normaliseRecordTtl(undefined, { entity: 0, memory: 0, edge: 0, chrono: 0, file: 0 }), undefined);
  });

  it('setting a first window on a space that had none stores only that bucket', () => {
    assert.deepEqual(normaliseRecordTtl(undefined, { chrono: 90 }), { chrono: 90 });
  });

  it('never lets an unknown key through into config', () => {
    // The zod schema is `.strict()` so this cannot arrive over HTTP, but the function is called with a validated
    // object and must not become the place a future caller smuggles one in.
    assert.deepEqual(normaliseRecordTtl(undefined, { chrono: 90, nonsense: 5 }), { chrono: 90 });
  });
});

describe('the API and the storage type agree', () => {
  it('the route accepts both shapes and refuses an empty object', () => {
    // `UpdateSpaceBody` lives in `spaces/body-schemas.ts` with the rest of the space request bodies.
    const src = readFileSync(join(ROOT, 'server/src/spaces/body-schemas.ts'), 'utf8');
    assert.match(src, /recordTtlDays: z\.union\(\[/, 'recordTtlDays must accept a union of both shapes');
    assert.match(src, /entity: TtlWindowZ, memory: TtlWindowZ, edge: TtlWindowZ, chrono: TtlWindowZ, file: TtlWindowZ/,
      'all five buckets must be accepted');
    assert.match(src, /recordTtlDays needs at least one of/,
      'an empty object must be refused: it would make "clear everything" and "change nothing" one request');
  });

  it('the route normalises through the shared helper rather than deciding again', () => {
    // The normalisation is a DECISION, so it moved into the planner both surfaces call — a second surface that
    // normalised for itself is exactly how the two would drift.
    const src = readFileSync(join(ROOT, 'server/src/spaces/meta-update.ts'), 'utf8');
    assert.match(src, /normaliseRecordTtl\(space\.recordTtlDays, parsed\.data\.recordTtlDays\)/,
      'the merge must read what is stored, or a partial write clears the buckets it did not mention');
    const store = readFileSync(join(ROOT, 'server/src/spaces/spaces.ts'), 'utf8');
    assert.ok(!/updates\.recordTtlDays\s*&&\s*updates\.recordTtlDays\s*>\s*0/.test(store),
      'updateSpace must store what it is given, not re-decide the shape — that is how the two drift');
  });

  it('the raw body never reaches the store a second time', () => {
    // Both of the bugs the UI run found came from here. `recordTtlDays` is applied ABOVE, merged over what was
    // stored and normalised; the generic `...restPatch` spread further down then wrote the raw body over the
    // top of it. So a partial write cleared the four buckets it did not mention, and an all-cleared write stored
    // five explicit nulls instead of nothing — both with a 200 and no visible symptom.
    // The write moved into `applySpaceMetaUpdate` with the rest of the side effects, so the destructure that keeps
    // the raw body out of it moved too. Same guarantee, one file over.
    const src = readFileSync(join(ROOT, 'server/src/spaces/meta-update.ts'), 'utf8');
    assert.match(src, /const \{ documentExtraction: _rawMode, recordTtlDays: _rawTtl, \.\.\.restPatch \} = patchData;/,
      'recordTtlDays must be destructured OUT of the spread that reaches updateSpace, like documentExtraction');
  });

  it('the UI subscribes to its save — an awaited Observable sends nothing', () => {
    // The Danger Zone reported "Retention saved." and sent no request at all: `updateSpace` returns a cold
    // Observable, and awaiting one resolves with the Observable itself without ever subscribing. Every other
    // call in that component uses `.subscribe`; this was the one that did not, and nothing could see it fail.
    const src = readFileSync(join(ROOT, 'client/src/app/pages/settings/space-danger-tab.component.ts'), 'utf8');
    // Sliced to the method's own closing brace, not a character count. A fixed window silently excluded the line
    // under test — and then the NEGATIVE assertion passed for the same reason it would have with the bug present.
    const start = src.indexOf('async saveRetention');
    assert.ok(start > 0, 'saveRetention not found');
    const end = src.indexOf('\n  }', start);
    assert.ok(end > start, 'could not find the end of saveRetention');
    const save = src.slice(start, end);
    assert.match(save, /firstValueFrom\(this\.spacesApi\.updateSpace/,
      'the retention save must actually subscribe');
    assert.ok(!/await this\.spacesApi\.updateSpace/.test(save),
      'awaiting the Observable directly never subscribes — wrap it in firstValueFrom()');
  });

  it('the settings-tab footer save cannot flatten the buckets', () => {
    // It used to echo `recordTtlDays` back on every label edit. Harmless while the tier was one number; with
    // buckets a scalar write REPLACES the whole object, so a rename would have flattened every window.
    const src = readFileSync(join(ROOT, 'client/src/app/pages/settings/spaces.component.ts'), 'utf8');
    assert.ok(!/recordTtlDays: this\.state\.stForm/.test(src),
      'the footer save must not send recordTtlDays — the Danger Zone owns it and saves itself');
    // Comments STRIPPED: the rule is worth explaining where the field would otherwise be added, and this
    // fired on the prose explaining it. A source-reading gate that cannot tell code from a comment about
    // the code punishes the documentation it wants.
    const state = stripComments(
      readFileSync(join(ROOT, 'client/src/app/pages/settings/space-settings-state.service.ts'), 'utf8'));
    assert.ok(!/recordTtlDays/.test(state),
      'stForm must not hold a copy of the space window: the field it mirrored is not editable on that tab');
  });

  it('files have their own bucket, and it is used', () => {
    const src = readFileSync(join(ROOT, 'server/src/files/file-meta.ts'), 'utf8');
    const calls = src.match(/expiryForCreate\([^)]*\)/g) ?? [];
    assert.ok(calls.length >= 2, `expected the upload paths to stamp expiry, found ${calls.length}`);
    for (const c of calls) {
      assert.match(c, /collection: 'file'/, `a file upload resolves its TTL without the file bucket: ${c}`);
    }
  });

  it('a file never reaches the schema tier — it has no type', () => {
    const src = readFileSync(join(ROOT, 'server/src/brain/chrono-retention.ts'), 'utf8');
    assert.match(src, /collection === 'file' \? undefined : schemaRetention/,
      'retentionDays must skip the schema lookup for the file bucket');
    assert.match(src, /collection === 'file' \|\| !CONTENT_TIER_COLLECTIONS/,
      'contentDays must skip the file bucket before indexing the content-tier list');
  });
});
