/**
 * The rows of the round trip `spaceMetaFromTypeScript(typesOfSpaceMeta(meta).source)` (Q-687, design v3 "Tests"): each a space meta, the
 * outcome the reverse direction must name for it, and the whole answer checked against the oracle (`assertAgrees`).
 *
 * ## The question it answers
 *
 * *"What does a schema come back as after a trip through TypeScript?"* Two files ask it, over the same rows: the round trip on the
 * compiler the repository tests with, and the same on 6.x (`from-typescript-reads-the-same-on-typescript-6.test.js`). The rows live here
 * once so the second is the first, run on another compiler, and not a second list that drifts.
 *
 * ## What each row names
 *
 * Every row is a LOSS or a SHAPE with its own named outcome: what comes back, and what `notRead` says by path. A row whose schema
 * comes back exactly (the garden fixtures, `plain`) says nothing in `notRead` for the property it covers.
 */
import assert from 'node:assert/strict';
import { read, assertAgrees, assertRead, propertyOf, notReadHas, sourceOfMeta, sourceOf, KNOWLEDGE_TYPES } from './_from-typescript.mjs';
import * as schema from '../../schema/dist/index.js';

/** A meta with one type `thing` of `kind` holding `properties`. */
export const metaOf = (properties, kind = 'entity', type = {}) => ({ typeSchemas: { [kind]: { thing: { ...type, propertySchemas: properties } } } });

/** The path `notRead` carries for `field` of `key` on `kind.thing`. */
export const pathOf = (key, field, kind = 'entity') => [kind, 'thing', 'propertySchemas', key, field];

/**
 * One round trip: the meta is a valid space meta (so the row is about the trip and not a bad input), its source is read, the answer
 * agrees with the oracle, and the row's own outcome holds.
 */
export async function roundTrip(meta, why, options) {
  const valid = schema.validateSpaceMeta(meta);
  assert.equal(valid.ok, true, `${why}: the row's meta is a space meta the server accepts: ${JSON.stringify(valid).slice(0, 300)}`);
  const answer = await read(sourceOfMeta(meta), options);
  assertAgrees(answer, meta, why);
  return answer;
}

