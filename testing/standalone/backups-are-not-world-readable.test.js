/**
 * A database dump is the whole database in plaintext. Treat it that way, and say so.
 *
 * ## The finding — Privacy audit lens
 *
 * `02-hosting.md` has a section titled **Encryption at Rest**. It is scoped correctly in its own text — four state
 * files — and it recommends an encrypted `mongod` for brain data. An operator who does all of that has, reasonably,
 * concluded their data at rest is protected.
 *
 * A backup bypasses the whole arrangement. `dumpDatabase` reads **through** `mongod`, so the NDJSON that lands in
 * `<data-root>/backups/` is **decrypted**: every memory, entity, edge, chrono entry, file-meta record and audit
 * entry, in the clear, on the same volume. `requireEncryptedAtRest` does not touch it. Nothing said so.
 *
 * And the permissions were inverted with respect to sensitivity: the four state files have always been written
 * `0600`, while the dump directory was created with `mkdirSync(dir, { recursive: true })` — default `0755`, files
 * `0644`. **The least sensitive thing on the volume was the best protected.** The offsite copy, which additionally
 * contains every uploaded file verbatim, was the same.
 *
 * ## What this gate holds
 *
 * The modes, and the fact that the docs admit the gap. It cannot check the deeper question — whether dumps should be
 * *encrypted* — because that is a live trade-off parked for the owner: encrypting them with the master key makes a
 * backup unrestorable without that key, which is either the point or a foot-gun depending on why it was taken.
 *
 * Run: node --test testing/standalone/backups-are-not-world-readable.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bodyOf, enclosingBlockAround } from './_structural-window.mjs';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Every directory-creating call in a file, normalised to one line.
 *
 * Both idioms are collected: the raw `fs.mkdirSync(…)`/`fs.mkdir(…)` that has to carry a mode itself, and the
 * `mkdirPrivateSync`/`mkdirPrivate` helper that carries it for the caller. A file that uses the helper everywhere
 * has no raw call left to check, which is the point — one definition rather than a mode repeated at nine sites.
 */
function rawMkdirsIn(src) {
  return [...src.matchAll(/(?:await\s+)?fsp?\.mkdir(?:Sync)?\(([^;]*?)\);/gs)]
    .map(m => m[1].replace(/\s+/g, ' ').trim());
}

/** Files that put user data or database contents on disk, and must all be as tight as `config.json`. */
const WRITERS = [
  ['server/src/db/dump.ts', 'a decrypted NDJSON copy of the whole database'],
  ['server/src/db/offsite.ts', 'the same dump, plus every uploaded file verbatim'],
  // The one door every uploaded document's bytes go through, whole or mid-upload (F-43). `files.ts` and `chunks.ts`
  // stay listed for the directories they create; the bytes themselves are written only by the door.
  ['server/src/files/stored-bytes.ts', 'every uploaded document, whole or mid-upload'],
  ['server/src/files/files.ts', 'the directories uploaded documents live in'],
  ['server/src/files/chunks.ts', 'the directories uploads are staged in'],
];

describe('one definition of "as tight as the state files"', () => {
  const modes = read('server/src/util/fs-modes.ts');

  it('the helper exists and its constants are owner-only', () => {
    // Everything below is worthless if these two numbers drift, and a number is the easiest thing in the world to
    // relax by one digit while reviewing something else.
    assert.match(modes, /export const FILE_MODE = 0o600;/, 'FILE_MODE must be 0o600 — what config.json has always been');
    assert.match(modes, /export const DIR_MODE = 0o700;/, 'DIR_MODE must be 0o700 — a directory needs x to be traversable');
  });

  it('the helper re-applies the mode, so an upgrade heals instead of needing a tree walk', () => {
    // `mode:` only applies at CREATION. Without the chmod, an instance that already has files keeps them 0644
    // forever, and a recursive chmod at boot is exactly the expensive migration that gets skipped.
    assert.match(modes, /chmodSync\(target, mode\)/, 'hardenSync must chmod the target');
    assert.match(modes, /chmod\(target, mode\)/, 'harden must chmod the target');
    for (const fn of ['mkdirPrivateSync', 'mkdirPrivate']) {
      assert.match(bodyOf(modes, fn), /harden(Sync)?\(dir, DIR_MODE\)/,
        `${fn} must tighten a directory that already existed, not only one it creates`);
    }
  });

  it('every chmod is best-effort, so a non-POSIX host cannot fail a write', () => {
    // Windows and plenty of network shares (SMB, some NFS exports) ignore POSIX modes. Hardening must never turn a
    // working upload or backup into a failed one — the mode is a tightening, not a precondition.
    for (const m of modes.matchAll(/chmod(?:Sync)?\([^)]*\)/g)) {
      // The block the chmod is IN, including the line that opened it — which is where `try` lives. The version this
      // replaces read 140 characters behind and 40 ahead, so a `try` one statement further up read as absent.
      const around = enclosingBlockAround(modes, m.index, `the guard around ${m[0]}`);
      assert.match(around, /try\s*\{|catch/, `${m[0]} is not guarded`);
    }
  });
});

