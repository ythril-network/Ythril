/**
 * The Linked Data door logs the class of a failure it did not name, never its message (bundle-271, Q-758, review of S3, unproven risk).
 *
 * ## What it prevents
 *
 * `answered()` in `server/src/api/linked-data.ts` catches what no refusal named and answers a bare 500 whose detail says the log has the
 * cause. A store or driver error's message can carry the query it failed on: the address asked for, the record ids around it, a filter value.
 * That text is read off the address of a request any token holder can make, and the log is read by more people than may read the space. So
 * the log line names the route and the error's class (`err.constructor.name`, `err.name`), and no log call of this file prints an error's
 * message or the error itself (`.message`, `.stack`, `String(err)`, a template that interpolates it).
 *
 * ## Seen red
 *
 * On ce62acbbb the line is `log.error(\`${route}: ${err instanceof Error ? err.message : String(err)}\`)`. The rule is proven on planted
 * calls first (each spelling of a message is named, the class is not).
 *
 * Run: node --test testing/standalone/a-linked-data-failure-log-names-the-error-class-only.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './_strip-comments.mjs';
import { argumentsOf } from './_structural-window.mjs';

const FILE = 'server/src/api/linked-data.ts';
/** What prints an error's text: its message or stack, or the error itself turned into a string. */
const PRINTS_THE_ERROR = /\.(?:message|stack)\b|\bString\(\s*(?:err|e|error)\b|\$\{\s*(?:err|e|error)\s*\}/;

/** The calls of `log.error`, `log.warn`, `log.info` and `log.debug` in `src` whose arguments print an error's text. */
function logsOfAnErrorText(src) {
  const bad = [];
  for (const m of stripComments(src).matchAll(/\blog\s*\.\s*(?:error|warn|info|debug)\s*\(/g)) {
    const args = argumentsOf(stripComments(src), m.index + m[0].length - 1, 'a log call').join(', ');
    if (PRINTS_THE_ERROR.test(args)) bad.push(`${m[0]}${args.slice(0, 100)}`);
  }
  return bad;
}

describe('the Linked Data door logs the class of a failure, not its message', () => {
  it('is proven on planted calls: each spelling of an error text is named, a class is not', () => {
    const planted = [
      'log.error(`x: ${err instanceof Error ? err.message : String(err)}`);',
      'log.warn(`x: ${e.message}`);',
      'log.error(`x: ${err.stack}`);',
      'log.error(`x: ${String(err)}`);',
      'log.error(`x: ${err}`);',
    ];
    for (const call of planted) assert.equal(logsOfAnErrorText(call).length, 1, call);
    assert.deepEqual(logsOfAnErrorText('log.error(`x: ${err instanceof Error ? err.constructor.name : typeof err}`);'), [], 'the class is no message');
    assert.deepEqual(logsOfAnErrorText("log.warn(`no row decides '${peerText(path)}'`);"), []);
  });

  it('no log call of the door prints an error\'s text, and the door logs the class of the one it catches', () => {
    const src = readFileSync(join(process.cwd(), FILE), 'utf8');
    assert.deepEqual(logsOfAnErrorText(src), [], `${FILE} logs an error's message: log its class (err.constructor.name) instead`);
    assert.match(stripComments(src), /log\.error\([^;]*\.(?:constructor\.name|name)\b/, 'the catch of answered() logs the error class');
  });

  it('every bound or slot refusal the door sends is logged by its code and status, never by the address (lens-3 O1)', () => {
    const code = stripComments(readFileSync(join(process.cwd(), FILE), 'utf8'));
    const at = code.indexOf('function sendLdRefusal(');
    assert.ok(at > 0, 'the door has no sendLdRefusal: the one place a refusal of a read is answered');
    const body = code.slice(at, code.indexOf('\n}\n', at));
    const warn = /log\.warn\(([^;]*)\);/.exec(body);
    assert.ok(warn, 'sendLdRefusal writes no log line: a refusal at the Linked Data door is silent');
    assert.match(warn[1], /r\.code/, 'the line does not name the code');
    assert.match(warn[1], /r\.status/, 'the line does not name the status');
    assert.doesNotMatch(warn[1], /address|originalUrl|req\b|path/i, 'the line names the address asked for');
    // Every refusal of the act's outcome reaches the one sender: no `sendProblem` answers an outcome's refusal by itself.
    assert.ok(/sendLdRefusal\(res, outcome\.refusal\)/.test(code) && /sendLdRefusal\(res, inUse\.refusal\)/.test(code), 'a refusal of a read is answered outside sendLdRefusal');
  });
});
