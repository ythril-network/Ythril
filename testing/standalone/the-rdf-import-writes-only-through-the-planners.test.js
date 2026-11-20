/**
 * The RDF import writes only through the write planners and the commit, and its copies of the link classes stay the store's (bundle-270
 * slice S6, plan section 6 "No bypass").
 *
 * ## What it prevents
 *
 * An import that reached a collection, the arrival writer or the bulk writer directly would land records no planner judged: no schema check,
 * no stamp, no seq, no embed job, no write gate per unit, and a stranger's file is exactly what those stand against. The bulk writer keeps
 * the rest of a batch when an item fails, which an all-or-nothing import must never do; the arrival writer is a restore's. So no module of the
 * import (every tracked server source whose path names the RDF import) imports `db/mongo`, `sync/arrivals` or `brain/bulk`, and the import's
 * modules exist where the doors name them.
 *
 * The translator keeps its own table of which record kinds hold link rows (it is pure and may not import the store's module); the table must
 * stay the store's (`brain/link-adjacency.ts`, `LINK_CLASSES`) with files aside, or a link the store holds is refused as having no class.
 *
 * Run: node --test testing/standalone/the-rdf-import-writes-only-through-the-planners.test.js (pure; the link table case needs server/dist)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';

const FORBIDDEN = [/\bdb\/mongo(\.js)?['"]/, /\bsync\/arrivals(\.js)?['"]/, /\bbrain\/bulk(\.js)?['"]/];
const IMPORT_MODULE = /(^|\/)(rdf-import[^/]*|import-(spool|index|reasons)|quads-to-ops)\.ts$/;
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('the RDF import writes only through the planners', () => {
  const sources = readTrackedSources(SERVER_CODE_ROOTS, { ext: ['.ts'], floor: 100 }).filter(s => IMPORT_MODULE.test(s.file));

  it('the act and its doors are modules of the import', () => {
    const files = sources.map(s => s.file);
    for (const f of ['server/src/spaces/rdf-import-act.ts', 'server/src/api/brain/rdf-import.ts', 'server/src/mcp/tools/rdf-import.ts']) {
      assert.ok(files.includes(f), `${f} is a tracked module of the import (found: ${files.join(', ')})`);
    }
  });

  it('no module of the import imports the store, the arrival writer or the bulk writer', () => {
    const offenders = [];
    for (const { file, text } of sources) {
      const imports = stripComments(text).split('\n').filter(l => /\bfrom\s+['"]|import\(\s*['"]/.test(l));
      for (const line of imports) if (FORBIDDEN.some(re => re.test(line))) offenders.push(`${file}: ${line.trim()}`);
    }
    assert.deepEqual(offenders, []);
  });

  it('the translator\'s link classes are the store\'s, files aside', async () => {
    const { LINKS_HELD } = await import('../../server/dist/rdf/quads-to-ops.js');
    const { LINK_CLASSES } = await import('../../server/dist/brain/link-adjacency.js');
    assert.ok(LINKS_HELD, 'quads-to-ops exports its table of link classes');
    const store = {};
    for (const c of LINK_CLASSES) if (c.kind !== 'file' && c.toKind !== 'file') (store[c.kind] ??= []).push(c.toKind);
    const mine = Object.fromEntries(Object.entries(LINKS_HELD).map(([k, v]) => [k, [...v].sort()]));
    assert.deepEqual(mine, Object.fromEntries(Object.entries(store).map(([k, v]) => [k, v.sort()])));
  });
});
