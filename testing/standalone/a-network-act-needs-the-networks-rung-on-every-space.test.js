/**
 * The Networks column (`F-34`): a token acts on a network through `networks` rungs on the spaces it carries.
 *
 * Owner decision 2026-08-09, confirmed 2026-09-24 (A): a token at `networks: write` may create a network with a
 * space and leave a membership it established; leaving one another token established needs `networks: admin`.
 * Before, every network route was instance-admin, so nobody below it could do either.
 *
 * **A network carries SEVERAL spaces, so an act on it needs the rung on EVERY one.** A network is only as
 * permitted as its least-permitted space: holding the rung on two of three would let a token move the third into
 * a network it was never allowed to share. The refusal names each space that is short.
 *
 * **Nothing widens.** A matrix stored before the column existed gains `networks: none`; a legacy token maps to
 * `none` below admin, because networks were instance-admin only. Instance admin passes, as it always did.
 *
 * Run: node --test testing/standalone/a-network-act-needs-the-networks-rung-on-every-space.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let networkCreateRefusal, networkLeaveRefusal, repairRights, migrateToken;
before(async () => {
  ({ networkCreateRefusal, networkLeaveRefusal } = await import('../../server/dist/auth/network-rights.js'));
  ({ repairRights } = await import('../../server/dist/config/rights-shape.js'));
  ({ migrateToken } = await import('../../server/dist/auth/rights-migration.js'));
});

const areas = (networks) => ({ knowledge: 'write', files: 'write', schema: 'read', dataQuality: 'read', networks });
const token = (perSpace, over = {}) => ({ id: 't1', rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace, ...over } });

describe('creating a network with spaces', () => {
  it('needs networks: write on every space it carries, and names each one short', () => {
    const t = token({ qa: areas('write'), ops: areas('read'), hr: areas('none') });
    assert.equal(networkCreateRefusal(t, ['qa']), null);
    const refusal = networkCreateRefusal(t, ['qa', 'ops', 'hr']);
    assert.match(refusal, /ops/);
    assert.match(refusal, /hr/);
    assert.doesNotMatch(refusal, /\bqa\b/);
  });
  it('an instance admin passes, as it always did', () => {
    assert.equal(networkCreateRefusal({ id: 'a', rights: { instanceAdmin: true, createSpaces: true, floor: null, perSpace: {} } }, ['qa', 'ops']), null);
  });
  it('a token with no rights matrix reaches nothing', () => {
    assert.match(networkCreateRefusal({ id: 'x' }, ['qa']), /qa/);
  });
});

describe('leaving a network', () => {
  const net = (origins) => ({ spaces: ['qa', 'ops'], spaceOrigins: origins });
  it('its own memberships, at write', () => {
    const t = token({ qa: areas('write'), ops: areas('write') });
    assert.equal(networkLeaveRefusal(t, net({ qa: 't1', ops: 't1' })), null);
  });
  it('one space somebody else established is refused, and named with why', () => {
    const t = token({ qa: areas('write'), ops: areas('write') });
    const refusal = networkLeaveRefusal(t, net({ qa: 't1', ops: 't2' }));
    assert.match(refusal, /ops/);
    assert.match(refusal, /another token/);
  });
  it('an unknown establisher fails closed below admin, and admin passes it', () => {
    assert.match(networkLeaveRefusal(token({ qa: areas('write'), ops: areas('write') }), net(undefined)), /unknown|established/);
    assert.equal(networkLeaveRefusal(token({ qa: areas('admin'), ops: areas('admin') }), net(undefined)), null);
  });
  it('an instance admin passes', () => {
    assert.equal(networkLeaveRefusal({ id: 'a', rights: { instanceAdmin: true, createSpaces: true, floor: null, perSpace: {} } }, net(undefined)), null);
  });
});

describe('nothing widens when the column arrives', () => {
  it('a stored matrix without the column gains networks: none, and is reported as repaired', () => {
    const r = repairRights({ instanceAdmin: false, createSpaces: false, floor: { knowledge: 'admin', files: 'admin', schema: 'admin', dataQuality: 'admin' }, perSpace: {} });
    assert.equal(r.rights.floor.networks, 'none');
    assert.equal(r.changed, true);
  });
  it('a legacy token below admin maps to networks: none; a legacy admin to admin', () => {
    assert.equal(migrateToken({}).floor.networks, 'none', 'a legacy write token gains no network rights');
    assert.equal(migrateToken({ readOnly: true }).floor.networks, 'none');
    assert.equal(migrateToken({ admin: true }).floor.networks, 'admin', 'networks were an admin capability');
    assert.equal(migrateToken({}).floor.knowledge, 'write', 'the data areas map as they always did');
  });
});

describe('seeing a network, and changing its settings', () => {
  let visibleNetworks, networkSettingsRefusal;
  before(async () => { ({ visibleNetworks, networkSettingsRefusal } = await import('../../server/dist/auth/network-rights.js')); });
  const nets = [{ id: 'n1', spaces: ['qa'] }, { id: 'n2', spaces: ['qa', 'ops'] }, { id: 'n3', spaces: ['hr'] }];

  it('a network is visible only with networks: read on EVERY space it carries', () => {
    const t = token({ qa: areas('read'), ops: areas('none'), hr: areas('none') });
    assert.deepEqual(visibleNetworks(t, nets).map(n => n.id), ['n1']);
  });
  it('an instance admin sees them all; a token with no matrix sees none', () => {
    assert.equal(visibleNetworks({ id: 'a', rights: { instanceAdmin: true, createSpaces: true, floor: null, perSpace: {} } }, nets).length, 3);
    assert.equal(visibleNetworks({ id: 'x' }, nets).length, 0);
  });
  it('settings need networks: admin on every space — write is not enough', () => {
    assert.match(networkSettingsRefusal(token({ qa: areas('write'), ops: areas('admin') }), nets[1]), /admin/);
    assert.equal(networkSettingsRefusal(token({ qa: areas('admin'), ops: areas('admin') }), nets[1]), null);
  });
});

describe('joining a remote network (F-34.1)', () => {
  let networkJoinRefusal;
  before(async () => { ({ networkJoinRefusal } = await import('../../server/dist/auth/network-rights.js')); });

  it('write on every EXISTING space it maps to joins', () => {
    assert.equal(networkJoinRefusal(token({ qa: areas('write') }), { existing: ['qa'], toCreate: [] }), null);
  });
  it('an existing space short is refused, named', () => {
    assert.match(networkJoinRefusal(token({ qa: areas('write'), ops: areas('read') }), { existing: ['qa', 'ops'], toCreate: [] }), /ops/);
  });
  it('a space the join would CREATE needs createSpaces and a floor of networks: write — it has no row yet', () => {
    const rowOnly = token({ qa: areas('write') });
    assert.match(networkJoinRefusal(rowOnly, { existing: [], toCreate: ['new-one'] }), /new-one/);
    const floorNoCreate = token({}, { floor: areas('write') });
    assert.match(networkJoinRefusal(floorNoCreate, { existing: [], toCreate: ['new-one'] }), /createSpaces|create/);
    const both = token({}, { floor: areas('write'), createSpaces: true });
    assert.equal(networkJoinRefusal(both, { existing: [], toCreate: ['new-one'] }), null);
  });
  it('an instance admin passes', () => {
    assert.equal(networkJoinRefusal({ id: 'a', rights: { instanceAdmin: true, createSpaces: true, floor: null, perSpace: {} } }, { existing: ['x'], toCreate: ['y'] }), null);
  });
});

/*
 * F-37 — a space admin creates and joins networks with the spaces it administers (owner 2026-09-25): "Space admin
 * may create networks for his space and join network mapped onto his space; or a new space if he also has can
 * create space" — plural when it administers several. Nothing else on the router widens.
 */
