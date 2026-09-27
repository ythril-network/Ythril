/**
 * A server module that works with the files tree reads and writes stored bytes only through
 * `files/stored-bytes.ts` (F-43).
 *
 * ## Why this is a gate and not a review note
 *
 * With a master secret the bytes on disk are ciphertext. A raw `fs.readFile` of a stored file does not fail — it
 * returns the envelope, which a caller then indexes, serves or pushes to a peer as the file's content. A raw
 * `fs.writeFile` does not fail either: it stores plaintext in a tree the posture reports as encrypted, and skips the
 * path lock the background pass depends on. Both are silent, which is the whole reason the door exists.
 *
 * ## What it looks at, derived rather than listed
 *
 * Every tracked server source that NAMES the files tree — the sandbox resolvers, a space's files root, the upload
 * staging root — is in scope, whatever it is called and whenever it was written. In those, a raw CONTENT call
 * (read, write, append, open, a read or write stream, truncate, copy) is refused. Metadata calls — `stat`,
 * `readdir`, `rename`, `rm`, `mkdir` — are allowed: they move or describe a file without reading what is in it.
 * Comments are blanked first, so the sentence explaining the rule cannot satisfy or trip it.
 *
 * Out of scope by the same derivation, correctly: the media embedders, whose raw reads and writes are ffmpeg's
 * scratch files in the OS temp directory, and the state-file loader, which has its own at-rest envelope.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const DOOR = 'server/src/files/stored-bytes.ts';

/** The spellings that say a module works with the files tree or the staging area. */
const NAMES_THE_TREE = /resolveSafePath|\bspaceRoot\(|resolveFilePath|'\.chunks'|path\.(?:join|resolve)\([^)]*, 'files'[,)]/;

const CONTENT_FNS = 'readFile|writeFile|appendFile|createReadStream|createWriteStream|open|truncate|copyFile|cp';
/** `fs.readFile(`, `fsp.writeFile(`, `fs.promises.open(`, and the Sync forms. Built fresh per use: it is global. */
const qualifiedCall = () => new RegExp(`\\b(?:fs|fsp|fsSync|promises)\\.(?:${CONTENT_FNS})(?:Sync)?\\(`, 'g');

/** Content functions imported BY NAME from an fs module, so a bare `readFile(` is the raw one. */
function importedContentFns(src) {
  const names = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(?:node:)?fs(?:\/promises)?'/g)) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (new RegExp(`^(?:${CONTENT_FNS})(?:Sync)?$`).test(orig)) names.push(alias ?? orig);
    }
  }
  return names;
}

describe('stored bytes are read and written only through the file door', () => {
  const inScope = readTrackedSources('server/src', { floor: 100, exclude: [DOOR], specs: false })
    .filter(s => NAMES_THE_TREE.test(s.text));

  it('found the modules that work with the files tree', () => {
    // A floor on what the derivation found, by identity: an empty or truncated set passes the sweep below having
    // looked at nothing. These are the tree's three oldest readers, not the list the sweep checks.
    const found = inScope.map(s => s.file);
    for (const f of ['server/src/files/files.ts', 'server/src/sync/file-sync.ts', 'server/src/files/media/worker.ts']) {
      assert.ok(found.includes(f), `${f} was not found by the derivation, so the pattern no longer matches how the tree is named`);
    }
  });

  it('none of them reads or writes file contents with raw fs', () => {
    const raw = [];
    for (const { file, text } of inScope) {
      const src = blankComments(text);   // positions kept, so a reported line is the file's own line
      const lines = text.split('\n');
      const lineOf = (i) => src.slice(0, i).split('\n').length;
      for (const m of src.matchAll(qualifiedCall())) raw.push(`${file}:${lineOf(m.index)}  ${lines[lineOf(m.index) - 1].trim()}`);
      for (const name of importedContentFns(src)) {
        for (const m of src.matchAll(new RegExp(`(?<![.\\w])${name}\\(`, 'g'))) {
          raw.push(`${file}:${lineOf(m.index)}  ${lines[lineOf(m.index) - 1].trim()}`);
        }
      }
    }
    assert.deepEqual(raw, [], 'these touch stored bytes around the file door, so with a master secret they read '
      + 'ciphertext as content or write plaintext into an encrypted tree. Use readStored / openStoredRead / '
      + `writeStored / pipeToStored from ${DOOR}:\n  ` + raw.join('\n  '));
  });
});