describe('nothing that holds user data is written with default permissions', () => {
  it('found the writers — the parse still matches', () => {
    // Without this, a rename would reduce every sweep below to zero files and they would all pass having examined
    // nothing: the failure mode every coverage gate in this repo has had at least once.
    for (const [file] of WRITERS) {
      assert.ok(read(file).length > 200, `${file} is missing or empty`);
    }
  });

  it('every directory is created owner-only', () => {
    const loose = [];
    for (const [file, holds] of WRITERS) {
      const src = read(file);
      for (const call of rawMkdirsIn(src)) {
        // A raw mkdir is fine only if it states the mode itself; otherwise it must go through the helper.
        if (!/mode:\s*(0o700|DIR_MODE)/.test(call)) loose.push(`${file} (${holds}): fs.mkdir(${call})`);
      }
    }
    assert.deepEqual(loose, [], 'these create a directory holding user data or database contents with default '
      + 'permissions, typically 0755:\n  ' + loose.join('\n  '));
  });

  it('every file is written owner-only', () => {
    // The directory mode is not enough: an operator may point a path at a directory that already exists, and
    // `cpSync` preserves SOURCE file modes — so the file mode is what actually travels offsite.
    const loose = [];
    for (const [file, holds] of WRITERS) {
      const src = read(file);
      const writes = [
        ...[...src.matchAll(/createWriteStream\(([^;]*?)\);/gs)].map(m => ['createWriteStream', m[1]]),
        ...[...src.matchAll(/(?:await\s+)?fsp?\.writeFile\(([^;]*?)\);/gs)].map(m => ['writeFile', m[1]]),
      ];
      for (const [kind, args] of writes) {
        const one = args.replace(/\s+/g, ' ').trim();
        if (!/mode:\s*(0o600|FILE_MODE)/.test(one)) loose.push(`${file} (${holds}): ${kind}(${one})`);
      }
    }
    assert.deepEqual(loose, [], 'these write user data or database contents with default permissions, typically '
      + '0644 — readable by every other user on the host:\n  ' + loose.join('\n  '));
  });

  it('an overwrite is tightened too, not only a creation', () => {
    // A resumed upload and an edited file both OVERWRITE, and `mode:` does nothing then. Each writer of a
    // potentially-existing file has to chmod as well — this is what makes the change self-healing on upgrade.
    // The door renames a temp file into place, and a rename carries the TEMP file's mode — so the chmod after the
    // rename is what tightens an overwrite, and it has to be in the function every write finishes through.
    assert.match(bodyOf(read('server/src/files/stored-bytes.ts'), 'finishWrite'), /harden\(abs, FILE_MODE\)/,
      'the file door renames without chmodding, so files that predate hardening stay 0644 forever');
  });
});

describe('the docs admit what encryption at rest does not cover', () => {
  it('the admin API says a dump is unencrypted and not covered by the flag', () => {
    const doc = read('docs/integration-guide/12-admin-api.md');
    assert.match(doc, /unencrypted copy of everything/i,
      'the backup endpoint must say the dump is unencrypted');
    // ADJACENCY CLAIM, not a window: `.` does not match a newline, so this asserts the flag and the disclaimer
    // are on ONE LINE of prose. That is the rule — a page that names the flag and admits the gap forty lines
    // apart has not corrected the assumption, which is the whole point of the sentence.
    // AN ADJACENCY CLAIM, not a window, and the number IS the rule: `.` crosses no newline, so this asserts
    // the flag and the disclaimer sit in ONE SENTENCE. That is the requirement — a page mentioning
    // `requireEncryptedAtRest` in one paragraph and "does not cover it" three paragraphs later has told the
    // reader nothing about the relationship between them. Widening the gap would break the check.
    assert.match(doc, /requireEncryptedAtRest.{0,40}does not cover it/i,
      'it must say explicitly that the at-rest flag does not cover a dump — that is the assumption being corrected');
    assert.match(doc, /decrypted/i,
      'it must explain WHY: the dump reads through mongod, so an encrypted mongod does not help');
  });

  it('the Encryption at Rest section scopes itself', () => {
    // The section was accurate and its TITLE was broader than its content. A reader who stops at the heading is the
    // one this is for.
    // Its own page since the section outgrew the hosting page (F-43), so the section is the whole page.
    const doc = read('docs/integration-guide/02a-encryption-at-rest.md');
    const at = doc.indexOf('## Encryption at Rest');
    assert.ok(at > 0, 'the Encryption at Rest page lost its heading');
    const section = doc.slice(at);
    assert.match(section, /does NOT cover/,
      'the section must state what it does not cover — database backups and brain data in MongoDB');
    const notCovered = section.slice(section.indexOf('does NOT cover'));
    assert.match(notCovered, /backups/i, 'backups must be named among the exclusions');
    assert.match(notCovered, /MongoDB/, 'brain data in MongoDB must be named among the exclusions');
    // Uploaded files moved from the exclusions to the coverage in F-43, and saying so is the half a reader relies on.
    assert.match(section.slice(0, section.indexOf('does NOT cover')), /uploaded files/i,
      'the section must say uploaded files ARE covered');
  });
});
