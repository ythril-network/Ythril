/**
 * A passed `meta_change` round is read as tolerantly as a peer's layer is (b23 pre-ship I1, R6-7).
 *
 * `parseMetaRound` (`sync/meta-round-merge.ts`) parses what a passed round produces before a store may take it. It called
 * `parseSpaceMeta(applied.meta, { against })` without `tolerant: true`, so a field this release has never heard of INSIDE a type of the
 * round's `typeSchemas` (a key a later release added to a type definition or a property schema) failed the strict type schema: the
 * member refused the whole round, cast no yes on it (`castVoteAct` answers 409), and applied none of it. A peer's LAYER is read the
 * other way (`readKnownMeta`: keep what this release knows, name what it does not), the option's own docblock says tolerant is "for what
 * a peer or a vote sends", and `02b-upgrading.md` promises a key a later release adds is named, not refused.
 *
 * The rule held here, on both shapes of a round (one with provenance, and a legacy wholesale one with none):
 *  - an unknown key inside a type, inside a property schema, or an unknown knowledge kind is DROPPED from what is stored and NAMED;
 *  - a field that is KNOWN and WRONG still refuses the whole round, with the failing type named (the control: a tolerant reader is
 *    not a reader that accepts anything).
 *
 * Run: node --test testing/standalone/a-round-is-read-as-tolerantly-as-a-layer.test.js   (after `npm run build --workspace=server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let parseMetaRound;

const CURRENT = { version: 3, updatedAt: '2026-07-01T00:00:00.000Z', purpose: 'p' };

/** A round with provenance (this release's proposer) and one without (a proposer before field-merge: applied wholesale). */
const withProvenance = (pendingMeta, fields) => ({ pendingMeta, metaChangedFields: fields, baseMetaVersion: 3, metaBase: {} });
const wholesale = (pendingMeta) => ({ pendingMeta });

const SHAPES = [
  ['a round with provenance', (meta) => withProvenance(meta, Object.keys(meta))],
  ['a legacy wholesale round', (meta) => wholesale(meta)],
];

describe('a passed round names what this release does not know instead of refusing it', () => {
  before(async () => { ({ parseMetaRound } = await import('../../server/dist/sync/meta-round-merge.js')); });

  for (const [shape, round] of SHAPES) {
    describe(shape, () => {
      it('an unknown key inside a type is dropped and named, and the round is read', () => {
        const out = parseMetaRound(CURRENT, round({
          typeSchemas: { entity: { service: { propertySchemas: { status: { type: 'string' } }, zzFutureTypeField: { x: 1 } } } },
        }));
        assert.equal(out.ok, true, `the round was refused for a key a later release added: ${JSON.stringify(out)}`);
        assert.deepEqual(out.meta.typeSchemas.entity.service, { propertySchemas: { status: { type: 'string' } } },
          'the unknown key was stored, or the known part was lost');
        assert.ok(out.unknownFields.some(n => n.includes('zzFutureTypeField')), `the key is not named: ${JSON.stringify(out.unknownFields)}`);
      });

      it('an unknown key inside a property schema is dropped and named', () => {
        const out = parseMetaRound(CURRENT, round({
          typeSchemas: { entity: { service: { propertySchemas: { status: { type: 'string', zzFuturePropField: true } } } } },
        }));
        assert.equal(out.ok, true, JSON.stringify(out));
        assert.deepEqual(out.meta.typeSchemas.entity.service.propertySchemas.status, { type: 'string' });
        assert.ok(out.unknownFields.some(n => n.includes('zzFuturePropField')), JSON.stringify(out.unknownFields));
      });

      it('an unknown knowledge kind is dropped and named, and the kinds this release knows are kept', () => {
        const out = parseMetaRound(CURRENT, round({
          typeSchemas: { entity: { service: {} }, zzFutureKind: { thing: {} } },
        }));
        assert.equal(out.ok, true, JSON.stringify(out));
        assert.deepEqual(Object.keys(out.meta.typeSchemas), ['entity']);
        assert.ok(out.unknownFields.some(n => n.includes('zzFutureKind')), JSON.stringify(out.unknownFields));
      });

      it('control: a field that is KNOWN and WRONG still refuses the whole round, naming the type', () => {
        const out = parseMetaRound(CURRENT, round({
          typeSchemas: { entity: { service: { propertySchemas: { status: { type: 'not-a-property-type' } } } } },
        }));
        assert.equal(out.ok, false, 'a tolerant reader accepted a wrong value');
        assert.match(out.reason, /entity:service/, `the refusal does not name the failing type: ${out.reason}`);
      });
    });
  }
});