describe('a space admin and its own spaces (F-37)', () => {
  let networkJoinRefusal, networkInviteRefusal;
  before(async () => { ({ networkJoinRefusal, networkInviteRefusal } = await import('../../server/dist/auth/network-rights.js')); });
  const admins = (spaces, over = {}) => token({}, { spaceAdmin: { floor: false, spaces }, ...over });

  it('creates a network carrying any number of the spaces it administers, with no Networks column', () => {
    assert.equal(networkCreateRefusal(admins(['qa', 'ops']), ['qa', 'ops']), null);
  });
  it('is refused a network carrying a space it does not administer, and that space is named', () => {
    const refusal = networkCreateRefusal(admins(['qa']), ['qa', 'hr']);
    assert.match(refusal, /\bhr\b/);
    assert.doesNotMatch(refusal, /\bqa\b/);
  });
  it('joins a network mapped onto several spaces it administers', () => {
    assert.equal(networkJoinRefusal(admins(['qa', 'ops']), { existing: ['qa', 'ops'], toCreate: [] }), null);
  });
  it('is refused a join mapped onto a space it does not administer, named', () => {
    assert.match(networkJoinRefusal(admins(['qa']), { existing: ['qa', 'hr'], toCreate: [] }), /\bhr\b/);
  });
  it('joins onto a NEW space only when it may also create spaces', () => {
    assert.equal(networkJoinRefusal(admins(['qa'], { createSpaces: true }), { existing: ['qa'], toCreate: ['fresh'] }), null);
    assert.match(networkJoinRefusal(admins(['qa']), { existing: ['qa'], toCreate: ['fresh'] }), /create/);
  });
  it('generates the invite for a network carrying only spaces it administers', () => {
    assert.equal(networkInviteRefusal(admins(['qa', 'ops']), { spaces: ['qa', 'ops'] }), null);
    assert.match(networkInviteRefusal(admins(['qa']), { spaces: ['qa', 'ops'] }), /\bops\b/);
  });
  it('sees a network carrying only spaces it administers, and not one carrying any other', async () => {
    const { visibleNetworks } = await import('../../server/dist/auth/network-rights.js');
    const nets = [{ id: 'mine', spaces: ['qa', 'ops'] }, { id: 'mixed', spaces: ['qa', 'hr'] }];
    assert.deepEqual(visibleNetworks(admins(['qa', 'ops']), nets).map(n => n.id), ['mine']);
  });
  it('invites otherwise stay instance-admin: the Networks column alone does not generate one', () => {
    assert.match(networkInviteRefusal(token({ qa: areas('admin') }), { spaces: ['qa'] }), /qa/);
    assert.equal(networkInviteRefusal({ id: 'a', rights: { instanceAdmin: true, createSpaces: true, floor: null, perSpace: {} } }, { spaces: ['qa'] }), null);
  });
});

