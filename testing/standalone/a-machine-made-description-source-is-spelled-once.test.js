/**
 * "Which descriptions did a machine make" is answered from ONE list, and no second spelling of it exists in the server
 * (`Q-433`, plan rev 4 item 20, `data-integrity S9`).
 *
 * ## What it prevents
 *
 * `descriptionSource` is `generated` or `extracted` when this instance made the description from the bytes, and absent
 * when a person wrote it. Everything that treats a description as a person's — the delete that strips a machine-made one,
 * the stray-metadata fill that lets a publisher's human words replace it, and now the file-stamp report that decides
 * whether a description was "edited here" — asks that one question. It was spelled as `['generated', 'extracted']` in a
 * Mongo `$in` in one module, as the same array under another name in a second, as a zod enum on the wire, and as a union
 * type: four copies, each correct until a third source exists, and then three of four are wrong in a different way and
 * nothing says which. A stamp report that read a fifth would have been wrong silently (a description marked with the new
 * source would read as a person's, and the row as "edited here").
 *
 * ## The rule
 *
 * `MACHINE_MADE_SOURCES` — a readonly tuple, exported by one module (`files/derived-fields.ts`) — and `isMachineMadeSource`
 * beside it are the only places the two words are listed together: the predicate, the Mongo `$in`, the aggregation `$in`,
 * the zod enum on the wire and the TypeScript type all READ the tuple. This file derives that module from the source (the one
 * that exports the tuple), then sweeps the server for any other file that lists the two sources together — as an array or an
 * enum, as a union type, or as a chain of `||` comparisons.
 *
 * The enum still refuses a value outside the list (the wire is the strictest consumer), and accepts every value inside it.
 *
 * ## Seen red
 *
 * Against the tree before the fold: the tuple does not exist, and four files spell the pair. The detector is itself held by
 * planted copies of each spelling, so a regex edited into silence fails here instead of reporting a clean sweep.
 *
 * Run: node --test testing/standalone/a-machine-made-description-source-is-spelled-once.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

/** The most files this sweep may find fewer than: the server is far larger, so a short list means the listing broke. */
const SERVER_FLOOR = 300;

const Q = `['"\`]`;
/** The three spellings that list the two sources together: an array or enum, a union, a chain of comparisons. */
const PAIR_SPELLINGS = [
  ['an array or an enum', new RegExp(`${Q}generated${Q}\\s*,\\s*${Q}extracted${Q}|${Q}extracted${Q}\\s*,\\s*${Q}generated${Q}`)],
  ['a union type', new RegExp(`${Q}generated${Q}\\s*\\|\\s*${Q}extracted${Q}|${Q}extracted${Q}\\s*\\|\\s*${Q}generated${Q}`)],
  ['a chain of comparisons', new RegExp(`===\\s*${Q}generated${Q}\\s*\\|\\|[^;\\n]*===\\s*${Q}extracted${Q}|===\\s*${Q}extracted${Q}\\s*\\|\\|[^;\\n]*===\\s*${Q}generated${Q}`)],
];

/** `[{ file, spelling }]` for every place in `sources` (comments blanked) that lists the two together. */
export function pairSpellings(sources) {
  const out = [];
  for (const { file, text } of sources) {
    const code = blankComments(text);
    for (const [spelling, re] of PAIR_SPELLINGS) if (re.test(code)) out.push({ file, spelling });
  }
  return out;
}

/** The file(s) that export the tuple, found in the source rather than named. */
const definers = (sources) => sources
  .filter(({ text }) => /export\s+const\s+MACHINE_MADE_SOURCES\b/.test(blankComments(text)))
  .map(s => s.file);

const server = () => readTrackedSources('server/src', { untracked: true, floor: SERVER_FLOOR });

