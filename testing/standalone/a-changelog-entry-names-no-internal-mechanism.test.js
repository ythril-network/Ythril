/**
 * A changelog entry says what the reader can do or what changed for them; it never names how the server does it.
 *
 * ## Why this exists (Q-975)
 *
 * The changelog and the release notes cut from it are public. What outsiders read there is how Ythril works inside, and
 * an idea published there can no longer be patented in Germany. The owner, 2026-11-27: "dont publish too much info in
 * changelog from now on. enforce in flows and on whatever door makes sense." The entries of bundle-273 (a stored triple
 * index, SPARQL views) were the first to name a collection, a write journal and a rebuild; `the-changelog-is-written-for-its-reader`
 * held their length and their tone and nothing about what they gave away.
 *
 * ## What it holds
 *
 * Over `[Unreleased]` and every release after 6.5.7 (the released sections up to it stay as published), a line names none of:
 *
 * - a term of `MECHANISM_TERMS` (bitmap, posting list, journal, lease ... each with its reason);
 * - a source path (`server/src/...`, a `.ts` file);
 * - an internal collection or storage name (`<space>_rdf_quads`), read from `SPACE_COLLECTIONS` and `col('...')`;
 * - a source identifier in a code span that is no public name.
 *
 * Public names are derived from the code on every run (`scripts/_changelog-surfaces.mjs`), never listed: so the specs
 * below plant a surface that exists only in a fixture, show it admitted, rename it in the fixture and show the old name
 * refused. The same check runs in the static preflight (this file) and in the release gate and the release-notes cut
 * (`a-release-cut-holds-the-mechanism-rule`).
 *
 * ## What it does not hold
 *
 * That an entry is free of an idea: a sentence in plain words can still describe a mechanism. The term list is the net
 * for the words we know; the rest is the review that reads an entry as an outsider would.
 *
 * Run: node --test testing/standalone/a-changelog-entry-names-no-internal-mechanism.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MECHANISM_TERMS, EXEMPT_THROUGH, holdsMechanismRule, surfacesOf, mechanismsIn, changelogMechanisms, describeMechanisms,
} from '../../scripts/_changelog-mechanisms.mjs';
import { codeSurfaces } from '../../scripts/_changelog-surfaces.mjs';

/** The collections a space owns, in the shape the server declares them, plus any extra `key: 'value'` rows. */
const collectionsFile = (extra = {}) => ({
  file: 'server/src/db/space-collection.ts',
  text: `export const SPACE_COLLECTIONS = {\n${[
    ...['facts', 'entities', 'edges', 'chrono', 'files', 'tombstones', 'links', 'conflicts', 'embed_jobs', 'media_jobs']
      .map(v => `  ${v.replace(/_(\w)/g, (_, c) => c.toUpperCase())}: '${v}',`),
    ...Object.entries(extra).map(([k, v]) => `  ${k}: '${v}',`),
  ].join('\n')}\n} as const;\n`,
});

/** A tree that carries one planted surface of each kind, under the names given (renaming is how a test follows the code). */
const planted = (n = {}) => {
  const p = { route: 'plantedParam', tool: 'zz_planted_tool', param: 'plantedLimit', section: 'plantedSection', key: 'plantedWindowMs',
    env: 'ZZ_PLANTED_ENV', code: 'zz_planted_refused', metric: 'ythril_zz_planted_total', label: 'plantedOutcome', header: 'X-Zz-Planted', ...n };
  return [
    collectionsFile({ zzPlantedStore: 'zz_planted_store' }),
    { file: 'server/src/api/planted.ts', text: `
      router.get('/api/zz-planted/:${p.route}', handler);
      export const planted_toolTool = { name: '${p.tool}', inputSchema: { type: 'object', properties: { ${p.param}: { type: 'number' } } } };
      export interface PlantedConfig { ${p.section}?: { ${p.key}?: number } }
      const read = process.env.${p.env};
      fail({ error: '${p.code}' });
      new Counter({ name: '${p.metric}', labelNames: ['${p.label}'] });
      res.setHeader('${p.header}', '1');
      // a comment that names \`commentOnlyName\` and bufferedThing
      const zzPlantedStore = col('zz_planted_store');
      export function startPlantedMechanism() { return openPlantedMechanismWriter(); }
      export class PlantedMechanismWriter {}
    ` },
  ];
};

