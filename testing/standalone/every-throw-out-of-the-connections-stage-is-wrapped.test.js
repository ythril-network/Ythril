/**
 * Every throw out of the connections stage AFTER the record was written is wrapped, so no door answers it as
 * though nothing had happened (`Q-170`, design 8).
 *
 * ## The rule
 *
 * A write that takes `link*` and `edges` stores the record first and applies the connections after it
 * (`applyConnections` — a relationship needs both ends and the `from` is what was just minted). What can fail
 * there — the writer's second planning run refusing in the window, a commit-time edge failure, a store failure,
 * the links half — fails with the record ALREADY STORED. Answered as an ordinary 400/422/500 it tells the caller
 * "your write was refused", and they retry, which creates a duplicate or loses the edges. So every such throw
 * leaves `applyConnections` as ONE class, `ConnectionsNotWritten`, carrying what was written (`written`) and why
 * (`cause`), and the two shared mappers (`app.ts`'s global handler and `mcp/call-tool.ts`'s catch) answer it as what
 * it is: the cause's status, `written`, and not retryable.
 *
 * ## What is asserted, over what
 *
 *  - **There is ONE post-write path.** The doors are DERIVED (`_edge-accepting-sources.mjs`, every file that accepts
 *    `edges` however it spells that) and none of them writes a link or an edge itself — `reconcileLinks(` and
 *    `upsertEdge(` belong to `applyConnections`. A door that did would be a second post-write path, and a throw out of
 *    it would reach the caller unwrapped however well the first was wrapped.
 *  - **That path wraps.** `applyConnections`' body catches and throws `ConnectionsNotWritten`, and the class exists
 *    once, with `written` and `cause`.
 *  - **Both mappers know the class.** Derived: the file holding the global express error handler and the file
 *    exporting `callTool`. A mapper that did not would answer a stored record as a server fault.
 *
 * ## Seen red
 *
 * Red on c6bb1aa0: `ConnectionsNotWritten` does not exist and `applyConnections` has no catch. The ONE-PATH case is
 * green today by design (no door writes a link or edge itself); its mutation is below. Mutations the implementer must
 * run, restoring by hand: replace the wrapping `throw new ConnectionsNotWritten(` in `applyConnections` with a bare
 * rethrow; drop `instanceof ConnectionsNotWritten` from either mapper; add a `upsertEdge(` call to a door file
 * (e.g. `api/brain/facts.ts`).
 *
 * Run: node --test testing/standalone/every-throw-out-of-the-connections-stage-is-wrapped.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources } from './_sources.mjs';
import { bodyOf, balancedFrom } from './_structural-window.mjs';
import { inlineEdgeDoorFiles, serverSource } from './_edge-accepting-sources.mjs';

const WRAPPER = 'ConnectionsNotWritten';

/** The comment-stripped sources of every server file matching `re`, as `{ file, src }`. */
function serverFilesWith(re) {
  return trackedSources('server/src', { floor: 100, untracked: true })
    .map(file => ({ file, src: serverSource(file) }))
    .filter(f => re.test(f.src));
}

describe('the connections stage after the record write has one path', () => {
  it('the doors that accept edges are found at all (floor)', () => {
    const doors = inlineEdgeDoorFiles();
    assert.ok(doors.length >= 9, `only ${doors.length} door(s) found — every case below passes over an empty set`);
  });

  it('no door writes a link or an edge itself — only applyConnections does', () => {
    const offenders = [];
    for (const file of inlineEdgeDoorFiles()) {
      const src = serverSource(file);
      for (const m of src.matchAll(/(?<![.\w])(?:reconcileLinks|upsertEdge)\(/g)) offenders.push(`${file}: ${m[0]}`);
    }
    assert.deepEqual(offenders, [],
      'these write links or edges outside applyConnections, so a throw out of them is not wrapped as '
      + `${WRAPPER} however well applyConnections wraps its own: ` + offenders.join(', '));
  });
});

describe('applyConnections wraps every throw as ConnectionsNotWritten', () => {
  it('the class is declared once, and carries what was written and why', () => {
    const homes = serverFilesWith(new RegExp(String.raw`\bclass ${WRAPPER}\b`));
    assert.equal(homes.length, 1,
      `${WRAPPER} is declared in ${homes.length} file(s) — the connections stage has no class to wrap its failures in`);
    const { src } = homes[0];
    const at = src.search(new RegExp(String.raw`\bclass ${WRAPPER}\b`));
    const classBody = balancedFrom(src, src.indexOf('{', at), `the ${WRAPPER} body`);
    for (const field of ['written', 'cause']) {
      assert.match(classBody, new RegExp(String.raw`\b${field}\b`),
        `${WRAPPER} does not carry \`${field}\` — the answer cannot say what was stored or why the rest was not`);
    }
  });

  it('applyConnections catches and rethrows as that class', () => {
    const body = bodyOf(serverSource('server/src/brain/write-connections.ts'), 'applyConnections');
    const catchAt = body.search(/\bcatch\b/);
    assert.notEqual(catchAt, -1,
      'applyConnections has no catch, so whatever fails after the record was stored reaches the door as an ordinary '
      + 'refusal or a 500 — a caller told "not written" about a record that is');
    assert.match(body.slice(catchAt), new RegExp(String.raw`throw new ${WRAPPER}\(`),
      `applyConnections catches but does not throw ${WRAPPER}`);
  });
});

describe('both shared mappers answer ConnectionsNotWritten as what it is', () => {
  const mappers = [
    { what: 'the global express error handler', re: /app\.use\(\(err\b/ },
    { what: 'the MCP callTool dispatch', re: /export async function callTool\(/ },
  ];
  for (const { what, re } of mappers) {
    it(`${what} maps it`, () => {
      const homes = serverFilesWith(re);
      assert.equal(homes.length, 1, `found ${homes.length} file(s) for ${what} — re-point this gate`);
      assert.match(homes[0].src, new RegExp(String.raw`\binstanceof ${WRAPPER}\b`),
        `${homes[0].file} (${what}) does not map ${WRAPPER}, so a stored record is answered as a plain failure`);
    });
  }
});
