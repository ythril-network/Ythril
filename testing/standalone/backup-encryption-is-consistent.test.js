/**
 * Every backup path honours the one encryption setting — enforced structurally, not by memory.
 *
 * The owner's requirement was *"settable on every backup option, infra as well as those in ui ... (consistent)"*,
 * and the risk is entirely in that last word: **an opt-in present on three of five paths is worse than none,
 * because the operator believes it is on.** Encryption you think you enabled is the failure mode this guards.
 *
 * It is affordable to guard because there is ONE choke point. `dumpDatabase` writes every backup and
 * `restoreDatabase` reads every one. So the gate is: nobody produces a backup any other way, and every caller
 * of the choke point passes the setting.
 *
 * Comments are stripped before matching. Six gates in this repo have fired on the comment explaining their own
 * fix, and the comments above the call sites below quote the very patterns asserted on.
 */
import { describe, it } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const tracked = () =>
  trackedSources('server/src');

/**
 * Strip comments — carefully, because a naive stripper eats CODE.
 *
 * The first version used `/\/\*[\s\S]*?\*\//g` and silently deleted half of `api/data.ts`: a `/*` inside a
 * string literal (a glob, a cron expression) opens a fake block comment that runs to the next `*​/`, taking the
 * real code with it. The gate then reported that file as having no `dumpDatabase(` call at all — a false PASS
 * on the very assertion it exists to make, which is worse than a false failure.
 *
 * So block comments are only stripped when they START a line, which is true of every doc comment in this
 * codebase and never true of a `/*` inside a string. Line comments already guard against `http://`.
 */
const strip = src => src
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, ' ');

const read = f => strip(readFileSync(`${ROOT}/${f}`, 'utf8'));

/** The only two functions allowed to write or read a backup's record data. */
const WRITER = 'dumpDatabase';
const READER = 'restoreDatabase';