/*
 * Q-603 — a network that carries NO space is the instance admin's alone. "The rung on EVERY space it carries" is false of
 * an empty list for everyone but the instance admin: `[].every(...)` is true, and a rung held on spaces is not one held on
 * a network that has none. `takeSpaceOutOfNetwork` leaves such a network in config when its last space goes, and until
 * now any token with a matrix could read it, change its settings, attach a space to it and leave it (which tells every
 * member and can revoke a peer's credentials). One list, five acts, and every one of them is asked here.
 */
describe('a network that carries no space is the instance admin\'s alone (Q-603)', () => {
  const ADMIN = { id: 'a', rights: { instanceAdmin: true, createSpaces: true, floor: null, perSpace: {} } };
  const EMPTY = { id: 'emptied', spaces: [], spaceOrigins: {} };
  // Every caller shape that holds rungs: a high rung on its own spaces, the floor at admin, a space admin, and a floor-only token.
  const CALLERS = {
    'a token at networks admin on a space': token({ qa: areas('admin') }),
    'a token with networks admin on the floor': token({}, { floor: areas('admin') }),
    'a space admin': token({}, { spaceAdmin: { floor: false, spaces: ['qa'] } }),
    'a space admin of the floor': token({}, { spaceAdmin: { floor: true, spaces: [] } }),
  };
  let mod;
  before(async () => { mod = await import('../../server/dist/auth/network-rights.js'); });

  for (const [who, caller] of Object.entries(CALLERS)) {
    describe(who, () => {
      it('does not see it', () => {
        assert.deepEqual(mod.visibleNetworks(caller, [EMPTY, { id: 'real', spaces: ['qa'] }]).map(n => n.id).filter(id => id === 'emptied'), [],
          'an emptied network was listed to a token that is not the instance admin');
      });
      it('may not change its settings', () => {
        assert.equal(typeof mod.networkSettingsRefusal(caller, EMPTY), 'string', 'networkSettingsRefusal returned null for a network with no spaces');
      });
      it('may not leave it', () => {
        assert.equal(typeof mod.networkLeaveRefusal(caller, EMPTY), 'string', 'networkLeaveRefusal returned null for a network with no spaces');
      });
      it('may not add a space to it', () => {
        assert.equal(typeof mod.networkAddSpaceRefusal(caller, EMPTY, 'qa'), 'string', 'networkAddSpaceRefusal returned null for a network with no spaces');
      });
      it('may not invite into it (a control: this refusal already holds)', () => {
        assert.equal(typeof mod.networkInviteRefusal(caller, EMPTY), 'string');
      });
    });
  }

  it('the instance admin still sees it, changes it, leaves it and adds to it', () => {
    assert.deepEqual(mod.visibleNetworks(ADMIN, [EMPTY]).map(n => n.id), ['emptied']);
    assert.equal(mod.networkSettingsRefusal(ADMIN, EMPTY), null);
    assert.equal(mod.networkLeaveRefusal(ADMIN, EMPTY), null);
    assert.equal(mod.networkAddSpaceRefusal(ADMIN, EMPTY, 'qa'), null);
  });

  it('a token with no matrix reaches nothing, as before (a control)', () => {
    assert.deepEqual(mod.visibleNetworks({ id: 'x' }, [EMPTY]), []);
  });

  it('a join that would leave the network with no spaces is refused to a token that is not the instance admin', () => {
    // The remote's own list is what is judged: a join onto a network the remote shares no space of has nothing for a rung to be held on.
    const caller = token({ qa: areas('admin') }, { createSpaces: true, floor: areas('admin') });
    assert.equal(typeof mod.networkJoinRefusal(caller, { existing: [], toCreate: [] }), 'string',
      'networkJoinRefusal returned null for a join that carries no space');
    assert.equal(mod.networkJoinRefusal(ADMIN, { existing: [], toCreate: [] }), null, 'the instance admin may');
  });
});

