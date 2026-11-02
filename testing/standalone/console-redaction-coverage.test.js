/**
 * Nothing writes an error object straight to the console, bypassing redaction.
 *
 * `log.*` redacts — Bearer tokens, URL userinfo, credential-bearing query params. `console.*` does not.
 * So a `console.error('...', err)` sitting beside a redacted `log.error` is not belt and braces; it is
 * the braces quietly undoing the belt, and it is the copy that matters: **stdout is what a container log
 * collector captures**, while the ring buffer is read by whoever thinks to open the logs page.
 *
 * That is exactly what the crash handlers did — the one path most likely to be holding a URL, because an
 * unhandled fetch rejection quotes the endpoint it failed on.
 *
 * Static console output (a startup banner, a listening address) is fine and stays. What must never
 * happen again is an *error value* reaching the console unredacted.
 *
 * Run: node --test testing/standalone/console-redaction-coverage.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { balancedFrom } from './_structural-window.mjs';

const ROOT = 'server/src';

/** Every .ts file under server/src, excluding tests. */
function sources(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) { sources(p, out); continue; }
    if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * A console call is suspicious when it passes a bare error-ish identifier.
 *
 * Deliberately narrow: `console.log('listening on ...')` is not a problem and never was. The risk is an
 * `Error`, a rejection reason, or a caught exception — the values that carry a stack, a URL and, if you
 * are unlucky, a credential inside it.
 */
const SUSPICIOUS = /console\.(?:error|warn|log|info|debug)\([^)]*(?<![\w.$])(?:err|error|reason|e|ex|exception)(?![\w$])/;

describe('console output cannot bypass the redactor', () => {
  const files = sources();

  it('finds the source tree', () => {
    assert.ok(files.length > 50, `expected a populated source tree, got ${files.length} files`);
  });

  it('no console call passes a raw error value', () => {
    const offenders = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Comments talk ABOUT console calls — including the ones explaining this very rule.
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        if (!SUSPICIOUS.test(line)) return;
        // Redacted is fine — that is the whole point.
        if (line.includes('redactSecrets(')) return;
        offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepEqual(offenders, [],
      'these write an error value to the console without redaction — stdout is what the log collector ' +
      'captures, so this defeats the redaction that log.* applies:\n' + offenders.join('\n'));
  });

  it('the crash handlers specifically go through redactSecrets', () => {
    // Named explicitly because they are the highest-risk path (an unhandled fetch rejection quotes the
    // endpoint) and because a future refactor is most likely to "simplify" them back.
    const src = readFileSync(`${ROOT}/index.ts`, 'utf8');
    for (const handler of ['unhandledRejection', 'uncaughtException']) {
      // The whole registration, bounded by the paren that closes it. At 400 characters this covered both handlers
      // as they are written today, so `uncaughtException` was being checked twice and its own body never bounded.
      const at = src.indexOf(`process.on('${handler}'`);
      assert.ok(at > 0, `${handler} handler should exist`);
      const block = balancedFrom(src, at, `the ${handler} handler`);
      assert.ok(block.includes('redactSecrets('), `${handler} must redact before writing to the console`);
    }
  });

  it('the redactor is actually exported for them to use', () => {
    // Defined once with the rest of the text rules in `@ythril/schema` (`schema/src/text.ts`) and handed on by `util/log.ts`.
    const textSrc = readFileSync(`${ROOT}/../../schema/src/text.ts`, 'utf8');
    assert.match(textSrc, /export function redactSecrets/);
    const logSrc = readFileSync(`${ROOT}/util/log.ts`, 'utf8');
    assert.match(logSrc, /export\s*\{[^}]*\bredactSecrets\b[^}]*\}\s*from\s*'@ythril\/schema\/internal'/);
  });
});