describe('the machine-made description sources are one list', () => {
  it('exactly one module exports MACHINE_MADE_SOURCES, and it is where the predicate and the tuple live together', () => {
    const where = definers(server());
    assert.equal(where.length, 1, `MACHINE_MADE_SOURCES is exported by ${where.length} module(s): ${where.join(', ') || 'none'} — the one source of "which descriptions a machine made" does not exist`);
    const text = blankComments(server().find(s => s.file === where[0]).text);
    assert.match(text, /export\s+(?:function|const)\s+isMachineMadeSource\b/, `${where[0]} exports the tuple but not the predicate that reads it: every caller would write its own \`includes\``);
  });

  it('no other server file lists the two sources together, in any spelling', () => {
    const sources = server();
    const [one] = definers(sources);
    const copies = pairSpellings(sources).filter(c => c.file !== one);
    assert.deepEqual(copies.map(c => `${c.file} (${c.spelling})`), [],
      'a second spelling of the machine-made sources: import MACHINE_MADE_SOURCES / isMachineMadeSource (or the type derived from the tuple) '
      + 'instead — a third source added to one copy and not the others is a description read as a person\'s');
  });

  it('the tuple is the list itself: readonly, in the dist, and the predicate agrees with it for every value', async () => {
    const { MACHINE_MADE_SOURCES, isMachineMadeSource } = await import('../../server/dist/files/derived-fields.js');
    assert.ok(Array.isArray(MACHINE_MADE_SOURCES) && Object.isFrozen(MACHINE_MADE_SOURCES), 'MACHINE_MADE_SOURCES is not a frozen tuple');
    assert.ok(MACHINE_MADE_SOURCES.length >= 2);
    for (const v of MACHINE_MADE_SOURCES) assert.equal(isMachineMadeSource(v), true, `${v} is in the tuple and the predicate refuses it`);
    for (const v of ['person', 'typed', '', 'GENERATED', undefined, null, 5, {}]) assert.equal(isMachineMadeSource(v), false, `${JSON.stringify(v)} is not machine-made`);
  });

  it('the wire schema accepts every machine-made source and refuses a value outside the list', async () => {
    const { MACHINE_MADE_SOURCES } = await import('../../server/dist/files/derived-fields.js');
    const { IncomingFileMetaDoc } = await import('../../server/dist/api/sync/_shared.js');
    const at = '2026-09-01T00:00:00.000Z';
    const doc = (extra = {}) => ({ _id: 'a.txt', spaceId: 's', path: 'a.txt', author: { instanceId: 'i', instanceLabel: 'l' }, createdAt: at, updatedAt: at, seq: 1, ...extra });
    assert.equal(IncomingFileMetaDoc.safeParse(doc()).success, true, 'the control: a document with no description source is not accepted by this fixture');
    for (const v of MACHINE_MADE_SOURCES) {
      assert.equal(IncomingFileMetaDoc.safeParse(doc({ description: 'd', descriptionSource: v })).success, true, `the wire refuses ${v}, which is machine-made`);
    }
    for (const v of ['person', 'typed', '', 'GENERATED']) {
      assert.equal(IncomingFileMetaDoc.safeParse(doc({ description: 'd', descriptionSource: v })).success, false, `the wire accepts ${JSON.stringify(v)}, which is not a machine-made source`);
    }
  });
});

describe('the sweep sees what it claims to', () => {
  const planted = (text) => pairSpellings([{ file: 'server/src/planted.ts', text }]).map(c => c.spelling);

  it('it finds each spelling of the pair, in either order, in any quotes', () => {
    assert.deepEqual(planted(`const A = ['generated', 'extracted'];`), ['an array or an enum']);
    assert.deepEqual(planted(`const A = ["extracted", "generated"];`), ['an array or an enum']);
    assert.deepEqual(planted(`z.enum(['generated','extracted']).optional()`), ['an array or an enum']);
    assert.deepEqual(planted(`descriptionSource?: 'generated' | 'extracted';`), ['a union type']);
    assert.deepEqual(planted(`let s: 'extracted' | 'generated' | undefined;`), ['a union type']);
    assert.deepEqual(planted(`if (s === 'generated' || s === 'extracted') return true;`), ['a chain of comparisons']);
  });

  it('it does not find a mention of one source, a comment, or two unrelated strings', () => {
    assert.deepEqual(planted(`const source = 'generated';`), []);
    assert.deepEqual(planted(`// descriptionSource is 'generated', 'extracted' or absent\nconst x = 1;`), []);
    assert.deepEqual(planted(`/* 'generated' | 'extracted' */ const y = 2;`), []);
    assert.deepEqual(planted(`log('generated'); log('other', 'extracted');`), []);
  });

  it('a planted copy outside the one module is reported, and the one module is not', () => {
    const sources = [
      { file: 'server/src/files/derived-fields.ts', text: `export const MACHINE_MADE_SOURCES = Object.freeze(['generated', 'extracted'] as const);\nexport function isMachineMadeSource(v: unknown) { return MACHINE_MADE_SOURCES.includes(v as never); }` },
      { file: 'server/src/sync/planted.ts', text: `const MINE = ['generated', 'extracted'];` },
    ];
    const [one] = definers(sources);
    assert.equal(one, 'server/src/files/derived-fields.ts');
    assert.deepEqual(pairSpellings(sources).filter(c => c.file !== one).map(c => c.file), ['server/src/sync/planted.ts']);
  });
});
