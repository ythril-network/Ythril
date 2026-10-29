/**
 * Every function of `files/file-meta.ts` that turns a caller's path into a file row id asks the one door (Q-413).
 *
 * ## What it holds
 *
 * A row stored before bundle-71 under a spelling that is not its key (`files/legacy-file-keys.ts`) is put at its key by the first door that needs the
 * key's row: `fileRowIdFor` for one path, `fileDirPrefixFor` for a directory. A function that spelled `toDocId(path)` itself would be the one lookup that
 * never finds an old row, and nothing would say so.
 *
 *  1. `toDocId(` is spelled only inside the two doors in this file (derived from the source, not listed here).
 *  2. Every exported function whose parameters name a path (`filePath`, `filePaths`, `dirPath`, `dir`, `path`) reaches a door or an adoption: directly
 *     or through a function of the same file it calls. The set is read out of the source.
 *
 * Floors: the source yields at least eight exported path-taking functions and both doors. An empty derivation passes every loop written over it.
 *
 * ## Seen red
 *
 * By mutation: `getFileMeta` made to build its id with `toDocId(filePath)` fails 1 and 2; `fileDirPrefixFor` made to skip its adoption fails 2 for every
 * prefix function. Restored by hand.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE = fs.readFileSync('server/src/files/file-meta.ts', 'utf8').replace(/\r\n/g, '\n');
const DOORS = ['fileRowIdFor', 'fileDirPrefixFor'];
const ADOPTIONS = ['adoptLegacyRow(', 'adoptLegacyRowsUnder('];
const PATH_PARAMS = /\b(filePath|filePaths|dirPath|dir|path)\s*[:?,)]/;

/** The top-level functions of the file: name, whether exported, its parameter list and its body. */
function functionsOf(text) {
  const starts = [...text.matchAll(/^(export )?(async )?function (\w+)\(/gm)];
  return starts.map((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const chunk = text.slice(m.index, end);
    const open = chunk.indexOf('(');
    let depth = 0; let close = open;
    for (; close < chunk.length; close++) { if (chunk[close] === '(') depth++; else if (chunk[close] === ')' && --depth === 0) break; }
    return { name: m[3], exported: m[1] === 'export ', params: chunk.slice(open, close + 1), body: chunk.slice(close + 1) };
  });
}

const fns = functionsOf(SOURCE);
const callsOf = (fn) => fns.filter(o => o.name !== fn.name && new RegExp(`\\b${o.name}\\(`).test(fn.body)).map(o => o.name);

/** Whether `fn` reaches an adoption, directly or through the functions of this file it calls. */
function reachesAdoption(fn, seen = new Set()) {
  if (seen.has(fn.name)) return false;
  seen.add(fn.name);
  if (ADOPTIONS.some(a => fn.body.includes(a))) return true;
  return callsOf(fn).some(n => reachesAdoption(fns.find(o => o.name === n), seen));
}

describe('every file row id comes through one door', () => {
  it('the source yields the two doors and enough path-taking functions (floor)', () => {
    for (const door of DOORS) assert.ok(fns.some(f => f.name === door && f.exported), `file-meta.ts exports no ${door}`);
    const taking = fns.filter(f => f.exported && PATH_PARAMS.test(f.params));
    assert.ok(taking.length >= 8, `only ${taking.length} exported path-taking functions were found: the derivation is broken`);
  });

  it('toDocId is spelled only inside the doors (1)', () => {
    const outside = fns.filter(f => !DOORS.includes(f.name) && /\btoDocId\(/.test(f.body)).map(f => f.name);
    assert.deepEqual(outside, [], `these functions build a row id themselves, so they never find a row stored under a legacy spelling: ${outside}`);
  });

  it('every exported function that takes a path reaches an adoption (2)', () => {
    const missing = fns.filter(f => f.exported && PATH_PARAMS.test(f.params) && !DOORS.includes(f.name) && !reachesAdoption(f)).map(f => f.name);
    assert.deepEqual(missing, [], `these functions take a path and never put a legacy row at its key: ${missing}`);
  });

  it('both doors adopt', () => {
    for (const door of DOORS) assert.ok(reachesAdoption(fns.find(f => f.name === door)), `${door} does not adopt a legacy row`);
  });
});