/** The rows: `{ title, meta, check(answer) }`. */
export const ROUND_TRIP_ROWS = [
  {
    title: 'a plain schema comes back as it was and says nothing in notRead',
    meta: metaOf({ name: { type: 'string', required: true }, size: { type: 'number' }, edible: { type: 'boolean' } }),
    check(answer) {
      assert.deepEqual(answer.meta.typeSchemas.entity, { thing: { propertySchemas: { name: { type: 'string', required: true }, size: { type: 'number' }, edible: { type: 'boolean' } } } });
      assert.deepEqual(answer.notRead, []);
    },
  },
  {
    title: 'a date comes back as a string, and is in notRead by path',
    meta: metaOf({ when: { type: 'date' } }),
    check(answer) {
      assert.equal(propertyOf(answer, 'entity', 'thing', 'when').type, 'string');
      assert.ok(notReadHas(answer, pathOf('when', 'type')), `notRead names the date: ${JSON.stringify(answer.notRead)}`);
    },
  },
  ...KNOWLEDGE_TYPES.map(kind => ({
    title: `an untyped property comes back untyped on ${kind} (${kind === 'entity' ? 'string | number | boolean' : 'unknown'}), beside a typed one`,
    meta: metaOf({ anything: {}, typed: { type: 'string' } }, kind),
    check(answer) {
      assert.deepEqual(propertyOf(answer, kind, 'thing', 'anything'), {}, 'untyped: no type, not required');
      assert.equal(propertyOf(answer, kind, 'thing', 'typed').type, 'string');
      assert.deepEqual(answer.notRead, []);
    },
  })),
  {
    title: 'a single-value enum comes back as an enum of one (string and number)',
    meta: metaOf({ only: { type: 'string', enum: ['only'] }, seven: { type: 'number', enum: [7] } }),
    check(answer) {
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'only'), { type: 'string', enum: ['only'] });
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'seven'), { type: 'number', enum: [7] });
      assert.deepEqual(answer.notRead, []);
    },
  },
  {
    title: 'an enum keeps the SOURCE order, which the checker\'s union does not (z, m, a; 3, 1, 2)',
    meta: metaOf({ first: { type: 'string', enum: ['a', 'b'] }, order: { type: 'string', enum: ['z', 'm', 'a', 'b'] }, nums: { type: 'number', enum: [3, 1, 2] } }),
    check(answer) {
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'order').enum, ['z', 'm', 'a', 'b'], 'ordered comparison, not a set');
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'nums').enum, [3, 1, 2]);
    },
  },
  {
    title: 'a required property with a default comes back optional, with the default and the requirement in notRead',
    meta: metaOf({ colour: { type: 'string', required: true, default: 'green' } }),
    check(answer) {
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'colour'), { type: 'string' });
      assert.ok(notReadHas(answer, pathOf('colour', 'default')), `the default is named: ${JSON.stringify(answer.notRead)}`);
      assert.ok(notReadHas(answer, pathOf('colour', 'required')), `the requirement it had is named: ${JSON.stringify(answer.notRead)}`);
    },
  },
  {
    title: 'a boolean enum [true] comes back boolean (it widens), and the enum is in notRead',
    meta: metaOf({ yes: { type: 'boolean', enum: [true] }, no: { type: 'boolean', enum: [false] } }),
    check(answer) {
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'yes'), { type: 'boolean' });
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'no'), { type: 'boolean' });
      assert.ok(notReadHas(answer, pathOf('yes', 'enum')));
      assert.ok(notReadHas(answer, pathOf('no', 'enum')));
    },
  },
  {
    title: 'a mixed literal enum with no base type comes back as an untyped enum, in order',
    meta: metaOf({ mixed: { enum: [2, 'a', 1, 'b'] } }),
    check(answer) {
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'mixed'), { enum: [2, 'a', 1, 'b'] });
    },
  },
  {
    title: 'an untyped enum of one base type comes back as that type (the source cannot tell the two apart)',
    meta: metaOf({ strings: { enum: ['x', 'y'] }, numbers: { enum: [5, 4] } }),
    check(answer) {
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'strings'), { type: 'string', enum: ['x', 'y'] });
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'numbers'), { type: 'number', enum: [5, 4] });
    },
  },
  {
    title: 'an open type (no properties, or an empty map) comes back with no propertySchemas',
    meta: { typeSchemas: { entity: { open: {}, empty: { propertySchemas: {} } }, fact: { open: {} } } },
    check(answer) {
      for (const [kind, type] of [['entity', 'open'], ['entity', 'empty'], ['fact', 'open']]) {
        assert.ok(answer.meta.typeSchemas[kind][type], `${kind}.${type} comes back`);
        assert.equal(answer.meta.typeSchemas[kind][type].propertySchemas, undefined, `${kind}.${type} is open`);
      }
    },
  },
  {
    title: 'pattern, minimum, maximum, mergeFn and description are in notRead by path, never read back',
    meta: metaOf({
      code: { type: 'string', pattern: '^[a-z]+$', description: 'A short code.' },
      count: { type: 'number', minimum: 0, maximum: 10, mergeFn: 'sum', description: 'How many.' },
      flag: { type: 'boolean', mergeFn: 'or' },
    }),
    check(answer) {
      for (const [key, field] of [['code', 'pattern'], ['code', 'description'], ['count', 'minimum'], ['count', 'maximum'], ['count', 'mergeFn'], ['count', 'description'], ['flag', 'mergeFn']]) {
        assert.ok(notReadHas(answer, pathOf(key, field)), `${key}.${field} is named in notRead: ${JSON.stringify(answer.notRead)}`);
      }
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'count'), { type: 'number' }, 'none of them is read back');
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'code'), { type: 'string' });
    },
  },
];

/** The rows that come from a hand-written SOURCE (no meta behind them): `{ title, source, check(answer) }`. */
export const SOURCE_ROWS = [
  {
    title: 'optional (?) and | undefined both mean not required; a bare member is required',
    source: sourceOf('a?: string; b: string | undefined; c: string; d?: "x" | "y";'),
    check(answer) {
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'a'), { type: 'string' });
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'b'), { type: 'string' });
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'c'), { type: 'string', required: true });
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'd'), { type: 'string', enum: ['x', 'y'] });
    },
  },
  {
    title: 'a boolean literal union (true | false) is boolean with nothing in notRead',
    source: sourceOf('a: true | false; b: boolean;'),
    check(answer) {
      assert.deepEqual(propertyOf(answer, 'entity', 'thing', 'a'), { type: 'boolean', required: true });
      assert.deepEqual(answer.notRead, []);
    },
  },
  {
    title: 'an object whose only member is an index signature is an open type: no propertySchemas (entity and fact)',
    source: 'export interface SpaceTypes {\n  "entity": { "bag": { properties: { [key: string]: string | number | boolean } } };\n  "fact": { "bag": { properties: { [key: string]: unknown } } };\n}\n',
    check(answer) {
      for (const kind of ['entity', 'fact']) {
        assert.ok(answer.meta.typeSchemas[kind].bag, `${kind}.bag comes back`);
        assert.equal(answer.meta.typeSchemas[kind].bag.propertySchemas, undefined, `${kind}.bag is open`);
      }
    },
  },
];

/** Reads each source row and runs its check: used by both files that run the rows. */
export async function runSourceRow(row, options) {
  const answer = await read(row.source, options);
  assertRead(answer, row.title);
  row.check(answer);
}
