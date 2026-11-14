/**
 * The client builds a type clause exactly as the server does (Q-744, bundle-268 design r3 §7.1, r4 §K "array-type guard" and §10 T9).
 *
 * ## The contract (written before the code)
 *
 * - Server: `typeClauseOf(kind, T)` in `server/dist/spaces/type-field-clause.js` answers `{ [field]: { $eq: T, $not: { $type: 'array' } } }`,
 *   `field` being `TYPE_FIELD[kind]` (`label` for an edge, `type` otherwise; brain/ttl.ts). The guard keeps an array that holds T out of
 *   T's records (amend V7: `['T','X']` and `['T']` excluded, `'T'` kept).
 * - Client: `client/src/app/core/type-field.ts` exports `TYPE_FIELD` and `typeClauseOf` with the same answers, for the Brain's "Type:"
 *   chip and the deep link a type's history opens.
 * - Both are read over ONE fixture, the shared answer fixture's `typeClause` (kinds, and names including `__proto__`, `constructor`, a
 *   space, a dot and non-ASCII), so the two sides are compared on the same inputs and neither restates them.
 *
 * ## Seen red at 327b105e
 *
 * Neither builder exists: `spaces/type-field-clause.js` is not built and `client/src/app/core/type-field.ts` is absent.
 *
 * Run: node --test testing/standalone/the-client-type-field-is-the-servers.test.js (a prior `npm run build` in server/; Node strips the
 * client file's types itself)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { need } from './_type-history.mjs';

const FIXTURE = new URL('../../client/src/app/testing/fixtures/schema-type-answers.json', import.meta.url);
const CLIENT = new URL('../../client/src/app/core/type-field.ts', import.meta.url);

describe('the client type clause is the server\'s', () => {
  it('the fixture names every kind and the names that bite (a floor)', () => {
    const { typeClause } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    assert.deepEqual([...typeClause.kinds].sort(), ['chrono', 'edge', 'entity', 'fact']);
    assert.ok(typeClause.names.includes('__proto__') && typeClause.names.includes('constructor') && typeClause.names.length >= 5);
  });

  it('the server\'s typeClauseOf guards the array and names the kind\'s type field', async () => {
    const { typeClauseOf } = await need('spaces/type-field-clause.js', ['typeClauseOf']);
    const { TYPE_FIELD } = await import('../../server/dist/brain/ttl.js');
    const { typeClause } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    for (const kind of typeClause.kinds) {
      for (const T of typeClause.names) {
        const c = typeClauseOf(kind, T);
        assert.deepEqual(Object.keys(c), [TYPE_FIELD[kind]], `${kind}/${T}: the clause is not on the kind's type field`);
        assert.deepEqual(c[TYPE_FIELD[kind]], { $eq: T, $not: { $type: 'array' } }, `${kind}/${T}: the clause is not the guarded equality`);
      }
    }
  });

  it('the client\'s TYPE_FIELD and typeClauseOf answer what the server\'s answer, for every kind and name of the fixture', async () => {
    assert.ok(existsSync(CLIENT), 'client/src/app/core/type-field.ts does not exist');
    const client = await import(CLIENT.href);
    const server = await need('spaces/type-field-clause.js', ['typeClauseOf']);
    const { TYPE_FIELD } = await import('../../server/dist/brain/ttl.js');
    assert.deepEqual({ ...client.TYPE_FIELD }, { ...TYPE_FIELD }, 'the client\'s type field table is not the server\'s');
    const { typeClause } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const differ = [];
    for (const kind of typeClause.kinds) {
      for (const T of typeClause.names) {
        const a = JSON.stringify(client.typeClauseOf(kind, T));
        const b = JSON.stringify(server.typeClauseOf(kind, T));
        if (a !== b) differ.push(`${kind}/${T}: client ${a}, server ${b}`);
      }
    }
    assert.deepEqual(differ, []);
  });
});
