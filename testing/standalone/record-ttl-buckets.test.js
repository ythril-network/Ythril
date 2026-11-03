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
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './_strip-comments.mjs';
import { tempInstanceDir, removeInstanceDir, bootInstance } from './_vote-round-instance.mjs';

// CONFIG_PATH and DATA_ROOT are set BEFORE anything of the build is imported: the writes below go through the real config loader.
const dir = tempInstanceDir('ythril-ttl-');

const {
  normaliseRecordTtl, recordTtlWindows, TTL_BUCKETS,
} = await import('../../server/dist/spaces/record-ttl.js');
const { spaceTtlDays } = await import('../../server/dist/brain/chrono-retention.js');

const ROOT = process.cwd();
const ALL5 = { entity: 90, fact: 90, edge: 90, chrono: 90, file: 90 };

describe('the space retention tier has five buckets', () => {
  it('names all five, with file last', () => {
    assert.deepEqual([...TTL_BUCKETS], ['entity', 'fact', 'edge', 'chrono', 'file']);
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
      { entity: null, fact: null, edge: null, chrono: 90, file: 30 });
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
      { entity: 90, fact: 90, edge: 90, chrono: 30, file: 90 });
  });

  it('a per-bucket 0 or null clears just that bucket', () => {
    assert.deepEqual(normaliseRecordTtl(ALL5, { chrono: 0 }),
      { entity: 90, fact: 90, edge: 90, file: 90 });
    assert.deepEqual(normaliseRecordTtl(ALL5, { file: null }),
      { entity: 90, fact: 90, edge: 90, chrono: 90 });
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
    assert.equal(normaliseRecordTtl(undefined, { entity: 0, fact: 0, edge: 0, chrono: 0, file: 0 }), undefined);
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
    assert.match(src, /entity: TtlWindowZ, fact: TtlWindowZ, edge: TtlWindowZ, chrono: TtlWindowZ, file: TtlWindowZ/,
      'all five buckets must be accepted');
    assert.match(src, /recordTtlDays needs at least one of/,
      'an empty object must be refused: it would make "clear everything" and "change nothing" one request');
  });

  // The three source-text pins that stood here (the planner's `normaliseRecordTtl(...)` call, `updateSpace` not re-deciding the shape, and the
  // exact destructure that keeps the raw body out of the spread) are replaced by `describe('applySpaceMetaUpdate stores ...')` below, which
  // drives the write itself: the rule is what is STORED, not how a file spells it (Q-507). The text pin went red on a harmless respelling and
  // stayed green when the spread was broken some other way.

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

/**
 * The write itself, through `planSpaceMetaUpdate` and `applySpaceMetaUpdate` on a real config (Q-507): what the space STORES after a write is the
 * rule, whatever the code that gets it there is spelled like.
 *
 * Both of the defects the UI run found live between the plan and the store: the raw body's `recordTtlDays` reaching `updateSpace` a second time
 * through the generic spread (a partial write cleared the four buckets it did not name; an all-cleared write stored five nulls), and a write that
 * did not read what was stored. The plain branch (a space in no network) and the networked branch (a meta change that opens a round, where the TTL
 * is a LOCAL setting applied from the plan and never voted) both have to store the merged window; the other fields of the same PATCH ride along in
 * the plain branch's spread and must not carry the raw TTL with them.
 */
