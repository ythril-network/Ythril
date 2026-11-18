/**
 * The types a schema conversion run reaches (Q-746, bundle-284 design r5 section 5.1 "Types", finding S6).
 *
 * ## The rule
 *
 * `typesToConvert({ changedTypes, droppedTypes, inNetwork, rulesBefore, rulesAfter, steps })` is what every start of a run asks:
 *
 * - every changed type (`kind:Type`, as `typesAnEditChanges` names it), and a type rule is part of its type, so a type whose rule changed is a
 *   changed type and nothing more;
 * - the dropped types, but only on a space in no network (a networked edit keeps a type it leaves out, so nothing of it moves);
 * - every type step's `from` (the records that move live under it);
 * - when the space rules changed, the kinds those rules govern (old or new text, old or new kinds) are taken WHOLE (`*`), and no other kind:
 *   a rule edit on facts must not send a run over every entity, edge and chrono entry of the space;
 * - a kind taken whole holds no named type of its own beside `*`.
 *
 * ## What was wrong
 *
 * r3 read "the rules changed" as "every kind", so a space rule about facts rewrote and re-stamped the whole space (S6).
 *
 * Seen red on 14af4644: `server/dist/spaces/schema-convert-run.js` does not exist, so every case fails on the sentence naming it.
 *
 * Run: node --test testing/standalone/the-types-a-conversion-reaches.test.js (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleOrNull } from './_b81c-door.mjs';

const run = await moduleOrNull('spaces/schema-convert-run.js');
const { typesAnEditChanges } = await import('../../server/dist/spaces/meta-update.js');

function reach(input) {
  assert.ok(run && typeof run.typesToConvert === 'function',
    'server/src/spaces/schema-convert-run.ts (typesToConvert) is not built: no start knows which types its run reaches');
  return run.typesToConvert({ changedTypes: [], droppedTypes: [], inNetwork: false, ...input })
    .map(t => `${t.kind}:${t.type}`).sort();
}

const RULE = (rule, kinds) => ({ rule, message: 'm', ...(kinds ? { kinds } : {}) });

describe('the types a conversion reaches', () => {
  it('every changed type', () => {
    assert.deepEqual(reach({ changedTypes: ['entity:person', 'fact:claim'] }), ['entity:person', 'fact:claim']);
  });

  it('the dropped types on a space in no network, and none on a networked one', () => {
    assert.deepEqual(reach({ changedTypes: ['entity:person'], droppedTypes: ['entity:old'] }), ['entity:old', 'entity:person']);
    assert.deepEqual(reach({ changedTypes: ['entity:person'], droppedTypes: ['entity:old'], inNetwork: true }), ['entity:person'],
      'a networked edit keeps the type it leaves out, so its records are not the run\'s');
  });

  it('every type step\'s source type', () => {
    const steps = [
      { op: 'renameType', kind: 'entity', from: 'human', to: 'person' },
      { op: 'splitType', kind: 'chrono', from: 'happening', cases: [{ when: 'true', to: 'event' }] },
      { op: 'renameProperty', kind: 'fact', type: 'claim', from: 'conf', to: 'confidence' },
    ];
    assert.deepEqual(reach({ changedTypes: ['entity:person', 'chrono:event'], steps }),
      ['chrono:event', 'chrono:happening', 'entity:human', 'entity:person'],
      'the sources of the type steps are reached; a property step adds no type of its own');
  });

  it('a space-rule change reaches only the kinds of the rules that changed, whole', () => {
    const before = { onFacts: RULE('self.tags.size() > 0', ['fact']), same: RULE('true', ['edge']) };
    const after = { onFacts: RULE('self.tags.size() > 1', ['fact']), same: RULE('true', ['edge']) };
    assert.deepEqual(reach({ rulesBefore: before, rulesAfter: after }), ['fact:*'],
      'only the kind the changed rule governs; the unchanged edge rule reaches nothing');
  });

  it('a rule whose kinds moved reaches its old and its new kinds; an added or a removed rule reaches its kinds', () => {
    assert.deepEqual(reach({ rulesBefore: { r: RULE('true', ['fact']) }, rulesAfter: { r: RULE('true', ['chrono']) } }), ['chrono:*', 'fact:*']);
    assert.deepEqual(reach({ rulesBefore: {}, rulesAfter: { r: RULE('true', ['edge']) } }), ['edge:*']);
    assert.deepEqual(reach({ rulesBefore: { r: RULE('true', ['entity']) }, rulesAfter: undefined }), ['entity:*']);
  });

  it('a space rule that names no kind governs every kind', () => {
    assert.deepEqual(reach({ rulesBefore: {}, rulesAfter: { r: RULE('true') } }), ['chrono:*', 'edge:*', 'entity:*', 'fact:*']);
  });

  it('unchanged rules reach nothing', () => {
    const rules = { r: RULE('true', ['fact']) };
    assert.deepEqual(reach({ rulesBefore: rules, rulesAfter: structuredClone(rules) }), []);
  });

  it('a type rule is part of its type: the changed type, and no kind taken whole', () => {
    const base = { typeSchemas: { fact: { claim: { propertySchemas: { confidence: { type: 'number' } } } } } };
    const incoming = structuredClone(base);
    incoming.typeSchemas.fact.claim.rules = { sure: { rule: 'self.properties.confidence > 0.5', message: 'm' } };
    const changed = typesAnEditChanges(base, incoming);
    assert.deepEqual(changed, ['fact:claim'], 'precondition: typesAnEditChanges names the type whose rule changed');
    assert.deepEqual(reach({ changedTypes: changed }), ['fact:claim']);
  });

  it('a kind taken whole holds no named type beside it', () => {
    assert.deepEqual(reach({ changedTypes: ['fact:claim', 'entity:person'], rulesBefore: {}, rulesAfter: { r: RULE('true', ['fact']) } }),
      ['entity:person', 'fact:*']);
  });
});
