/**
 * No log statement in `spaces/search-readiness.ts` interpolates an error's message or a connection URI (Q-113).
 *
 * ## Why this is a gate and not a review comment
 *
 * The watcher probes for as long as the process lives, so every line it writes is written thousands of times and
 * ends up in log aggregation for years. A driver's error message names the infrastructure: a refused connection
 * prints the host and port, a failed authentication prints the URI it tried, and a message that embeds the
 * connection string embeds its credentials. One `${err.message}` in a line that runs every five minutes is a
 * standing leak, and it is the kind of line that reads as helpful in review. The rule is: a line carries the error
 * CLASS and its CODE, which an operator can act on and which name nothing.
 *
 * ## What is derived, and what the one exception is
 *
 * The statements are read out of the file (every `log.<level>(…)` call, bracket-balanced, comments stripped), not
 * listed, and a FLOOR on how many were found is asserted — an empty scan passes every loop written over it. The
 * single exception is the cold-start warning, whose text existed before this module and is kept as it was (it names
 * the rebuild route, which operators search the logs for). It is exempted by its own text, and the gate asserts
 * there is exactly one such statement: an exemption that matches two has started to be a loophole.
 *
 * ## Seen red
 *
 * A temporary `${err.message}` added to the probe-failure debug line fails the "no message" case; the original was
 * put back by hand.
 *
 * Run: node --test testing/standalone/search-readiness-logs-carry-the-class-not-the-message.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom } from './_structural-window.mjs';

const FILE = 'server/src/spaces/search-readiness.ts';

/** Every `log.<level>(…)` call in the file, as { level, args } with `args` the bracketed argument text. */
function logStatements(src) {
  const out = [];
  for (const m of src.matchAll(/\blog\.(debug|info|warn|error)\s*\(/g)) {
    out.push({ level: m[1], args: balancedFrom(src, m.index + m[0].length - 1, `log.${m[1]} at ${m.index}`) });
  }
  return out;
}

describe('the log statements of the search-readiness module', () => {
  assert.ok(existsSync(FILE), `${FILE} does not exist — the module this gate governs has not been written`);
  const src = stripComments(readFileSync(FILE, 'utf8'));
  const statements = logStatements(src);
  const COLD_START = /did not answer after/;
  const governed = statements.filter(s => !COLD_START.test(s.args));

  it('finds them: a scan that finds none would pass every assertion below', () => {
    assert.ok(statements.length >= 4, `only ${statements.length} log statements found — probe, hourly warn, recovery and a failing subscriber each write one`);
    assert.ok(governed.length >= 3, `only ${governed.length} governed statements`);
    for (const level of ['debug', 'info', 'warn']) {
      assert.ok(statements.some(s => s.level === level), `no ${level} statement found — the states each log at one level`);
    }
  });

  it('the cold-start warning is the ONE exemption, and it is exactly one', () => {
    assert.equal(statements.length - governed.length, 1,
      'the exemption is meant for the pre-existing cold-start text alone; more than one match is a loophole');
  });

  it('none interpolates an error message, stack or cause', () => {
    for (const s of governed) {
      assert.doesNotMatch(s.args, /\.(message|stack|cause)\b/, `log.${s.level} interpolates an error's text: ${s.args.slice(0, 200)}`);
    }
  });

  it('none interpolates or stringifies a caught error whole', () => {
    // `${err}` and String(err) are the message by another route (Error#toString is "Name: message").
    for (const s of governed) {
      assert.doesNotMatch(s.args, /\$\{\s*(?:err|error|e|cause|reason)\s*\}/, `log.${s.level} interpolates a caught error: ${s.args.slice(0, 200)}`);
      assert.doesNotMatch(s.args, /String\(\s*(?:err|error|e|cause|reason)\s*\)/, `log.${s.level} stringifies a caught error: ${s.args.slice(0, 200)}`);
      assert.doesNotMatch(s.args, /JSON\.stringify\(\s*(?:err|error|e)\b/, `log.${s.level} serialises a caught error: ${s.args.slice(0, 200)}`);
    }
  });

  it('none names a URI or a connection setting', () => {
    for (const s of governed) {
      assert.doesNotMatch(s.args, /mongodb(?:\+srv)?:\/\/|getMongoUri|MONGO_URI|\buri\b|\bURI\b/,
        `log.${s.level} carries a connection string or names where to find one: ${s.args.slice(0, 200)}`);
    }
  });

  it('and the lines still say WHAT failed: the error class and code are derived, and a line interpolates them', () => {
    // A rule that only forbids would be satisfied by a module that logged nothing useful. The class and the code
    // are what an operator can act on. The derivation may be written inline or in a small helper, so the module is
    // asked for the derivation and the lines are asked for an interpolation, not for one spelling.
    assert.match(src, /\.code\b/, 'the module never reads an error code');
    assert.match(src, /\.name\b|constructor\.name/, 'the module never reads an error class');
    assert.ok(governed.some(s => /\$\{/.test(s.args)), 'no governed statement interpolates anything — the lines cannot say what failed');
  });
});