describe('applySpaceMetaUpdate stores the merged window, never the raw body', () => {
  const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
  const MEMBER = (n) => ({ instanceId: `aaaaaaaa-0000-4000-8000-0000000000a${n}`, label: `m${n}`, url: `https://m${n}.example.com`, tokenHash: 'h', direction: 'both' });
  let loader, plan, apply;

  before(async () => {
    loader = await bootInstance(dir, {
      instanceId: SELF,
      spaces: [
        { id: 'general', label: 'General', builtIn: true, folders: [] },
        { id: 'plain', label: 'Plain', folders: [] },
        { id: 'shared', label: 'Shared', folders: [] },
      ],
      networks: [{
        id: 'net-ttl', label: 'Net', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['shared'], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', members: [MEMBER(1), MEMBER(2)], pendingRounds: [],
      }],
    });
    ({ planSpaceMetaUpdate: plan, applySpaceMetaUpdate: apply } = await import('../../server/dist/spaces/meta-update.js'));
  });
  after(async () => {
    await loader?.flushConfig();
    removeInstanceDir(dir);
  });

  /** Store `stored` as the space's window, PATCH `body`, and answer what the config holds for it afterwards (and the outcome). */
  async function patch(spaceId, stored, body) {
    const space = loader.getConfig().spaces.find(s => s.id === spaceId);
    assert.ok(space, `fixture: no space ${spaceId}`);
    if (stored === undefined) delete space.recordTtlDays; else space.recordTtlDays = structuredClone(stored);
    const decision = plan({ spaceId, space, body, ifMatch: undefined });
    assert.equal(decision.ok, true, `the planner refused ${JSON.stringify(body)}: ${JSON.stringify(decision.refusal)}`);
    const outcome = await apply(decision.plan);
    const after = loader.getConfig().spaces.find(s => s.id === spaceId);
    return { outcome, stored: after.recordTtlDays, has: 'recordTtlDays' in after, label: after.label };
  }

  for (const [branch, spaceId] of [['plain space', 'plain'], ['networked space', 'shared']]) {
    // The networked branch is reached by a body that also carries a meta change (the round is opened for that); the window rides in the same body.
    const withMeta = (b) => (spaceId === 'shared' ? { ...b, meta: { purpose: 'a purpose the network votes on' } } : b);
    const expectOutcome = (o) => assert.ok(spaceId === 'shared' ? ['vote_pending', 'applied'].includes(o.outcome) : o.outcome === 'applied', `${branch}: outcome ${o.outcome}`);

    describe(branch, () => {
      it('a partial object over stored buckets keeps the buckets it does not name', async () => {
        const r = await patch(spaceId, { entity: 365, chrono: 90 }, withMeta({ recordTtlDays: { chrono: 30 } }));
        expectOutcome(r.outcome);
        assert.deepEqual(r.stored, { entity: 365, chrono: 30 }, 'a partial write must merge over what was stored');
      });

      it('a partial object over a stored scalar keeps the other four on that number', async () => {
        const r = await patch(spaceId, 90, withMeta({ recordTtlDays: { chrono: 30 } }));
        expectOutcome(r.outcome);
        assert.deepEqual(r.stored, { entity: 90, fact: 90, edge: 90, chrono: 30, file: 90 });
      });

      it('an all-cleared write stores nothing: the key is gone, not five nulls', async () => {
        const r = await patch(spaceId, { chrono: 90 }, withMeta({ recordTtlDays: { chrono: null } }));
        expectOutcome(r.outcome);
        assert.equal(r.stored, undefined, 'one representation of "no retention"');
      });

      it('a per-bucket clear removes just that bucket', async () => {
        const r = await patch(spaceId, ALL5, withMeta({ recordTtlDays: { file: null } }));
        expectOutcome(r.outcome);
        assert.deepEqual(r.stored, { entity: 90, fact: 90, edge: 90, chrono: 90 });
      });

      it('a bare number replaces the whole window', async () => {
        const r = await patch(spaceId, { chrono: 30 }, withMeta({ recordTtlDays: 365 }));
        expectOutcome(r.outcome);
        assert.equal(r.stored, 365);
      });

      it('a write that does not mention the window leaves it as stored', async () => {
        const r = await patch(spaceId, { entity: 365, chrono: 90 }, withMeta({ label: 'Renamed' }));
        expectOutcome(r.outcome);
        assert.deepEqual(r.stored, { entity: 365, chrono: 90 }, 'a label edit must not touch the window');
        assert.equal(r.label, 'Renamed', 'fixture check: the other field of the same PATCH was applied');
      });

      it('the window rides beside other fields of the same PATCH without the raw body overwriting it', async () => {
        const r = await patch(spaceId, { entity: 365, chrono: 90 }, withMeta({ label: 'Both', recordTtlDays: { chrono: 7 } }));
        expectOutcome(r.outcome);
        assert.deepEqual(r.stored, { entity: 365, chrono: 7 }, 'the generic spread of the other fields must not write the raw recordTtlDays over the merged one');
        assert.equal(r.label, 'Both');
      });
    });
  }

  it('the store keeps exactly what it is handed: `updateSpace` does not re-decide the shape', async () => {
    const { updateSpace } = await import('../../server/dist/spaces/spaces.js');
    updateSpace('plain', { recordTtlDays: { chrono: 5 } });
    assert.deepEqual(loader.getConfig().spaces.find(s => s.id === 'plain').recordTtlDays, { chrono: 5 });
    updateSpace('plain', { recordTtlDays: 30 });
    assert.equal(loader.getConfig().spaces.find(s => s.id === 'plain').recordTtlDays, 30, 'a scalar is stored as a scalar');
    updateSpace('plain', { recordTtlDays: undefined });
    assert.equal(loader.getConfig().spaces.find(s => s.id === 'plain').recordTtlDays, undefined, 'an explicit clear removes it');
  });
});
