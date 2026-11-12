/**
 * The schema snapshot fetch is a leg of the member's turn of its own, placed after the push leg and before the files leg, and every request it makes carries
 * `transferInit(requestInit)` and not the control plane's own init (bundle-265, Q-738; design 3.3 step 4 and the leg paragraph, R-N2, R-N5).
 *
 * ## What each half prevents
 *
 * - **The leg.** `runSpaceExchange` names the leg it is in (`let leg = 'receive'`, then `leg = 'push'`, `leg = 'files'`) so that a throw is attributed to the
 *   right one (`turnThrowIsOurs`). A fetch run under `push` would report this server's own store fault as the push to the peer failing: the member would
 *   be counted down for a fault that is ours. The fetch is its own leg, `'schema-snapshot'`, assigned before its call and after the push leg's.
 * - **The init.** `peerSafeFetch` takes `init.signal ?? AbortSignal.timeout(opts.timeoutMs)`: an explicit signal wins over the budget beside it, and the
 *   engine's request init carries the control plane's ten-second one. A snapshot is up to 10 MiB. `peer-fetch.ts` records that passing the control init to
 *   a transfer made `PEER_TRANSFER_TIMEOUT_MS` dead code and aborted every slow body for ever. The behaviour is driven in
 *   `a-schema-snapshot-is-fetched-from-its-sender-db` (a peer that answers after eleven seconds); this reads the source, so the rule is held where the
 *   request is made and not only where one case drives it.
 *
 * ## How the set is found
 *
 * Never listed: the sites are the server sources whose code (comments out) names `/api/sync/schema-snapshot`, found by walking `server/src`. The floor
 * is one site, so an empty walk cannot pass. Both rules are proven on planted sources below, which are literal.
 *
 * ## Seen red
 *
 * At ce37b83a no source names the route and `space-exchange.ts` has no such leg: the floor case and the leg case fail.
 *
 * Run: node --test testing/standalone/the-schema-snapshot-fetch-is-its-own-leg-and-uses-the-transfer-init.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const ROOT = new URL('../../', import.meta.url);
const SRC = new URL('server/src/', ROOT);

/** The order in which a source assigns its legs, and where `call(` first appears, as `{ legs: [name...], callAt: <index in legs> }`. */
function legsAround(code, call) {
  const events = [];
  for (const m of code.matchAll(/\bleg\s*=\s*'([a-z-]+)'/g)) events.push({ at: m.index, leg: m[1] });
  const callAt = code.indexOf(call);
  const before = events.filter(e => callAt >= 0 && e.at < callAt);
  const after = events.filter(e => callAt >= 0 && e.at > callAt);
  return { legBefore: before.at(-1)?.leg, legAfter: after[0]?.leg, called: callAt >= 0 };
}

/** The argument text of every call of `name(` in `code`, by balanced parentheses. */
function argsOfCalls(code, name) {
  const out = [];
  for (const m of code.matchAll(new RegExp(`\\b${name}\\(`, 'g'))) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) { if (code[i] === '(') depth++; else if (code[i] === ')') depth--; }
    out.push(code.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

const legProblem = (code) => {
  const { legBefore, legAfter, called } = legsAround(code, 'fetchOwedSchemaSnapshots(');
  if (!called) return 'fetchOwedSchemaSnapshots is not called here';
  if (legBefore !== 'schema-snapshot') return `the fetch is called under leg '${legBefore}', not 'schema-snapshot'`;
  if (legAfter !== 'files') return `the leg after the fetch is '${legAfter}', not 'files'`;
  const before = [...code.matchAll(/\bleg\s*=\s*'([a-z-]+)'/g)].map(m => m[1]);
  if (before.indexOf('push') < 0 || before.indexOf('push') > before.indexOf('schema-snapshot')) return 'the schema-snapshot leg does not come after the push leg';
  return null;
};

const initProblems = (code) => argsOfCalls(code, 'peerSafeFetch').filter(args => !/\btransferInit\(/.test(args));

describe('the gate recognises the two rules on planted sources', () => {
  const exchange = (middle) => `let leg = 'receive';\nleg = 'push';\npush();\n${middle}\nleg = 'files';\nfiles();\n`;

  it('accepts a fetch under its own leg between the push leg and the files leg', () => {
    assert.equal(legProblem(exchange(`leg = 'schema-snapshot';\nawait fetchOwedSchemaSnapshots({ member });`)), null);
  });

  it('refuses a fetch under the push leg, a fetch after the files leg began, and no fetch at all', () => {
    assert.match(legProblem(exchange(`await fetchOwedSchemaSnapshots({ member });`)), /under leg 'push'/);
    assert.match(legProblem(`let leg = 'receive';\nleg = 'push';\nleg = 'schema-snapshot';\nleg = 'files';\nawait fetchOwedSchemaSnapshots({});\n`), /under leg 'files'/);
    assert.match(legProblem(exchange('')), /not called here/);
  });

  it('refuses a schema-snapshot leg that comes before the push leg', () => {
    assert.match(legProblem(`let leg = 'receive';\nleg = 'schema-snapshot';\nawait fetchOwedSchemaSnapshots({});\nleg = 'push';\nleg = 'files';\n`), /the leg after the fetch is 'push', not 'files'/);
  });

  it('accepts a request with the transfer init and refuses one with the control plane\'s', () => {
    assert.deepEqual(initProblems(`await peerSafeFetch(url, { ...transferInit(requestInit), signal: turnSignal(undefined, turn) });`), []);
    assert.equal(initProblems(`await peerSafeFetch(url, { ...requestInit, signal });`).length, 1);
    assert.equal(initProblems(`await peerSafeFetch(url, requestInit);\nawait peerSafeFetch(u2, transferInit(requestInit));`).length, 1);
  });

  it('does not read a call named in a comment', () => {
    assert.deepEqual(initProblems(stripComments(`// peerSafeFetch(url, requestInit)\nawait peerSafeFetch(url, transferInit(i));`)), []);
  });
});

describe('the repository', () => {
  const sources = readdirSync(SRC, { recursive: true }).map(String).filter(f => f.endsWith('.ts')).map(f => ({ file: f.replace(/\\/g, '/'), code: stripComments(readFileSync(new URL(f, SRC), 'utf8')) }));
  const sites = sources.filter(s => s.code.includes('/api/sync/schema-snapshot'));

  it('found the source that fetches the route (a derivation that finds nothing would pass every case below)', () => {
    assert.ok(sites.length >= 1, `no server source names /api/sync/schema-snapshot in code (read ${sources.length} files): the receiver does not exist yet`);
  });

  it('every request the fetch makes is made with transferInit(requestInit)', () => {
    assert.ok(sites.length >= 1, 'no source fetches the route, so there is no request whose init could be judged');
    const bad = sites.flatMap(s => initProblems(s.code).map(a => `${s.file}: peerSafeFetch(${a.replace(/\s+/g, ' ').slice(0, 80)})`));
    assert.deepEqual(bad, []);
    assert.ok(sites.every(s => argsOfCalls(s.code, 'peerSafeFetch').length >= 1), 'a source that names the route makes no peerSafeFetch of its own: the request goes somewhere this gate does not read');
  });

  it('the member\'s turn runs the fetch as its own leg between the push leg and the files leg', () => {
    const exchange = sources.find(s => s.file === 'sync/space-exchange.ts');
    assert.ok(exchange, 'sync/space-exchange.ts is gone: re-anchor this gate on the file that names the legs');
    assert.equal(legProblem(exchange.code), null, legProblem(exchange.code) ?? '');
  });
});
