/**
 * `typesOfSpaceMeta` stays linear in the names it allocates and bounded in the literals it writes (Q-669, slice-B P1 and P2).
 *
 * ## The two costs held
 *
 * - **Colliding names (P1).** Many type names can reduce to one identifier (`a`, `a-`, `a.`, `a-.` ... all become `A`). An allocator
 *   that probes `A2`, `A3`, ... from the start for each one is quadratic: 30 000 such names cost about 450 million probes. The plan
 *   keeps a next-suffix counter per base, so the conversion is linear. Held: 30 000 colliding entity types convert within
 *   `BOUND_MS`, every one gets its own pair of identifiers, and every rename is reported.
 * - **Long enums (P2).** An enum is written as a union of literals up to `ENUM_LITERAL_MAX` (a package constant, 200); a longer one is
 *   written as its base type and reported `enum-too-long`, so a schema cannot make an app's compiler hold a union of thousands.
 *
 * Run: node --test testing/standalone/typescript-conversion-stays-linear-and-bounded.test.js
 * (requires a prior `npm run build -w @ythril/schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  schema, compileInMemory, converted, assertReported, reportsLike, exportedNames, withLines, at,
} from './_typescript-of-space-meta.mjs';

const COLLIDING = 30_000;
/** Linear work over 30 000 types (a parse each) takes well under a second; the quadratic probe takes tens of seconds. */
const BOUND_MS = 10_000;

/** `count` distinct names that each reduce to the identifier `A`: `a` followed by a binary spelling in two non-identifier characters. */
function collidingNames(count) {
  return Array.from({ length: count }, (_, i) => `a${i.toString(2).replaceAll('0', '-').replaceAll('1', '.')}`);
}

describe('colliding names convert in linear time (P1)', () => {
  it(`${COLLIDING} names that reduce to one identifier convert within ${BOUND_MS} ms, each its own, each rename reported`, () => {
    const names = collidingNames(COLLIDING);
    assert.equal(new Set(names).size, COLLIDING, 'the names are distinct');
    const meta = { typeSchemas: { entity: Object.fromEntries(names.map(n => [n, { propertySchemas: { v: { type: 'string' } } }])) } };
    const started = performance.now();
    const { source, untranslated } = converted(meta);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < BOUND_MS, `converted in ${Math.round(elapsed)} ms, over the ${BOUND_MS} ms bound: the allocator is not linear`);
    const exported = exportedNames(source);
    assert.equal(exported.length, 1 + 2 * COLLIDING, 'SpaceTypes and two interfaces per type');
    assert.equal(new Set(exported).size, exported.length, 'two types share an identifier');
    assert.equal(reportsLike(untranslated, { reason: 'renamed', kind: 'entity' }).length, COLLIDING - 1, 'every rename but the first name is reported');
  });
});

describe('a long enum is its base type (P2)', () => {
  it('ENUM_LITERAL_MAX is a package constant, 200', () => {
    assert.equal(schema.ENUM_LITERAL_MAX, 200, '@ythril/schema exports ENUM_LITERAL_MAX = 200 (Q-669, P2)');
  });

  it('an enum of ENUM_LITERAL_MAX members is a literal union; one more is its base type, reported enum-too-long', () => {
    const max = schema.ENUM_LITERAL_MAX;
    assert.equal(typeof max, 'number', '@ythril/schema exports ENUM_LITERAL_MAX');
    const strings = (n) => Array.from({ length: n }, (_, i) => `v${i}`);
    const numbers = (n) => Array.from({ length: n }, (_, i) => i);
    const meta = {
      typeSchemas: {
        entity: {
          t: {
            propertySchemas: {
              atMax: { type: 'string', enum: strings(max) },
              overMax: { type: 'string', enum: strings(max + 1) },
              numbersOver: { type: 'number', enum: numbers(max + 1) },
            },
          },
        },
      },
    };
    const { source, untranslated } = converted(meta);
    assertReported(untranslated, { reason: 'enum-too-long', kind: 'entity', type: 't' }, 'an enum over the bound');
    assert.equal(reportsLike(untranslated, { reason: 'enum-too-long' }).length, 2, 'the two enums over the bound, and not the one at it');
    const P = at('entity', 't');
    const usage = [
      "import type { SpaceTypes } from './gen';",
      "import type { Equals, Expect, Not } from './assert-types';",
      `type _a = Expect<Not<Equals<Required<${P}>['atMax'], string>>>;`,
      `type _b = Expect<Equals<Required<${P}>['atMax'], 'v0' | Required<${P}>['atMax']>>;`,
      `type _c = Expect<Equals<Required<${P}>['overMax'], string>>;`,
      `type _d = Expect<Equals<Required<${P}>['numbersOver'], number>>;`,
    ].join('\n') + '\n';
    const files = { gen: source, usage };
    const { byFile, global } = compileInMemory(files);
    assert.deepEqual(global, []);
    for (const f of Object.keys(files)) assert.equal(byFile[f].length, 0, `${f}:\n${withLines(byFile[f], files[f])}`);
  });
});