describe('administersEvery: administering is held on EVERY space, and an empty list is not every space (Q-603)', () => {
  let reachable;
  before(async () => { reachable = await import('../../server/dist/auth/reachable-spaces.js'); });
  const adminOf = (...ids) => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, spaceAdmin: { floor: false, spaces: ids } });

  it('is exported beside holdsRungOnEvery', () => {
    assert.equal(typeof reachable.administersEvery, 'function',
      'module server/dist/auth/reachable-spaces.js does not export administersEvery: the implementation creates it');
  });
  it('is false on an empty list, true when every space is administered, false when one is short, false with no rights', () => {
    assert.equal(typeof reachable.administersEvery, 'function', 'administersEvery does not exist yet');
    assert.equal(reachable.administersEvery(adminOf('qa'), []), false, 'an empty list is every space of nothing: it must not answer yes');
    assert.equal(reachable.administersEvery(adminOf('qa', 'ops'), ['qa', 'ops']), true);
    assert.equal(reachable.administersEvery(adminOf('qa'), ['qa', 'ops']), false);
    assert.equal(reachable.administersEvery(undefined, ['qa']), false);
    assert.equal(reachable.holdsRungOnEvery(adminOf('qa'), [], 'networks', 'read'), false, 'the sibling the new one sits beside');
  });
});

describe('network-rights.ts holds no hand copy of "every space" (Q-603)', () => {
  it('no `.every(` over a network\'s spaces and no empty-list branch: holdsRungOnEvery and administersEvery own the question', async () => {
    const { readFileSync } = await import('node:fs');
    const { stripComments } = await import('./_strip-comments.mjs');
    const src = stripComments(readFileSync('server/src/auth/network-rights.ts', 'utf8'));
    assert.match(src, /holdsRungOnEvery\(/, 'network-rights.ts no longer calls the shared predicate; the gate lost its subject');
    const copies = src.split('\n').filter(l => /\.every\(/.test(l) || /\.spaces\.length\s*===\s*0/.test(l));
    assert.deepEqual(copies, [], 'a hand copy of "holds on every space" (the empty-means-everything shape) — use holdsRungOnEvery / administersEvery');
  });
});