const entry = (...spans) => `- **Planted:** ${spans.map(s => `\`${s}\``).join(', ')} are what a reader types or reads.`;
const rules = (text, files = planted()) => mechanismsIn(text, surfacesOf(files)).map(o => `${o.rule}:${o.found}`);

describe('a changelog entry names no internal mechanism', () => {
  describe('it refuses each kind of internal name', () => {
    it('a source path', () => {
      assert.deepEqual(rules('- **RDF:** read in `server/src/rdf/triple-read.ts`.'), ['path:server/src/rdf/triple-read.ts', 'path:triple-read.ts']);
      assert.deepEqual(rules('- **RDF:** the module client/src/app/foo is gone.'), ['path:client/src/app/foo']);
      assert.deepEqual(rules('- **Web:** `Foo.component.ts` is gone.'), ['path:component.ts']);
    });

    it('admits the paths a reader is told to run or open (scripts/, docs/, a `node testing/...` command)', () => {
      assert.deepEqual(rules('- **Testing:** `node scripts/test-failure-rates.mjs` prints; see [guide](docs/integration-guide/04j-sparql-api.md#sparql-update).'), []);
      assert.deepEqual(rules('- **Testing:** `node testing/_init/db-shard-stack.mjs own-up <label>` starts one.'), []);
      assert.deepEqual(rules('- **Testing:** the tests read it through `testing/standalone/_metric-sources.mjs`.'), ['path:testing/standalone/_metric-sources.mjs']);
    });

    it('a source identifier that is only a function or a class in the code', () => {
      assert.deepEqual(rules('- **RDF:** `startPlantedMechanism` runs.'), ['identifier:startPlantedMechanism']);
      assert.deepEqual(rules('- **RDF:** `PlantedMechanismWriter` writes.'), ['identifier:PlantedMechanismWriter']);
      assert.deepEqual(rules('- **RDF:** `open_planted_thing` runs.'), ['identifier:open_planted_thing']);
      // a word that the code names only in a comment is not public either
      assert.deepEqual(rules('- **RDF:** `commentOnlyName` runs.'), ['identifier:commentOnlyName']);
    });

    it('an internal collection or storage name, read from the code and not from a list here', () => {
      assert.deepEqual(rules('- **RDF:** kept in `<space>_zz_planted_store`.'), ['collection:<space>_zz_planted_store']);
      assert.deepEqual(rules('- **RDF:** kept in `zz_planted_store`.'), ['collection:zz_planted_store']);
      assert.deepEqual(rules('- **Brain:** `<space>_embed_jobs` and `_media_jobs`.'), ['collection:<space>_embed_jobs', 'collection:_media_jobs']);
      // the planted name is a string literal in the code too; that does not make it public
      assert.ok(!surfacesOf(planted()).publicNames.has('zz_planted_store'));
    });

    for (const term of MECHANISM_TERMS) {
      it(`the term "${term.name}", with its reason`, () => {
        assert.ok(term.reason.length >= 10, `the term "${term.name}" carries no reason`);
        const found = mechanismsIn(`- **RDF:** a ${term.name} makes it faster.`, surfacesOf(planted())).filter(o => o.rule === 'term');
        assert.equal(found.length, 1, `"${term.name}" was not refused`);
        assert.ok(found[0].why.includes(term.reason));
        // in a code span too
        assert.equal(mechanismsIn(`- **RDF:** the \`${term.name}\` field.`, surfacesOf(planted())).filter(o => o.rule === 'term').length, 1);
      });
    }

    it('the terms do not catch ordinary words they sit inside', () => {
      assert.deepEqual(rules('- **Sync:** a release that follows the release notes; the cut is released.'), []);
    });
  });

  describe('it admits what a reader types or reads, as the code carries it', () => {
    const all = [
      'zz_planted_tool', 'plantedLimit', 'plantedSection.plantedWindowMs', 'ZZ_PLANTED_ENV', 'zz_planted_refused',
      'ythril_zz_planted_total{plantedOutcome}', 'X-Zz-Planted', 'GET /api/zz-planted/:plantedParam',
    ];

    it('a route and its parameter, a tool and its parameter, a config key, an environment variable, a code, a metric, a header', () => {
      assert.deepEqual(rules(entry(...all)), []);
    });

    it('follows a rename in the code with no edit here: the old names are refused, the new ones admitted', () => {
      const renamed = planted({ tool: 'zz_renamed_tool', param: 'renamedLimit', section: 'renamedSection', key: 'renamedWindowMs',
        code: 'zz_renamed_refused', metric: 'ythril_zz_renamed_total', label: 'renamedOutcome', route: 'renamedParam' });
      const old = rules(entry(...all), renamed);
      assert.deepEqual(old.filter(r => r.startsWith('identifier:')).sort(),
        ['identifier:plantedLimit', 'identifier:plantedOutcome', 'identifier:plantedParam', 'identifier:plantedSection', 'identifier:plantedWindowMs',
          'identifier:ythril_zz_planted_total', 'identifier:zz_planted_refused', 'identifier:zz_planted_tool'].sort());
      assert.deepEqual(rules(entry('zz_renamed_tool', 'renamedLimit', 'renamedSection.renamedWindowMs', 'zz_renamed_refused',
        'ythril_zz_renamed_total{renamedOutcome}', 'GET /api/zz-planted/:renamedParam'), renamed), []);
    });

    it('the surfaces are read with the comments out, and a function is not one', () => {
      const { publicNames } = surfacesOf(planted());
      for (const n of ['zz_planted_tool', 'plantedLimit', 'plantedSection', 'plantedWindowMs', 'zz_planted_refused', 'ythril_zz_planted_total', 'plantedOutcome', 'plantedParam']) {
        assert.ok(publicNames.has(n), `${n} is not read as public`);
      }
      for (const n of ['commentOnlyName', 'bufferedThing', 'startPlantedMechanism', 'PlantedMechanismWriter', 'openPlantedMechanismWriter']) {
        assert.ok(!publicNames.has(n), `${n} is read as public`);
      }
    });

    it('refuses to read a tree that does not declare the collections a space owns', () => {
      assert.throws(() => surfacesOf([planted()[1]]), /SPACE_COLLECTIONS/);
      assert.throws(() => surfacesOf([{ file: 'server/src/db/space-collection.ts', text: 'export const SPACE_COLLECTIONS = { facts: \'facts\' } as const;' }]), /floor/);
    });
  });

  describe('which sections it holds', () => {
    it(`[Unreleased] and every release after ${EXEMPT_THROUGH}, and none up to it`, () => {
      const rows = [['[Unreleased]', true], ['[6.5.8]', true], ['[6.6.0]', true], ['[7.0.0]', true], ['[6.5.7]', false], ['[6.5.6]', false],
        ['[6.0.0]', false], ['[5.9.9]', false], ['Earlier releases', false]];
      for (const [name, held] of rows) assert.equal(holdsMechanismRule(name), held, name);
    });

    it('an offence in a held section is reported with its line, one in an exempt section is not looked at', () => {
      const text = ['# Changelog', '## [Unreleased]', '### Added', '- **RDF:** a journal.', '## [6.5.7] — 2026-11-27', '- **RDF:** a journal.',
        '## [6.6.0] — 2026-12-01', '- **RDF:** a bitmap.', '## Earlier releases', '- a journal'].join('\n');
      const found = changelogMechanisms(text, surfacesOf(planted()));
      assert.deepEqual(found.map(o => [o.section, o.n, o.found]), [['[Unreleased]', 4, 'journal'], ['[6.6.0]', 8, 'bitmap']]);
      assert.match(describeMechanisms(found), /CHANGELOG\.md:4 {2}\[Unreleased\] {2}"journal" is a write log/);
    });
  });

  describe('over this checkout', () => {
    const surfaces = codeSurfaces();
    const text = readFileSync('CHANGELOG.md', 'utf8');

    it('reads the code well enough to mean something (the derivation works)', () => {
      assert.ok(surfaces.publicNames.size >= 3000, `only ${surfaces.publicNames.size} public names were read`);
      assert.ok(surfaces.collectionSuffixes.size >= 15, `only ${surfaces.collectionSuffixes.size} collections were read`);
      // the two examples the ticket names
      for (const c of ['rdf_quads', 'schema_snapshots']) {
        assert.ok(surfaces.collectionSuffixes.has(c) && !surfaces.publicNames.has(c), `${c} is not read as an internal collection`);
      }
    });

    it('refuses the entries the ticket names: the collections of the triple index and of the schema versions', () => {
      const found = mechanismsIn('- **RDF:** a triple index (`<space>_rdf_terms`, `_rdf_quads`) and `<space>_schema_snapshots`.', surfaces);
      assert.deepEqual(found.filter(o => o.rule === 'collection').map(o => o.found).sort(),
        ['<space>_rdf_terms', '<space>_schema_snapshots', '_rdf_quads'].sort());
      assert.ok(found.some(o => o.rule === 'term' && o.found === 'triple index'));
    });

    it('holds over every entry of [Unreleased] and of any release after the last exempt one', () => {
      const offences = changelogMechanisms(text, surfaces);
      assert.ok(/^## \[Unreleased\]/m.test(text), '`## [Unreleased]` is missing');
      assert.equal(offences.length, 0, describeMechanisms(offences));
    });
  });
});
