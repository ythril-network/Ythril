/**
 * A rights matrix stored in a shape the API refuses is repaired at boot — and the repair never grants more.
 *
 * ## The report this exists for
 *
 * Owner, 2026-08-15, editing a token: the PATCH came back with ~40 zod errors, the same two repeated for the
 * floor and for every space — `unrecognized_keys ["admin"]` and an invalid `dataQuality`. Every stored rungs
 * object was `{ knowledge, files, schema, admin }`. The editor round-trips what it READ, so the shape was on
 * disk, and the token could be opened and never saved: a matrix visible and permanently uneditable.
 *
 * `backfillTokenRights` skipped it at every boot because it tests `if (t.rights)` — presence, never shape. So
 * the migration ran, looked, saw an object and moved on, which is why it read as "the migration didn't work".
 *
 * ## What is asserted, and why it is these things
 *
 * The repair must be a NARROWING. A missing area becomes `none`, an unreadable rung becomes `none`, and a key
 * that is not an area is dropped — all three are what the enforcement code already does with them, so no
 * decision changes anywhere. The alternative (re-deriving from the legacy fields) is the widening this file
 * guards against: a legacy `admin` token whose matrix an operator had deliberately narrowed would silently get
 * `admin` on everything back at boot.
 *
 * Idempotence is asserted for the same reason as in `token-rights-backfill.test.js`: this runs on every load,
 * so a second pass reporting work would mean it is rewriting healthy records.
 *
 * Run: node --test testing/standalone/malformed-rights-are-repaired.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let repairRights, repairTokenRights, migrateTokenRightsOnBoot;
before(async () => {
  ({ repairRights } = await import('../../server/dist/config/rights-shape.js'));
  ({ repairTokenRights, migrateTokenRightsOnBoot } =
    await import('../../server/dist/auth/backfill-token-rights.js'));
});

const tok = (over) => ({ id: 'i', name: 'n', hash: 'h', prefix: 'p', createdAt: '', lastUsed: null, expiresAt: null, admin: false, ...over });
const ALL = (r) => ({ knowledge: r, files: r, schema: r, dataQuality: r, networks: r });
/** The exact shape the owner reported: three areas plus a key that is not an area. */
const REPORTED = (r) => ({ knowledge: r, files: r, schema: r, admin: r });

describe('repairRights — the normalizer', () => {
  it('leaves a well-formed matrix alone, and says nothing changed', () => {
    const good = { instanceAdmin: false, createSpaces: false, floor: ALL('write'), perSpace: { qa: ALL('read') } };
    const out = repairRights(good);
    assert.equal(out.changed, false, 'a healthy matrix must not be rewritten at every boot');
    assert.deepEqual(out.rights, good);
  });

  it('drops a key that is not an area and fills the area that is missing', () => {
    const out = repairRights({ instanceAdmin: false, createSpaces: false, floor: REPORTED('admin'), perSpace: {} });
    assert.equal(out.changed, true);
    assert.deepEqual(Object.keys(out.rights.floor), ['knowledge', 'files', 'schema', 'dataQuality', 'networks']);
    assert.equal(out.rights.floor.dataQuality, 'none', 'the absent area must come back at the LOWEST rung');
    assert.equal('admin' in out.rights.floor, false, '`admin` is not an area and must not survive');
  });

  it('repairs every perSpace row, not only the floor', () => {
    // set-claim: two fixture space ids, so the repair is seen to reach more than the first row.
    // The report showed the same two errors for the floor AND for every space, so a repair that fixed one of
    // them would leave the save refused and look like it had worked.
    const out = repairRights({
      instanceAdmin: false, createSpaces: false, floor: null,
      perSpace: { a: REPORTED('write'), b: REPORTED('read') },
    });
    for (const id of ['a', 'b']) {
      assert.equal(out.rights.perSpace[id].dataQuality, 'none');
      assert.equal('admin' in out.rights.perSpace[id], false);
    }
  });

  it('KEEPS every rung it can read — the repair is not a reset', () => {
    const out = repairRights({
      instanceAdmin: true, createSpaces: true,
      floor: { knowledge: 'admin', files: 'write', schema: 'read', admin: 'admin' },
      perSpace: { qa: { knowledge: 'write', admin: 'admin' } },
    });
    assert.deepEqual(out.rights.floor, { knowledge: 'admin', files: 'write', schema: 'read', dataQuality: 'none', networks: 'none' });
    assert.equal(out.rights.perSpace.qa.knowledge, 'write');
    assert.equal(out.rights.instanceAdmin, true, 'the instance flags are not areas and must survive');
    assert.equal(out.rights.createSpaces, true);
  });

  it('an unreadable rung becomes none rather than being kept or throwing', () => {
    const out = repairRights({ instanceAdmin: false, createSpaces: false, floor: { knowledge: 'ADMIN', files: 7, schema: null, dataQuality: 'read' }, perSpace: {} });
    assert.deepEqual(out.rights.floor, { knowledge: 'none', files: 'none', schema: 'none', dataQuality: 'read', networks: 'none' });
  });

  it('never invents a floor where there was none', () => {
    // A floor reaches every space including ones created later. Turning an absent floor into rungs would be the
    // single widest widening available.
    const out = repairRights({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: { qa: ALL('read') } });
    assert.equal(out.rights.floor, null);
    assert.equal(out.changed, false);
  });

  it('is idempotent — repairing a repair reports nothing', () => {
    const once = repairRights({ instanceAdmin: false, createSpaces: false, floor: REPORTED('write'), perSpace: { qa: REPORTED('read') } });
    const twice = repairRights(once.rights);
    assert.equal(twice.changed, false);
    assert.deepEqual(twice.rights, once.rights);
  });

  it('returns null for a value that is not an object at all', () => {
    for (const v of [null, undefined, 'admin', 42, ['knowledge']]) {
      assert.equal(repairRights(v), null, `${JSON.stringify(v)} has nothing to preserve`);
    }
  });
});

