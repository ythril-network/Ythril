/**
 * Who may create a space, and what the creator is given — both as truth tables (`Q-134`).
 *
 * One predicate answers "may this token create spaces" for every door (REST, MCP, a join, an adoption); one grant
 * gives the creator admin of what it created. Each is exercised over its whole table rather than its happy path,
 * because the defect this replaces was one door reading the right and two reading instance admin instead.
 *
 * Run: node --test testing/standalone/who-may-create-a-space-and-what-the-creator-gets.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const optional = async (p) => { try { return await import(p); } catch { return {}; } };
const create = await optional('../../server/dist/auth/create-spaces.js');
const grant = await optional('../../server/dist/auth/creator-grant.js');
const fn = (mod, name) => {
  assert.equal(typeof mod[name], 'function', `${name} does not exist — the rule it carries has no home`);
  return mod[name];
};
const matrix = (over) => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, ...over });

describe('may this token create spaces', () => {
  it('instance admin may; createSpaces may; neither may not; no rights may not', () => {
    const may = fn(create, 'mayCreateSpaces');
    assert.equal(may({ rights: matrix({ instanceAdmin: true }) }), true);
    assert.equal(may({ rights: matrix({ createSpaces: true }) }), true);
    assert.equal(may({ rights: matrix({}) }), false);
    assert.equal(may({ rights: null }), false);
    assert.equal(may(undefined), false);
  });

  it('a space administrator is not thereby a creator', () => {
    const may = fn(create, 'mayCreateSpaces');
    assert.equal(may({ rights: matrix({ spaceAdmin: { floor: true, spaces: [] } }) }), false,
      'administering every space is not the right to create one');
  });

  it('the refusal is one sentence that names the right, and null when allowed', () => {
    const refusal = fn(create, 'createSpacesRefusal');
    assert.equal(refusal({ rights: matrix({ createSpaces: true }) }), null);
    const s = refusal({ rights: matrix({}) });
    assert.equal(typeof s, 'string');
    assert.match(s, /createSpaces/);
  });
});

describe('what the creator is given', () => {
  const cfgWith = (rights) => ({ tokens: [{ id: 't1', rights }] });

  it('a stored token that does not administer the space gains it, and nothing else', () => {
    const g = fn(grant, 'grantCreatorAdmin');
    const cfg = cfgWith(matrix({ createSpaces: true, perSpace: { other: { knowledge: 'read' } } }));
    assert.equal(g(cfg, 't1', 'fresh'), 'granted');
    const r = cfg.tokens[0].rights;
    assert.deepEqual(r.spaceAdmin, { floor: false, spaces: ['fresh'] });
    assert.equal(r.instanceAdmin, false);
    assert.deepEqual(r.perSpace, { other: { knowledge: 'read' } }, 'the grant rewrote an unrelated row');
  });

  it('keeps what it already administered, and never widens the floor', () => {
    const g = fn(grant, 'grantCreatorAdmin');
    const cfg = cfgWith(matrix({ createSpaces: true, spaceAdmin: { floor: false, spaces: ['a'] } }));
    assert.equal(g(cfg, 't1', 'b'), 'granted');
    assert.deepEqual(cfg.tokens[0].rights.spaceAdmin, { floor: false, spaces: ['a', 'b'] });
  });

  it('a token that already administers the space is left alone', () => {
    const g = fn(grant, 'grantCreatorAdmin');
    const byName = cfgWith(matrix({ spaceAdmin: { floor: false, spaces: ['x'] } }));
    assert.equal(g(byName, 't1', 'x'), 'already');
    assert.deepEqual(byName.tokens[0].rights.spaceAdmin.spaces, ['x'], 'a second copy of the name was added');
    const byFloor = cfgWith(matrix({ instanceAdmin: true, spaceAdmin: { floor: true, spaces: [] } }));
    assert.equal(g(byFloor, 't1', 'x'), 'already');
    assert.deepEqual(byFloor.tokens[0].rights.spaceAdmin, { floor: true, spaces: [] });
  });

  it('a creator with no stored record (an OIDC session) and no creator at all are values, not failures', () => {
    const g = fn(grant, 'grantCreatorAdmin');
    assert.equal(g(cfgWith(matrix({})), 'not-a-stored-token', 'x'), 'not-stored');
    assert.equal(g(cfgWith(matrix({})), null, 'x'), 'no-creator');
  });
});
