/**
 * A space schema written as TypeScript by `typesOfSpaceMeta` is read back by `spaceMetaFromTypeScript` as what it said, and what it
 * could not say is named, by path, in `notRead` (Q-687, design v3 items 7 to 9; D-70; the lens: data-integrity S1, testing S7).
 *
 * ## The rule held
 *
 * `spaceMetaFromTypeScript(typesOfSpaceMeta(meta).source)` agrees with `meta` on every property's kind, required and enum, the enum IN
 * ORDER (never as a set: the checker's union is not in source order, and an app that shows the choices shows them as the schema listed
 * them). Over the garden fixtures (three made-up app schemas, 46 types and about 270 properties), and over a row for each loss and shape
 * the design names (`_from-typescript-rows.mjs`): date, untyped (on every kind), a single-value enum, an enum in a non-sorted order, a
 * required property with a default, a boolean enum, an open type, and the notes the source cannot carry (pattern, minimum, maximum,
 * mergeFn, description).
 *
 * `notRead` is what makes the answer safe to use: the server REPLACES each named type whole on a write, so an answer that dropped a
 * pattern in silence would strip it from the stored schema. The oracle (`expectedProperty`) states, from the forward direction's rules,
 * exactly which property fields the source cannot carry, and the answer's `notRead` must name those and no others.
 *
 * Also held here: `stored` (the forward direction's second member of a type) is ignored as stated, and SPACE_TYPES is declared once
 * and read by both directions (a second spelling of the map's name is the way the two drift apart).
 *
 * Before the entry exists every case is red for the one reason the first case names.
 *
 * Run: node --test testing/standalone/a-space-meta-survives-its-typescript-round-trip.test.js
 * (requires a prior `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { parseSource, ts } from '../_shared/syntax-tree.mjs';
import { entry, read, sourceOf, assertRead, gardenFixtures, typesOfMeta, sourceOfMeta, assertAgrees } from './_from-typescript.mjs';
import { ROUND_TRIP_ROWS, SOURCE_ROWS, roundTrip, runSourceRow } from './_from-typescript-rows.mjs';

describe('the garden fixtures survive the round trip', () => {
  it('the entry is built', async () => {
    await entry();
  });

  for (const { name, meta } of gardenFixtures()) {
    it(`${name}: every type, and every property's kind, required and enum (in order), comes back; notRead names exactly what the source cannot carry`, async () => {
      const answer = await read(sourceOfMeta(meta));
      assertAgrees(answer, meta, name);
    });
  }

  it('the fixtures are big enough to mean something: at least 40 types, 250 properties, 50 enums (an empty scan passes everything)', () => {
    const types = gardenFixtures().flatMap(f => typesOfMeta(f.meta));
    const properties = types.flatMap(t => Object.values(t.def.propertySchemas ?? {}));
    assert.ok(types.length >= 40, `types: ${types.length}`);
    assert.ok(properties.length >= 250, `properties: ${properties.length}`);
    assert.ok(properties.filter(p => Array.isArray(p.enum)).length >= 50, 'enums');
    assert.ok(types.some(t => Object.keys(t.def.propertySchemas ?? {}).length === 0), 'open types (edges with no properties)');
  });
});

describe('the losses and shapes the design names, each with its own outcome', () => {
  for (const row of ROUND_TRIP_ROWS) {
    it(row.title, async () => {
      row.check(await roundTrip(row.meta, row.title));
    });
  }
  for (const row of SOURCE_ROWS) {
    it(row.title, async () => {
      await runSourceRow(row);
    });
  }
});

describe('stored is ignored, as stated', () => {
  it('a source whose stored member holds anything that compiles reads exactly as the same source without it', async () => {
    const without = assertRead(await read(sourceOf('name: string; size?: number;')), 'without stored');
    const withStored = assertRead(await read(sourceOf('name: string; size?: number;', { stored: 'name?: Date; junk: never; [key: string]: any' })), 'with stored');
    assert.deepEqual(withStored.meta, without.meta);
    assert.deepEqual(withStored.notRead, without.notRead);
  });

  it('the forward direction\'s own stored interface is ignored: its output reads the same on every garden type', async () => {
    const { meta } = gardenFixtures()[0];
    const answer = assertRead(await read(sourceOfMeta(meta)), 'the garden-beds source, which declares a stored interface per type');
    assert.deepEqual(Object.keys(answer.meta), ['typeSchemas']);
    for (const { kind, type } of typesOfMeta(meta)) assert.deepEqual(Object.keys(answer.meta.typeSchemas[kind][type]).filter(k => k !== 'propertySchemas'), [], `${kind}.${type} carries nothing from stored`);
  });
});

describe('SPACE_TYPES is declared once and read by both directions', () => {
  const SRC = join(REPO_ROOT, 'schema/src');

  /** The `schema/src` files that declare an exported `SPACE_TYPES`, and the files that import the name, by the AST. */
  function survey() {
    const declaresIn = [];
    const importsIn = [];
    const spellsIn = [];
    for (const f of readdirSync(SRC).filter(n => n.endsWith('.ts'))) {
      const sf = parseSource(f, readFileSync(join(SRC, f), 'utf8'));
      for (const s of sf.statements) {
        if (ts.isVariableStatement(s) && ts.getModifiers(s)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
          && s.declarationList.declarations.some(d => d.name.getText(sf) === 'SPACE_TYPES')) declaresIn.push(f);
        if (ts.isImportDeclaration(s) && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
          && s.importClause.namedBindings.elements.some(e => (e.propertyName ?? e.name).text === 'SPACE_TYPES')) importsIn.push(f);
      }
      const visit = (node) => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'SpaceTypes') spellsIn.push(f);
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return { declaresIn, importsIn, spellsIn };
  }

  it('one module exports SPACE_TYPES, typescript.ts and from-typescript.ts both import it from there, and no file spells the name as a string again', () => {
    const { declaresIn, importsIn, spellsIn } = survey();
    assert.equal(declaresIn.length, 1, `SPACE_TYPES is exported by exactly one schema/src module, got ${JSON.stringify(declaresIn)}`);
    for (const reader of ['typescript.ts', 'from-typescript.ts']) {
      assert.ok(reader === declaresIn[0] || importsIn.includes(reader), `${reader} reads SPACE_TYPES from the one module (${declaresIn[0]}), not its own copy`);
    }
    assert.deepEqual([...new Set(spellsIn)].filter(f => f !== declaresIn[0]), [], 'the string "SpaceTypes" is written in the declaring module only');
  });
});
