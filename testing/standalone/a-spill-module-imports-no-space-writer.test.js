/**
 * The modules that keep a read result that did not fit import nothing that writes a space.
 *
 * ## The defect (Q-92)
 *
 * `brain/graph-spill.ts` imported `writeFile` from `files/files.js` and `upsertFileMeta` from
 * `files/file-meta.js`, so a recall — a READ, reachable with `knowledge: read` — wrote a blob, a `<space>_files`
 * record, a seq bump that synced the record to every peer, and an embed job. The spill now lives in the
 * instance store (`brain/read-spill-store.ts`), and this gate holds both modules to never reaching back.
 *
 * ## What it checks, and the scope it does NOT claim
 *
 * Direct imports of the two modules that build and store a spill. It does not claim "no read door writes a
 * space" — that whole-surface gate needs closure roots and alias-aware writer detection, and is its own ticket.
 * The title says what the body reads.
 *
 * ## The writer set is DERIVED, never listed
 *
 * - every tracked module under `server/src/files/` whose code performs a write — a Mongo mutator or a
 *   filesystem write — because that directory IS a space's file store;
 * - whichever module EXPORTS `bumpSeq`, `enqueueEmbedJob`, `upsertFileMeta` and `writeFile`, found by their
 *   declarations rather than by a path that moves.
 *
 * A floor is asserted on what was found, and the known writers must be IN it, so a pattern that stopped
 * matching cannot hand the loop an empty set. Comments are stripped before matching in both directions: a
 * docblock explaining why `upsertFileMeta` is gone must not fail the gate, and a commented-out import must not
 * pass it.
 *
 * Run: node --test testing/standalone/a-spill-module-imports-no-space-writer.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const SUBJECTS = ['server/src/brain/graph-spill.ts', 'server/src/brain/read-spill-store.ts'];

/** The functions whose defining module is a space writer wherever it lives. */
const WRITER_FUNCTIONS = ['bumpSeq', 'enqueueEmbedJob', 'upsertFileMeta', 'writeFile'];

const code = (f) => stripComments(readFileSync(f, 'utf8'));

/** A write, in the two vocabularies a space is written in. Built fresh per call: no shared /g state. */
const writesSomething = (src) =>
  /\.\s*(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|bulkWrite|findOneAndUpdate|findOneAndReplace|findOneAndDelete)\s*\(/.test(src)
  || /\b(writeFile|writeFileSync|appendFile|rename|renameSync|rm|rmSync|unlink|unlinkSync|copyFile|createWriteStream|writeStored|mkdirPrivate\w*)\s*\(/.test(src);

function writerModules() {
  const all = trackedSources('server/src', { floor: 300 });
  const writers = new Set(
    all.filter(f => f.startsWith('server/src/files/')).filter(f => writesSomething(code(f))),
  );
  const definers = {};
  for (const fn of WRITER_FUNCTIONS) {
    const declared = new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\s*[(<]`);
    definers[fn] = all.filter(f => declared.test(code(f)));
    for (const f of definers[fn]) writers.add(f);
  }
  /*
   * Closed over imports INSIDE `files/`: `delete-cascade.ts` and `store-file.ts` write only through the modules
   * above, so a pattern over their own text calls them readers. Over-inclusion is the safe direction for a gate
   * that says "must not import" — a subject has no business importing any of them.
   */
  const inFiles = all.filter(f => f.startsWith('server/src/files/'));
  for (let grew = true; grew;) {
    grew = false;
    for (const f of inFiles) {
      if (!writers.has(f) && importsOf(f).some(m => writers.has(m))) { writers.add(f); grew = true; }
    }
  }
  return { writers, definers };
}

/** Every module a source imports, statically or dynamically, resolved to a repo path. */
function importsOf(file) {
  const src = code(file);
  const specs = [
    ...[...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map(m => m[1]),
    ...[...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]),
    ...[...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map(m => m[1]),
  ];
  return specs
    .filter(s => s.startsWith('.'))
    .map(s => posix.normalize(posix.join(dirname(file).replace(/\\/g, '/'), s)).replace(/\.js$/, '.ts'));
}

describe('the spill modules import no space writer', () => {
  const { writers, definers } = writerModules();

  it('the writer set is found, and holds the writers this defect was made of', () => {
    for (const fn of WRITER_FUNCTIONS) {
      assert.ok(definers[fn].length >= 1, `no module declares \`${fn}\` — the derivation stopped matching`);
    }
    assert.ok(writers.size >= 8, `only ${writers.size} writer module(s) derived — the scan is broken, not the code`);
    assert.ok([...writers].some(f => f.startsWith('server/src/files/') && !definers.writeFile.includes(f)
      && !definers.upsertFileMeta.includes(f)),
      'the files/ scan found nothing beyond the named definers, so the write pattern is not matching');
  });

  for (const subject of SUBJECTS) {
    it(`${subject} exists and reaches no writer by import`, () => {
      assert.ok(existsSync(subject), `${subject} is missing — a gate over an absent subject passes about nothing`);
      const reached = importsOf(subject).filter(m => writers.has(m));
      assert.deepEqual(reached, [],
        `${subject} imports a space writer: ${reached.join(', ')} — a search that can reach it can change a space`);
    });

    it(`${subject} names no writer function, whatever it imports it from`, () => {
      if (!existsSync(subject)) assert.fail(`${subject} is missing`);
      const src = code(subject);
      const named = WRITER_FUNCTIONS.filter(fn => new RegExp(`\\b${fn}\\b`).test(src));
      assert.deepEqual(named, [],
        `${subject} mentions ${named.join(', ')} in its code — a re-export would bring the writer back under a new path`);
    });
  }
});
