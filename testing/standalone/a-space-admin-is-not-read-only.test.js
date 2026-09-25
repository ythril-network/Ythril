/**
 * A token granted only space administration is not read-only.
 *
 * 5.0 made `spaceAdmin` a grant of its own: a token can hold it with an empty `perSpace` and no floor, and it then
 * holds `admin` in every data area of those spaces by resolution. `canWriteAnywhere` — what `denyReadOnly` asks —
 * counted write rungs in the floor and in `perSpace` and never read the grant, so such a token was refused as
 * "read-only" by every route carrying `denyReadOnly`. Found building F-37, where every act a space admin was
 * newly allowed answered 403 before its own check ran.
 *
 * Run: node --test testing/standalone/a-space-admin-is-not-read-only.test.js  (requires a prior server build)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let canWriteAnywhere;
before(async () => { ({ canWriteAnywhere } = await import('../../server/dist/auth/write-anywhere.js')); });

const base = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: {} };

describe('canWriteAnywhere and space administration', () => {
  it('a token administering named spaces can write', () => {
    assert.equal(canWriteAnywhere({ ...base, spaceAdmin: { floor: false, spaces: ['qa'] } }), true);
  });
  it('a token administering every space can write', () => {
    assert.equal(canWriteAnywhere({ ...base, spaceAdmin: { floor: true, spaces: [] } }), true);
  });
  it('an empty grant is still read-only, and so is no grant', () => {
    assert.equal(canWriteAnywhere({ ...base, spaceAdmin: { floor: false, spaces: [] } }), false);
    assert.equal(canWriteAnywhere(base), false);
  });
});
