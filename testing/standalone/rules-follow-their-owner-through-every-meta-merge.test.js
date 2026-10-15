/**
 * A rule goes where its owner goes: `meta.rules` is replaced whole, a type's rules are replaced with the type, and a network's
 * rules for a type win for that type (F-46, ruling R6-5; the audit half, R6-13).
 *
 * ## Why rules do not have a merge of their own
 *
 * The first design gave `rules` a per-name union: add a rule by naming it, keep the others. It was withdrawn, because the three
 * places a schema is merged do not agree on anything else — a PATCH replaces a type by name, a network round replaces a type by
 * name, a network layer unions a type's `propertySchemas` and takes its other fields whole — and a union by rule name has no way to
 * DELETE a rule: a round carries the proposed meta and no list of what was removed, so a rule a network retracted would never
 * reach a member that had it, and an always-failing rule would lock a strict space's writes out with nothing able to remove it.
 *
 * So there is one rule for each owner, and the three merges agree on it:
 *
 * | owner | what the merge does |
 * |---|---|
 * | `meta.rules` (the space's) | a TOP-LEVEL field: the map sent replaces the map stored, whole. A rule is deleted by sending the map without it; `{}` clears them; absent leaves them |
 * | `typeSchemas.<kind>.<type>.rules` | part of the TYPE: the type is replaced as a unit (PATCH, PUT and a round, by type name), so its rules go with it; a type sent without `rules` has none |
 * | a network layer's rules for a type | the network's type fields win, so the layer's `rules` for that type replace the local ones; `propertySchemas` stays the one unioned field (the owner's additive ruling) |
 *
 * The same table is asserted through all of the merges (`mergeSpaceMeta` for PATCH and `schema_update`, `mergeReplicatedMeta` and
 * `effectiveMeta` for a layer, `applyMetaRound` for a passed round), because a rule that is replaced by one and unioned by another is
 * a space whose rules depend on which door the last edit came through.
 *
 * ## The audit half
 *
 * A rule is stored text. The audit log records that a rule was added or removed by NAME — type, property and rule names, for the PUT
 * routes and for PATCH, `schema_update` and `update_space` alike — and never a rule's text or message (an expression names the
 * properties it reads, and a message is whatever its author wrote).
 *
 * Run: node --test testing/standalone/rules-follow-their-owner-through-every-meta-merge.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { rule, DECLARED } from './_cel-rules.mjs';

let mergeSpaceMeta, planSpaceMetaUpdate, mergeReplicatedMeta, effectiveMeta, applyMetaRound, auditChanges;

before(async () => {
  ({ mergeSpaceMeta, planSpaceMetaUpdate } = await import('../../server/dist/spaces/meta-update.js'));
  ({ mergeReplicatedMeta, effectiveMeta } = await import('../../server/dist/sync/replicated-meta.js'));
  ({ applyMetaRound } = await import('../../server/dist/sync/meta-round-merge.js'));
  ({ auditChanges } = await import('../../server/dist/audit/audit-changes.js'));
});

const r = (name) => rule(`self.properties.a != '${name}'`, `not ${name}`);
const rulesMap = (...names) => Object.fromEntries(names.map(n => [n, r(n)]));
const typed = (rules, extra = {}) => ({ propertySchemas: DECLARED, ...(rules ? { rules } : {}), ...extra });
const metaWith = ({ rules, types } = {}) => ({
  validationMode: 'strict', version: 3, ...(rules ? { rules } : {}), ...(types ? { typeSchemas: { entity: types } } : {}),
});

describe('the merges below are about rules the bodies accept', () => {
  // The merges are generic over keys, so on a build that has no `rules` they pass on objects the save would never let in. This
  // case is what makes the table below a statement about a real field: a stored rule is one a body admits, at both levels.
  it('a type\'s rules and the space\'s rules are accepted by the bodies every write parses through', async () => {
    const { SpaceMetaBody } = await import('../../server/dist/spaces/body-schemas.js');
    const { version: _housekeeping, ...body } = metaWith({ rules: rulesMap('one'), types: { service: typed(rulesMap('two')) } });
    const parsed = SpaceMetaBody.safeParse(body);
    assert.equal(parsed.success, true, `a meta carrying rules is not a meta: ${parsed.success ? '' : JSON.stringify(parsed.error.issues).slice(0, 300)}`);
  });
});

describe('mergeSpaceMeta: PATCH and schema_update', () => {
  it('meta.rules is replaced whole: a rule left out of the map is deleted, an empty map clears, an absent field leaves them', () => {
    const stored = metaWith({ rules: rulesMap('one', 'two') });
    assert.deepEqual(Object.keys(mergeSpaceMeta(stored, { rules: rulesMap('one', 'three') }).rules ?? {}).sort(), ['one', 'three'],
      'the map sent was unioned with the stored one, or ignored');
    assert.deepEqual(mergeSpaceMeta(stored, { rules: {} }).rules, {}, 'an empty map did not clear the rules');
    assert.deepEqual(Object.keys(mergeSpaceMeta(stored, { purpose: 'unrelated' }).rules ?? {}).sort(), ['one', 'two'],
      'a patch that does not mention rules changed them');
  });

  it('a type\'s rules are replaced with the type: a type sent without rules has none, and other types are left alone', () => {
    const stored = metaWith({ types: { service: typed(rulesMap('one', 'two')), team: typed(rulesMap('keep')) } });
    const withoutRules = mergeSpaceMeta(stored, { typeSchemas: { entity: { service: typed(undefined) } } });
    assert.equal(withoutRules.typeSchemas.entity.service.rules, undefined, 'the type\'s rules survived its replacement');
    assert.deepEqual(Object.keys(withoutRules.typeSchemas.entity.team.rules ?? {}), ['keep'], 'a type the patch did not name lost its rules');
    const replaced = mergeSpaceMeta(stored, { typeSchemas: { entity: { service: typed(rulesMap('three')) } } });
    assert.deepEqual(Object.keys(replaced.typeSchemas.entity.service.rules ?? {}), ['three'], 'the type\'s rules were unioned instead of replaced');
  });

  it('typeSchemasMode replace takes the payload\'s rules too, and drops the types it leaves out with theirs', () => {
    const stored = metaWith({ types: { service: typed(rulesMap('one')), team: typed(rulesMap('two')) } });
    const merged = mergeSpaceMeta(stored, { typeSchemas: { entity: { service: typed(rulesMap('three')) } } }, 'replace');
    assert.deepEqual(Object.keys(merged.typeSchemas.entity), ['service']);
    assert.deepEqual(Object.keys(merged.typeSchemas.entity.service.rules ?? {}), ['three']);
  });
});

describe('planSpaceMetaUpdate: the same merge, and the refusals the save owns', () => {
  const space = (meta) => ({ id: 's', label: 's', folders: [], meta });
  const plan = (meta, body) => planSpaceMetaUpdate({ spaceId: 's', space: space(meta), body, ifMatch: undefined });

  it('a PATCH carrying meta.rules is accepted and the plan stores the map as sent', () => {
    const decision = plan(metaWith({ rules: rulesMap('one', 'two') }), { meta: { rules: rulesMap('three') } });
    assert.equal(decision.ok, true, `refused: ${JSON.stringify(decision.refusal)}`);
    assert.deepEqual(Object.keys(decision.plan.mergedMeta.rules), ['three']);
  });

  it('a rule that cannot run is refused by the PATCH with the status a body refusal has, naming the rule', () => {
    // The control first: the SAME body with a sound rule is planned. Without it, "refused" is what a build with no `rules` says too.
    const control = plan(metaWith(), { meta: { rules: { fine: rule(`self.title != 'x'`, 'not x') } } });
    assert.equal(control.ok, true, `a sound space rule was refused: ${JSON.stringify(control.refusal)?.slice(0, 300)}`);
    const decision = plan(metaWith(), { meta: { rules: { broken: rule('self.properties.a ==', 'not an expression') } } });
    assert.equal(decision.ok, false, 'a rule that is not an expression was planned');
    assert.doesNotMatch(String(decision.refusal.body.error), /unrecogni[sz]ed/i, 'refused as an unknown key, not as a rule that cannot run');
    assert.equal(decision.refusal.status, 400);
    assert.match(decision.refusal.body.error, /rules/, 'the refusal does not say which part of the body');
  });

  it('what is applicable to a type is judged on the MERGED meta: 30 stored type rules and a patch adding 21 space rules are over 50', () => {
    const stored = metaWith({ types: { service: typed(rulesMap(...Array.from({ length: 30 }, (_, i) => `t${i}`))) } });
    const ok = plan(stored, { meta: { rules: rulesMap(...Array.from({ length: 20 }, (_, i) => `s${i}`)) } });
    assert.equal(ok.ok, true, `30 + 20 applicable were refused: ${JSON.stringify(ok.refusal)}`);
    const over = plan(stored, { meta: { rules: rulesMap(...Array.from({ length: 21 }, (_, i) => `s${i}`)) } });
    assert.equal(over.ok, false, '30 type rules and 21 space rules, all applicable to the same type, were planned');
    assert.equal(over.refusal.status, 400);
    assert.match(over.refusal.body.error, /rules/);
  });

  it('a type the patch leaves alone is not re-judged against a stored rule it can no longer satisfy (the save does not freeze a stored meta)', () => {
    // A stored rule that was valid when saved and reads a property since removed is the boot check's business (skipped and
    // reported), not a reason to refuse an unrelated purpose edit.
    const stored = metaWith({ types: { service: { propertySchemas: {}, rules: { gone: rule(`self.properties.removed == 'x'`, 'reads removed') } } } });
    const decision = plan(stored, { meta: { purpose: 'edited' } });
    assert.equal(decision.ok, true, `an unrelated edit was refused for a stored rule: ${JSON.stringify(decision.refusal)}`);
    // The control that makes "not re-judged" mean something: the type the patch DOES carry is judged — a rule on the same stale
    // property, sent in the patch, is refused.
    const sent = plan(stored, { meta: { typeSchemas: { entity: { service: { propertySchemas: {}, rules: { gone: rule(`self.properties.removed == 'x'`, 'reads removed') } } } } } });
    assert.equal(sent.ok, false, 'a rule on a property the type does not declare was planned when it was SENT');
    assert.match(JSON.stringify(sent.refusal?.body), /gone/, 'refused, but not as a verdict on the rule named `gone`');
  });
});

describe('a network layer: the network\'s rules for a type win for that type', () => {
  const layerWith = (meta) => ({ networkId: 'net-a', meta });

  it('mergeReplicatedMeta replaces meta.rules whole and takes the layer\'s rules for a type it names', () => {
    const local = metaWith({ rules: rulesMap('local1', 'local2'), types: { service: typed(rulesMap('mine')), team: typed(rulesMap('kept')) } });
    const incoming = { rules: rulesMap('net1'), typeSchemas: { entity: { service: typed(rulesMap('theirs')) } } };
    const { meta, invalid } = mergeReplicatedMeta(local, incoming);
    assert.equal(invalid, undefined, `the layer was refused: ${invalid}`);
    assert.deepEqual(Object.keys(meta.rules ?? {}), ['net1'], 'meta.rules was unioned, or the network\'s was not taken');
    assert.deepEqual(Object.keys(meta.typeSchemas.entity.service.rules ?? {}), ['theirs'], 'the local rules of a type the network defines survived');
    assert.deepEqual(Object.keys(meta.typeSchemas.entity.team.rules ?? {}), ['kept'], 'a type the network does not name lost its rules');
  });

  it('the property map of that same type is still unioned: rules are replaced, propertySchemas is the one additive field', () => {
    // Each side declares `a`, which its rules read: a rule on an undeclared property makes the layer invalid, which is not what this case is about.
    const local = metaWith({ types: { service: { propertySchemas: { a: { type: 'string' }, mine: { type: 'string' } }, rules: rulesMap('mine') } } });
    const incoming = { typeSchemas: { entity: { service: { propertySchemas: { a: { type: 'string' }, theirs: { type: 'string' } }, rules: rulesMap('theirs') } } } };
    const { meta, invalid } = mergeReplicatedMeta(local, incoming);
    assert.equal(invalid, undefined, `the layer was refused: ${invalid}`);
    assert.deepEqual(Object.keys(meta.typeSchemas.entity.service.propertySchemas).sort(), ['a', 'mine', 'theirs']);
    assert.deepEqual(Object.keys(meta.typeSchemas.entity.service.rules ?? {}), ['theirs']);
  });

  it('with two networks the higher one wins the type\'s rules, and a space\'s own rules are what the lowest layer leaves', () => {
    const own = metaWith({ rules: rulesMap('own'), types: { service: typed(rulesMap('own')) } });
    const high = layerWith({ typeSchemas: { entity: { service: typed(rulesMap('high')) } } });
    const low = layerWith({ typeSchemas: { entity: { service: typed(rulesMap('low')) } }, rules: rulesMap('low') });
    const effective = effectiveMeta(own, [high, low]);
    assert.deepEqual(Object.keys(effective.typeSchemas.entity.service.rules ?? {}), ['high'], 'the lower-precedence network\'s rules won');
    assert.deepEqual(Object.keys(effective.rules ?? {}), ['low'], 'the layer\'s space rules were not taken');
  });

  it('a layer that carries rules is accepted: a body that refuses them would drop the whole layer', () => {
    const { changed, invalid } = mergeReplicatedMeta(metaWith(), { rules: rulesMap('net1') });
    assert.equal(invalid, undefined, `a network's rules were refused whole (so a member's other schema fields would be dropped with them): ${invalid}`);
    assert.equal(changed, true);
  });
});

describe('a passed round applies a rule change the way the other merges do', () => {
  const round = (pendingMeta, metaChangedFields, baseMetaVersion = 3) => ({ pendingMeta, metaChangedFields, baseMetaVersion });

  it('a round that changes meta.rules replaces the map whole on every member', () => {
    const current = metaWith({ rules: rulesMap('one', 'two') });
    const applied = applyMetaRound(current, round(metaWith({ rules: rulesMap('one', 'three') }), ['rules']));
    assert.deepEqual(Object.keys(applied.meta.rules ?? {}).sort(), ['one', 'three']);
    const cleared = applyMetaRound(current, round({ validationMode: 'strict', version: 3 }, ['rules']));
    assert.equal(cleared.meta.rules, undefined, 'a round that retracts the rules left them on the members that had them');
  });

  it('a round that changes a type replaces that type with its rules, and leaves the types it does not carry alone', () => {
    const current = metaWith({ types: { service: typed(rulesMap('one', 'two')), team: typed(rulesMap('keep')) } });
    const applied = applyMetaRound(current, round(metaWith({ types: { service: typed(rulesMap('three')) } }), ['typeSchemas']));
    assert.deepEqual(Object.keys(applied.meta.typeSchemas.entity.service.rules ?? {}), ['three']);
    assert.deepEqual(Object.keys(applied.meta.typeSchemas.entity.team.rules ?? {}), ['keep']);
    const retracted = applyMetaRound(current, round(metaWith({ types: { service: typed(undefined) } }), ['typeSchemas']));
    assert.equal(retracted.meta.typeSchemas.entity.service.rules, undefined, 'a type proposed without rules kept the rules the member had');
  });
});

describe('the audit log records rule NAMES, never text', () => {
  const EXPRESSION = `self.properties.secretcode == 'EXPRESSION-NEVER-LOGGED'`;
  const MESSAGE = 'MESSAGE-NEVER-LOGGED';
  const secret = (name) => ({ [name]: { rule: EXPRESSION, message: MESSAGE } });
  const typeOf = (rules) => ({ typeSchemas: { entity: { service: { propertySchemas: { secretcode: {} }, ...(rules ? { rules } : {}) } } } });

  it('a PUT route\'s snapshot: the rule names added and removed under their type', () => {
    const changes = auditChanges('space.schema.update', typeOf(secret('oldrule')), typeOf(secret('newrule')));
    const c = changes.find(x => /service\.rules$/.test(x.field));
    assert.ok(c, `no change recorded for the type's rules: ${JSON.stringify(changes)}`);
    assert.deepEqual([c.added, c.removed], [['newrule'], ['oldrule']]);
  });

  it('PATCH, schema_update and update_space (space.update) record them as well, for a type and for the space', () => {
    const typeChanges = auditChanges('space.update', typeOf(secret('oldrule')), typeOf(secret('newrule')));
    assert.ok(typeChanges.some(c => (c.added ?? []).includes('newrule')), `space.update recorded no type-rule change: ${JSON.stringify(typeChanges)}`);
    const spaceChanges = auditChanges('space.update', { rules: secret('oldspace') }, { rules: secret('newspace') });
    assert.ok(spaceChanges.some(c => (c.added ?? []).includes('newspace') && (c.removed ?? []).includes('oldspace')),
      `space.update recorded no change to the space's rules: ${JSON.stringify(spaceChanges)}`);
  });

  it('nothing a rule says is anywhere in what is recorded', () => {
    const all = [
      ...auditChanges('space.schema.update', typeOf(secret('a')), typeOf(secret('b'))),
      ...auditChanges('space.update', typeOf(secret('a')), typeOf(secret('b'))),
      ...auditChanges('space.update', { rules: secret('a') }, { rules: secret('b') }),
    ];
    const text = JSON.stringify(all);
    assert.ok(all.length > 0, 'nothing was recorded, so nothing proves the text is absent');
    assert.doesNotMatch(text, /EXPRESSION-NEVER-LOGGED|MESSAGE-NEVER-LOGGED|secretcode ==/, `a rule's text reached the audit log: ${text.slice(0, 300)}`);
  });
});