describe('repairTokenRights — the pass over the config', () => {
  it('repairs the reported shape and reports the count', () => {
    const cfg = { tokens: [
      tok({ id: 'a', rights: { instanceAdmin: false, createSpaces: false, floor: REPORTED('write'), perSpace: {} } }),
      tok({ id: 'b', rights: { instanceAdmin: false, createSpaces: false, floor: ALL('read'), perSpace: {} } }),
    ] };
    assert.equal(repairTokenRights(cfg), 1, 'only the malformed one counts');
    assert.equal(cfg.tokens[0].rights.floor.dataQuality, 'none');
    assert.equal(cfg.tokens[1].rights.floor.knowledge, 'read', 'the healthy token was touched');
  });

  it('does NOT re-derive from the legacy fields — that would widen', () => {
    // The token is a legacy admin whose matrix somebody narrowed to read on one space. Re-deriving would hand
    // it an `admin` floor over the whole instance, silently, at boot.
    const cfg = { tokens: [tok({ id: 'a', admin: true, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { qa: REPORTED('read') } } })] };
    repairTokenRights(cfg);
    assert.equal(cfg.tokens[0].rights.floor, null, 'a floor appeared where the stored matrix had none');
    assert.deepEqual(Object.keys(cfg.tokens[0].rights.perSpace), ['qa']);
    assert.equal(cfg.tokens[0].rights.perSpace.qa.knowledge, 'read');
  });

  it('leaves a token with NO rights to the backfill', () => {
    const cfg = { tokens: [tok({ id: 'a' })] };
    assert.equal(repairTokenRights(cfg), 0, 'two functions writing the same field would fight');
    assert.equal(cfg.tokens[0].rights, undefined);
  });

  it('re-derives when `rights` is not an object, because there is nothing to preserve', () => {
    const cfg = { tokens: [tok({ id: 'a', readOnly: true, rights: 'admin' })] };
    assert.equal(repairTokenRights(cfg), 1);
    assert.equal(cfg.tokens[0].rights.floor.knowledge, 'read', 'derived from readOnly, as the migration does');
  });

  it('is idempotent, and safe on an absent token list', () => {
    const cfg = { tokens: [tok({ id: 'a', rights: { instanceAdmin: false, createSpaces: false, floor: REPORTED('write'), perSpace: {} } })] };
    assert.equal(repairTokenRights(cfg), 1);
    assert.equal(repairTokenRights(cfg), 0, 'a second pass rewrote a record it had just fixed');
    assert.equal(repairTokenRights({}), 0);
  });
});

/*
 * ── ASSERTED ON THE EFFECT, NOT ON A SAVE CALL ──────────────────────────────────────────────────
 *
 * These two counted calls to an injected save function. That parameter is gone: the step is in-memory
 * only by design — `loadConfig` says so with its reason — and an injectable save was a save path with
 * the safety catch off, reversible at any call site. It only ever ran in tests, because the production
 * default reached for `require()` in an ESM package and threw on every boot.
 *
 * The SUBJECT is unchanged and is still worth pinning: a repair must happen even when nothing was
 * filled. The original bug was `if (filled === 0) return 0;` short-circuiting before the repair was
 * kept. What changed is the observable — the returned count and the mutated config, which is the repair
 * itself, rather than a write that was a proxy for it.
 *
 * That is the stronger assertion anyway: a save call proves something was handed to a function, while
 * `dataQuality === 'none'` proves the malformed matrix was actually repaired.
 */
describe('the boot step repairs even when nothing was filled', () => {
  it('a repair alone still counts, and still lands on the config', () => {
    const cfg = { tokens: [tok({ id: 'a', rights: { instanceAdmin: false, createSpaces: false, floor: REPORTED('write'), perSpace: {} } })] };
    assert.equal(migrateTokenRightsOnBoot(cfg), 1,
      'a repair with nothing filled reports no work — `if (filled === 0) return 0;` is back');
    assert.equal(cfg.tokens[0].rights.floor.dataQuality, 'none',
      'the malformed area was not repaired, so the step counted work it did not do');
  });

  it('and reports nothing when every token is already well-formed', () => {
    const cfg = { tokens: [tok({ id: 'a', rights: { instanceAdmin: false, createSpaces: false, floor: ALL('read'), perSpace: {} } })] };
    const before = JSON.stringify(cfg);
    assert.equal(migrateTokenRightsOnBoot(cfg), 0, 'a healthy config was reported as changed');
    assert.equal(JSON.stringify(cfg), before, 'a healthy config was mutated at boot');
  });
});
