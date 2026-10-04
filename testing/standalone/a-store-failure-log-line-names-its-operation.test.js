/**
 * The log line a store failure writes names the operation it failed, on every door that writes one (bundle-30 I15,
 * preship-3 P3-4).
 *
 * ## The defect
 *
 * `storeFailureAnswer` writes the operator's line — `Store-side failure answered 503 (<operation>): <driver text>` —
 * and the operation was optional. I13 passed it from one door, a route's own catch (`sendCaughtFailure`); the read
 * helper behind the edge and link reference checks (`sendReadFailure`), the app's error handler and the MCP dispatcher
 * (`callTool`) passed nothing, so a store failure there left a line naming no route and no tool, while the guide said
 * the line "names the route when a route answered it".
 *
 * ## What is asserted
 *
 * - Every call of `storeFailureAnswer` in the server, read out of every tracked source, passes the operation — so a
 *   door added next year cannot leave it out by omission. (The parameter is required in the signature too; this holds
 *   it against a cast or an `undefined`.)
 * - The read helper's line, driven with a store failure, carries the operation its caller named.
 *
 * Run: node --test testing/standalone/a-store-failure-log-line-names-its-operation.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { argumentsOf } from './_structural-window.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const { MongoNetworkError } = createRequire(path.resolve('server/package.json'))('mongodb');

describe('a store failure\'s log line names its operation', () => {
  it('every call of storeFailureAnswer passes the operation it failed', () => {
    const calls = [];
    for (const f of trackedSources('server/src')) {
      const code = blankComments(readFileSync(path.join(REPO_ROOT, f), 'utf8'));
      // Every call; the declaration (`function storeFailureAnswer(`) is not one.
      for (const m of code.matchAll(/(?<!function\s+)\bstoreFailureAnswer\(/g)) {
        const args = argumentsOf(code, m.index + m[0].length - 1, `${f} storeFailureAnswer`);
        calls.push({ at: `${f}:${code.slice(0, m.index).split('\n').length}`, args });
      }
    }
    // The doors known to write the line: a route's catch, the read helper, the app handler, the MCP dispatcher.
    assert.ok(calls.length >= 4, `only ${calls.length} calls of storeFailureAnswer found — the derivation looks in the wrong place`);
    const unnamed = calls.filter(c => c.args.length < 2 || /^(?:undefined|null|''|"")$/.test(c.args[1])).map(c => c.at);
    assert.deepEqual(unnamed, [], 'these write a store failure\'s log line naming no operation, so an operator cannot tell what failed');
  });

  it('the read helper\'s line carries the operation its caller named', async () => {
    const { sendReadFailure } = await import('../../server/dist/api/brain/_read-failure.js');
    const res = { code: 0, headers: {}, status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k] = v; return this; }, json() { return this; } };
    const where = 'POST /api/brain/spaces/probe/edges';
    const { lines } = await logLinesDuring(() =>
      sendReadFailure(res, where, new MongoNetworkError('connection 3 to 10.9.9.9:27017 closed')));
    assert.equal(res.code, 503, 'the store failure was not answered as the store\'s');
    const line = lines.find(l => l.includes('Store-side failure answered 503'));
    assert.ok(line, `no store-failure line was written: ${JSON.stringify(lines)}`);
    assert.ok(line.includes(`(${where})`), `the line names no operation: ${line}`);
  });
});
