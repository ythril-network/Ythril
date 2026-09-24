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
