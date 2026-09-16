/**
 * F10 — record TTL compute helpers (write-side precedence).
 *
 * These are the pure rules that decide whether a write stamps/keeps/clears `_expireAt`, imported
 * straight from the real module. No config is loaded here, so the space-wide `recordTtlDays` default
 * resolves to "none" (getConfig() throws → helpers treat it as no default) — exactly the paths that
 * DON'T depend on config are covered deterministically here; the space-default path is covered by the
 * integration suite against a live space. See testing/integration/record-ttl.test.js.
 *
 * Run: node --test testing/standalone/ttl-expiry.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  expiryForCreate,
  stampExpiryOnCreate,
  applyExpiryToUpdate,
  TTL_COLLECTIONS,
} from '../../server/dist/brain/ttl.js';

const DAY_MS = 86_400_000;

/** Assert a Date lands within a few seconds of now + `days`, absorbing test-run wall time. */
function assertAboutDaysFromNow(d, days) {
  assert.ok(d instanceof Date, `expected a Date, got ${d}`);
  const expected = Date.now() + days * DAY_MS;
  assert.ok(Math.abs(d.getTime() - expected) < 5_000, `expected ~${days}d out, got ${d.toISOString()}`);
}

describe('expiryForCreate — per-record ttlDays precedence', () => {
  it('ttlDays > 0 stamps now + ttlDays', () => {
    assertAboutDaysFromNow(expiryForCreate('no-such-space', 30), 30);
  });

  it('ttlDays = 1 (minimum) is honoured', () => {
    assertAboutDaysFromNow(expiryForCreate('no-such-space', 1), 1);
  });

  it('ttlDays = 0 means never expire (opts out of any space default)', () => {
    assert.equal(expiryForCreate('no-such-space', 0), undefined);
  });

  it('ttlDays = null means never expire', () => {
    assert.equal(expiryForCreate('no-such-space', null), undefined);
  });

  it('omitted ttlDays with no space default → no expiry', () => {
    assert.equal(expiryForCreate('no-such-space', undefined), undefined);
    assert.equal(expiryForCreate('no-such-space'), undefined);
  });
});

describe('stampExpiryOnCreate — mutates the doc in place', () => {
  it('sets _expireAt when ttlDays > 0', () => {
    const doc = {};
    stampExpiryOnCreate('no-such-space', doc, 7);
    assertAboutDaysFromNow(doc._expireAt, 7);
  });

  it('leaves the doc untouched when ttlDays = 0', () => {
    const doc = {};
    stampExpiryOnCreate('no-such-space', doc, 0);
    assert.ok(!('_expireAt' in doc));
  });

  it('leaves the doc untouched when ttlDays omitted and no space default', () => {
    const doc = {};
    stampExpiryOnCreate('no-such-space', doc);
    assert.ok(!('_expireAt' in doc));
  });
});

describe('applyExpiryToUpdate — $set/$unset precedence', () => {
  it('ttlDays > 0 sets a fresh expiry', () => {
    const $set = {}, $unset = {};
    applyExpiryToUpdate('no-such-space', 14, false, $set, $unset);
    assertAboutDaysFromNow($set._expireAt, 14);
    assert.ok(!('_expireAt' in $unset));
  });

  it('ttlDays = 0 clears an existing expiry', () => {
    const $set = {}, $unset = {};
    applyExpiryToUpdate('no-such-space', 0, true, $set, $unset);
    assert.equal($unset._expireAt, '');
    assert.ok(!('_expireAt' in $set));
  });

  it('ttlDays = null clears an existing expiry', () => {
    const $set = {}, $unset = {};
    applyExpiryToUpdate('no-such-space', null, true, $set, $unset);
    assert.equal($unset._expireAt, '');
  });

  it('omitted ttlDays does NOT re-slide an existing expiry', () => {
    const $set = {}, $unset = {};
    applyExpiryToUpdate('no-such-space', undefined, true, $set, $unset);
    assert.ok(!('_expireAt' in $set), 'must not touch _expireAt when one already exists');
    assert.ok(!('_expireAt' in $unset));
  });

  it('omitted ttlDays with no existing expiry and no space default → no change', () => {
    const $set = {}, $unset = {};
    applyExpiryToUpdate('no-such-space', undefined, false, $set, $unset);
    assert.ok(!('_expireAt' in $set));
    assert.ok(!('_expireAt' in $unset));
  });
});

describe('TTL_COLLECTIONS', () => {
  it('covers the five TTL-bearing collections (F12 added files)', () => {
    assert.deepEqual([...TTL_COLLECTIONS].sort(), ['chrono', 'edges', 'entities', 'facts', 'files']);
  });
});
