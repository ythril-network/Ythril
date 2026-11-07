/**
 * No server code hands the MongoDB driver its client-side timeout: `timeoutMS`, `defaultTimeoutMS` or `timeoutMode`
 * (`Q-716`).
 *
 * ## What it prevents
 *
 * The driver's client-side timeout desynchronised the connection pool after an operation timed out, so one call could receive
 * another caller's documents (CVE-2026-119179, mongodb Node driver 6.11.0 to 7.7.x; reproduced on 7.1.1 with no Ythril
 * code, `Q-715`). From 7.8.0 the three options are accepted and do NOTHING: an operation that carries one is not bounded
 * at all, and only the client-level option warns. So a use of any of them is either the vulnerable path (an older driver)
 * or a bound that silently does not exist (7.8.0 and later). Ythril bounds a call with the server's deadline (`maxTimeMS`)
 * and its own client backstop (`db/write-bound.ts`: `signal`, which closes the connection), never with these.
 *
 * ## What it reads
 *
 * Every tracked `.ts` under `server/src`, as a syntax tree, so a comment or a sentence in a log message that NAMES the
 * option is not a use. A use is the option's name as an identifier or property name (`{ timeoutMS: 5 }`, `o.timeoutMS`,
 * `defaultTimeoutMS`), or as a string key (`o['timeoutMode']`, `{ 'timeoutMS': 5 }`). `maxTimeMS`, `socketTimeoutMS`,
 * `connectTimeoutMS`, `serverSelectionTimeoutMS`, `waitQueueTimeoutMS` and `wtimeoutMS` are other options and are not
 * matched. The detector is held on samples, so a mutation of the scan fails here and not only on the repository.
 *
 * Run: node --test testing/standalone/no-server-code-uses-the-drivers-client-timeout.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { lineOf, parseSource, ts } from '../_shared/syntax-tree.mjs';

const OPTIONS = new Set(['timeoutMS', 'defaultTimeoutMS', 'timeoutMode']);

/** Every use of one of the driver's client-side timeout options in `text`: `{ line, name }`. */
export function clientTimeoutUses(file, text) {
  const sf = parseSource(file, text);
  const uses = [];
  const visit = (node) => {
    const keyed = ts.isStringLiteral(node) && node.parent
      && ((ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)
        || (ts.isPropertyAssignment(node.parent) && node.parent.name === node));
    if ((ts.isIdentifier(node) || keyed) && OPTIONS.has(node.text)) uses.push({ line: lineOf(sf, node), name: node.text });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return uses;
}

describe('clientTimeoutUses (the detector, held on samples)', () => {
  it('finds each option as an object key, a property read, an element key and a quoted key', () => {
    const text = [
      'const a = { timeoutMS: 5 };',
      'const b = s.startSession({ defaultTimeoutMS: 9 });',
      'const c = o.timeoutMS;',
      "const d = o['timeoutMode'];",
      "const e = { 'timeoutMS': 1 };",
    ].join('\n');
    assert.deepEqual(clientTimeoutUses('x.ts', text).map(u => `${u.line}:${u.name}`),
      ['1:timeoutMS', '2:defaultTimeoutMS', '3:timeoutMS', '4:timeoutMode', '5:timeoutMS']);
  });
  it('does not take the other timeout options, a comment or a sentence that names the option', () => {
    const text = [
      'const a = { maxTimeMS: 1, socketTimeoutMS: 2, connectTimeoutMS: 3, serverSelectionTimeoutMS: 4, waitQueueTimeoutMS: 5, wtimeoutMS: 6 };',
      '// timeoutMS: no longer used',
      "log.warn('timeoutMS in MONGO_URI has no effect');",
      'const msg = `the timeoutMode option`;',
    ].join('\n');
    assert.deepEqual(clientTimeoutUses('x.ts', text), []);
  });
});

describe('no server code uses the driver\'s client-side timeout', () => {
  const files = trackedSources(['server/src'], { floor: 300, untracked: true });

  it('the scan reads enough to mean something (a floor on the files read)', () => {
    assert.ok(files.length >= 300, `only ${files.length} files under server/src were read: the scan is reading the tree wrongly`);
  });

  it('no file passes timeoutMS, defaultTimeoutMS or timeoutMode', () => {
    const found = [];
    for (const file of files) {
      for (const u of clientTimeoutUses(file, readFileSync(join(REPO_ROOT, file), 'utf8'))) found.push(`${file}:${u.line} ${u.name}`);
    }
    assert.deepEqual(found, [],
      `${found.length} use(s) of the driver's client-side timeout: ${found.join(', ')}. It desynchronised the pool on drivers before `
      + '7.8.0 (CVE-2026-119179) and does nothing from 7.8.0, so the call it was meant to bound is not bounded. Bound the call with '
      + 'the server\'s deadline (maxTimeMS) and the client backstop of db/write-bound.ts (signal), as every bounded call is.');
  });
});