describe('backup encryption is consistent across every path', () => {
  const files = tracked();

  it('found the source to check (guards against a vacuous pass)', () => {
    assert.ok(files.length > 100, `only ${files.length} tracked server files — the glob is wrong`);
    assert.ok(files.includes('server/src/db/dump.ts'));
    assert.ok(files.includes('server/src/db/restore.ts'));
  });

  it('nothing writes a backup except the one choke point', () => {
    // A second writer is how "consistent" quietly stops being true: it would not know about the setting.
    const offenders = files
      .filter(f => f !== 'server/src/db/dump.ts')
      .filter(f => /mongodump|createWriteStream\([^)]*\.ndjson/.test(read(f)));
    assert.deepEqual(offenders, [],
      `these write backup data without going through ${WRITER}(), so they cannot honour the encryption setting:\n  `
      + offenders.join('\n  '));
  });

  // The callers are DERIVED: a hand-written list of them is how a gate goes on checking files that no longer call the writer, and
  // misses the one that started to. Since bundle-157 every backup (scheduled, manual, a migrate's dump) goes through `runBackupNow`,
  // so the floor is one caller; zero would be a vacuous pass.
  const writerCallers = () => files.filter(f => f !== 'server/src/db/dump.ts' && read(f).includes(`${WRITER}(`));

  it('every caller of the writer passes the encryption setting', () => {
    const callers = writerCallers();
    assert.ok(callers.length >= 1, `expected at least 1 caller of ${WRITER}, found ${callers.length}`);

    for (const f of callers) {
      const src = read(f);
      for (const m of src.matchAll(new RegExp(`${WRITER}\\(([^;]*?)\\)\\s*;`, 'gs'))) {
        assert.match(m[1], /encrypt\s*:/,
          `${f} calls ${WRITER}() without an \`encrypt\` option, so that backup silently ignores the setting:\n`
          + `    ${m[0].replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
  });

  it('the setting is one value in one place, not a per-path default', () => {
    // Every caller must read it from the backup config rather than hardcoding a boolean, or two backup paths
    // could disagree about whether a backup is encrypted.
    for (const f of writerCallers()) {
      const src = read(f);
      assert.match(src, /encrypt:\s*(cfg|loadBackupConfig\(\))\??\.?e?n?c?r?y?p?t?/,
        `${f} must derive \`encrypt\` from the backup config, not from a literal`);
      assert.doesNotMatch(src, new RegExp(`${WRITER}\\([^;]*encrypt:\\s*(true|false)\\s*[,}]`, 's'),
        `${f} hardcodes \`encrypt\`, which decouples it from the setting`);
    }
  });

  it('the schema declares the setting, and it defaults to plaintext', () => {
    const cfg = read('server/src/db/backup-config.ts');
    assert.match(cfg, /encrypt:\s*z\.boolean\(\)\.optional\(\)/,
      'backup.json must declare an optional `encrypt` — optional means absent = plaintext');
    // `=== true` at both call sites is what makes absent mean false rather than undefined-ish.
    for (const f of writerCallers()) {
      assert.match(read(f), /encrypt.*===\s*true/s, `${f} must treat an absent setting as plaintext`);
    }
  });

  it('the reader does NOT take a setting — it detects', () => {
    // Deliberate asymmetry: an operator restoring must not have to remember how the dump was written. Encoding
    // it as a flag on restore would reintroduce exactly that.
    const restore = read('server/src/db/restore.ts');
    assert.match(restore, /isEnvelope\(/, `${READER} must detect an envelope per line`);
    assert.doesNotMatch(restore, new RegExp(`export async function ${READER}\\([^)]*encrypt`),
      `${READER} must not take an encryption option — it detects, so a lost manifest still restores`);
  });

  it('the writer refuses to start when encryption is on and no secret is configured', () => {
    // Failing AFTER writing some collections would leave a half-plaintext directory that looks like a backup.
    const dump = read('server/src/db/dump.ts');
    const body = dump.slice(dump.indexOf(`export async function ${WRITER}(`));
    const guardAt = body.indexOf('resolveMasterSecret()');
    const firstWriteAt = body.indexOf('createWriteStream');
    assert.ok(guardAt > 0, 'dumpDatabase must resolve the master secret when encryption is requested');
    assert.ok(firstWriteAt > 0, 'anchor lost: dumpDatabase no longer opens a write stream');
    assert.ok(guardAt < firstWriteAt,
      'the secret must be resolved BEFORE the first file is opened, or a failure leaves a partial backup');

    // Position is not enough, and a mutation proved it: changing the guard to `if (false)` left
    // `resolveMasterSecret()` in the file, above the first write, and this test passed while the guard was
    // dead. Exactly the `@else if (false)` blind spot #662 found in a different gate — so assert the guard is
    // REACHABLE, i.e. conditioned on the option, not on a literal.
    const guardCond = body.slice(0, guardAt).lastIndexOf('if (');
    assert.ok(guardCond > 0, 'the master-secret resolution must sit inside a conditional');
    const cond = body.slice(guardCond, body.indexOf(')', guardCond) + 1);
    assert.match(cond, /if \(\s*opts\.encrypt\s*\)/,
      `the guard must be conditioned on opts.encrypt, not on ${cond} — a literal makes it dead code`);
  });

  it('the key is derived once per dump, not per record', () => {
    // The trap this whole design exists to avoid: encryptEnvelope derives inside every call, so per-record use
    // would run one scrypt (N=16384) per document — hours on a large collection, presenting as a hang.
    const dump = read('server/src/db/dump.ts');
    assert.doesNotMatch(dump, /encryptEnvelope\(/,
      'dumpDatabase must not call encryptEnvelope — it re-derives the key on every call. Use encryptWithKey.');
    const deriveAt = dump.indexOf('deriveKey(');
    const loopAt = dump.indexOf('for await (const doc of cursor)');
    assert.ok(deriveAt > 0 && loopAt > 0, 'anchors lost — re-anchor this gate');
    assert.ok(deriveAt < loopAt, 'deriveKey must be hoisted above the per-document loop');

    const restore = read('server/src/db/restore.ts');
    assert.doesNotMatch(restore, /decryptEnvelope\(/,
      'restoreDatabase must not call decryptEnvelope per line — it re-derives from each envelope\'s own salt. '
      + 'Use deriveKeyForSalt + decryptWithKey.');
  });
});
