/**
 * Every audit entry carries the request id, and it is captured where the context actually exists.
 *
 * ## The defect this pins
 *
 * Every log line a request's own work produces carries its `X-Request-Id`. The audit entry for the same request
 * carried the actor, the operation, the status and the duration — and nothing that connected it to those lines.
 * So "show me everything about this request" was two searches that could not be joined: the audit row says WHAT
 * was done and by whom, the log lines say what happened on the way.
 *
 * ## The trap, which was measured rather than assumed
 *
 * **An EventEmitter listener is not bound to the async context it was registered in** — `emit` runs it in the
 * emitter's context. Probed directly: a listener registered inside an `AsyncLocalStorage.run` and fired on a
 * later tick reads `undefined`. The request middleware's audit write happens in `res.on('finish')`, so a version
 * calling `currentRequestId()` *inside* that callback would store nothing on every entry **while looking exactly
 * like the correct code**. That is the whole reason this file asserts WHERE the read happens and not merely that
 * the field is set.
 *
 * The other two writers — the auth-failure entry and the MCP tool-call recorder — run synchronously inside the
 * request, so they read it directly. Three writers, two correct shapes, and the difference is not visible from
 * the field name.
 *
 * Run: node --test testing/standalone/audit-entries-join-the-log.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom, blockAfter } from './_structural-window.mjs';
import { dispatchSource } from './_tool-dispatch.mjs';

const MW = stripComments(readFileSync('server/src/audit/middleware.ts', 'utf8'));
const AUDIT = stripComments(readFileSync('server/src/audit/audit.ts', 'utf8'));
// The tool-call audit entry is written by the shared dispatch, not by either door — so this reads the
// dispatch through `_tool-dispatch.mjs` rather than naming a file that has already moved once.
const MCP = dispatchSource();
const API = stripComments(readFileSync('server/src/api/audit.ts', 'utf8'));

describe('all three writers carry it', () => {
  it('the request middleware captures it OUTSIDE the finish callback', () => {
    /*
     * The load-bearing assertion. `res.on('finish')` does not inherit the context, so the read has to happen in
     * the middleware body — and a version that moved it inside would pass any check that only looked for the
     * field being present in the call.
     */
    const at = MW.indexOf('const requestId = currentRequestId()');
    assert.ok(at > -1, 'the middleware does not capture the request id at all');
    const finishAt = MW.indexOf("res.on('finish'");
    assert.ok(finishAt > -1, 're-anchor this gate: the finish hook is gone');
    assert.ok(at < finishAt,
      'the id is read inside the finish callback, which does not inherit the async context — it will be '
      + 'undefined on every entry while looking correct');

    // And the callback USES the captured value rather than re-reading it.
    const cb = balancedFrom(MW, MW.indexOf('{', finishAt), 'the finish callback');
    assert.match(cb, /requestId,/, 'the finish callback does not pass the captured id to the audit write');
    assert.doesNotMatch(cb, /currentRequestId\(\)/,
      'the finish callback calls currentRequestId() itself, which returns undefined there');
  });

  it('the auth-failure writer carries it', () => {
    // Where it matters most: a rejected credential is the thing an operator most wants to trace line by line.
    const at = MW.indexOf('export function logAuthFailure');
    assert.ok(at > -1, 're-anchor this gate');
    const body = blockAfter(MW, at, 'logAuthFailure');
    assert.match(body, /requestId: currentRequestId\(\)/,
      'a failed auth attempt records no request id, so it cannot be traced to its log lines');
  });

  it('the MCP tool-call recorder carries it', () => {
    // MCP is where "which request produced this line" is hardest to answer by eye, because a model makes many
    // calls quickly — so an unjoinable audit row there is the least recoverable of the three.
    const at = MCP.indexOf('function recordToolCall');
    assert.ok(at > -1, 're-anchor this gate');
    const body = blockAfter(MCP, at, 'recordToolCall');
    assert.match(body, /requestId: currentRequestId\(\)/, 'an MCP tool call records no request id');
  });
});

describe('absent means "written before the field existed", not "no request"', () => {
  it('the write OMITS the key rather than storing null', () => {
    /*
     * Same rule `changes` follows. A stored `null` would claim the request had no id, which cannot happen — every
     * request is given one — so an absent KEY is the only honest way to mark a row that predates the field.
     */
    const at = AUDIT.indexOf('export function logAuditEntry');
    assert.ok(at > -1, 're-anchor this gate');
    const body = blockAfter(AUDIT, at, 'logAuditEntry');
    assert.match(body, /\.\.\.\(input\.requestId \? \{ requestId: input\.requestId \} : \{\}\)/,
      'the write stores the id unconditionally, so a row with no id claims the request had none');
  });

  it('the stored type makes it optional, and says why', () => {
    // The interface moved to `audit/entry.ts` when the god-file ratchet refused a one-line addition to the
    // config types — see that file's header. The assertion follows the declaration.
    const types = readFileSync('server/src/audit/entry.ts', 'utf8');
    const at = types.indexOf('export interface AuditLogEntry');
    assert.ok(at > -1, 're-anchor this gate');
    /*
     * Whitespace NORMALISED before matching. The first version asserted the phrase on one line and failed on a
     * comment that says exactly the right thing wrapped across two — an assertion about prose that was really an
     * assertion about where the line broke, which is the same class as bounding a subject by a character count.
     */
    const decl = types.slice(at, types.indexOf('\n}', at));
    const prose = decl.replace(/\s*\n\s*\*?\s*/g, ' ');
    assert.match(decl, /requestId\?: string;/, 'the field must be optional — older rows do not have it');
    assert.match(prose, /never "no request"|not "no request"/,
      'the declaration must say what an absent value means, or a reader will take it as "none"');
  });
});

describe('it can be searched for, on both reads', () => {
  it('the filter reaches the query', () => {
    // Storing an id nobody can query by would leave an operator holding a bug report paging a filtered log.
    assert.match(AUDIT, /if \(params\.requestId\) filter\.requestId = params\.requestId;/,
      'the request id is stored but not filterable');
  });

  it('the route parses it, so the export gets it too', () => {
    /*
     * One `paramsFrom` feeds the paged endpoint and the NDJSON export, and both build their filter from
     * `buildAuditFilter` — so parsing it once covers both. Asserted because that sharing is the reason no second
     * change was needed, and a future split would silently drop it from one of them.
     */
    assert.match(API, /requestId: str\('requestId'\)/, 'the route drops the requestId query parameter');
    assert.match(API, /streamAuditEntries\(paramsFrom\(|streamAuditEntries\(/,
      're-anchor this gate: the export no longer shares the parsed params');
  });
});
