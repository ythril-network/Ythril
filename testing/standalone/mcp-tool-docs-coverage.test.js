/**
 * The documented split of MCP tools into mutating / read-only matches what the code enforces.
 *
 * Slice 4c of the pre-release documentation audit — the security-posture class. The doc tells an
 * integrator exactly which tools a `readOnly` token loses, and the enforcement reads a `mutating` flag
 * on each tool definition. Those are two independent lists of the same fact, which is the shape that
 * drifts.
 *
 * Both directions are a real problem, and one is much worse than the other:
 *
 *   - a tool flagged `mutating` in code but missing from the doc's list — the doc under-states what a
 *     read-only token loses, so an integrator plans around a tool that will not be there;
 *   - a tool listed as READ-ONLY that the code flags mutating — the doc says a call works when it is
 *     actually blocked;
 *   - a tool listed as mutating that is NOT flagged — the worst of the three: the doc claims a write
 *     is blocked for read-only tokens when nothing blocks it. Someone hands out a read-only token
 *     believing it cannot write.
 *
 * The enforcement itself is belt-and-braces and pins here too: `router.ts` both filters the tool out
 * of `tools/list` and rejects it if called directly. Only the second is a security control; the first
 * is discoverability.
 *
 * Run: node --test testing/standalone/mcp-tool-docs-coverage.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readGuide } from './_docs.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const TOOLS_DIR = join(ROOT, 'server', 'src', 'mcp', 'tools');

function fromCode() {
  const all = new Set();
  const mutating = new Set();
  for (const f of readdirSync(TOOLS_DIR).filter(n => n.endsWith('.ts'))) {
    const src = readFileSync(join(TOOLS_DIR, f), 'utf8');
    // Walk name/mutating markers in order and attach each `mutating: true` to the nearest preceding
    // tool name — tool definitions are object literals, so order is the association.
    let current = null;
    for (const m of src.matchAll(/name:\s*'([a-z_0-9]+)'|mutating:\s*true/g)) {
      if (m[1]) { current = m[1]; all.add(current); }
      else if (current) mutating.add(current);
    }
  }
  return { all, mutating };
}

function fromDocs() {
  const guide = readGuide();
  const line = guide.split(/\r?\n/).find(l => l.includes('mutating tools (') && l.includes('readOnly'));
  assert.ok(line, 'expected the integration guide to describe what a readOnly token loses');

  // Both lists live on the SAME line ("mutating tools (…) … Read-only tools (…) work normally"), so
  // each must be read from its own parenthetical. Taking every backticked name off the line captures
  // all 31 tools and reports the read-only ones as errors.
  const clause = (marker) => {
    const i = line.indexOf(marker);
    if (i < 0) return new Set();
    return new Set([...line.slice(i).split(')')[0].matchAll(/`([a-z_0-9]+)`/g)].map(m => m[1]));
  };
  return { mutating: clause('mutating tools ('), readOnly: clause('Read-only tools (') };
}

describe('MCP tool read-only classification matches the docs', () => {
  const code = fromCode();
  const docs = fromDocs();

  it('parses both sides (the check itself works)', () => {
    assert.ok(code.all.size >= 25, `expected to find the MCP tools, found ${code.all.size}`);
    assert.ok(code.mutating.size >= 10, `expected mutating tools, found ${code.mutating.size}`);
    assert.ok(docs.mutating.size >= 10, `expected a documented mutating list, found ${docs.mutating.size}`);
  });

  it('every tool the code blocks for read-only tokens is documented as mutating', () => {
    const missing = [...code.mutating].filter(t => !docs.mutating.has(t)).sort();
    assert.deepEqual(missing, [],
      'These tools are blocked for readOnly tokens but the integration guide does not list them, so ' +
      'an integrator would plan around a tool that will not be there.');
  });

  it('every tool documented as mutating is actually flagged mutating', () => {
    // The dangerous direction: the doc promises a write is blocked when nothing blocks it.
    const overstated = [...docs.mutating].filter(t => !code.mutating.has(t)).sort();
    assert.deepEqual(overstated, [],
      'The guide lists these as blocked for readOnly tokens, but no `mutating: true` flag backs that ' +
      'up — a read-only token could call them.');
  });

  it('no tool documented as read-only is actually blocked', () => {
    const wrong = [...docs.readOnly].filter(t => code.mutating.has(t)).sort();
    assert.deepEqual(wrong, [],
      'The guide says these work normally with a readOnly token, but the code flags them mutating.');
  });

  it('the enforcement both hides AND rejects, from ONE predicate — only the second is the control', () => {
    // Filtering `tools/list` is discoverability; a client can still call a tool it was not shown, so the
    // call-time rejection is what actually enforces it. Both halves must exist.
    //
    // What changed: they used to be the expression `readOnly && t.mutating` written out separately in each
    // place — and in `help.ts` a third time, under a comment claiming it was one source of truth. They are
    // now one function, so this asserts SHARING rather than two matching regexes. Two regexes could both
    // pass while the expressions had drifted, which is exactly the state they were in.
    /*
     * THE TWO HALVES NOW LIVE IN TWO FILES, and that is the change rather than a relocation.
     *
     * The LISTING is per connection and belongs to the MCP door — it is what `tools/list` advertises. The
     * REJECTION is per call and belongs to `callTool`, which both doors dispatch through, so the HTTP door
     * gets it without having a listing at all. Asserting them together is still one assertion about one
     * predicate: what must hold is that the advisory half and the enforcing half are the SAME function.
     */
    const router = readFileSync(join(ROOT, 'server', 'src', 'mcp', 'router.ts'), 'utf8');
    const dispatch = readFileSync(join(ROOT, 'server', 'src', 'mcp', 'call-tool.ts'), 'utf8');
    assert.match(router, /ALL_TOOLS\.filter\(t => toolIsVisible\(t, rights\)\)/,
      'expected tools/list to filter through the shared predicate');
    assert.match(dispatch, /if \(tool && !toolIsVisible\(tool, rights\)\)/,
      'expected a call-time rejection through the SAME predicate — filtering the list alone is advisory');

    // And the predicate must actually gate on something. A version returning `true` for everything would
    // satisfy both matches above while enforcing nothing.
    const vis = readFileSync(join(ROOT, 'server', 'src', 'mcp', 'tool-visibility.ts'), 'utf8');
    assert.match(vis, /if \(tool\.admin\) return rights\?\.instanceAdmin === true;/);
    assert.match(vis, /if \(tool\.mutating\) return canWriteAnywhere\(rights\);/);
  });
});
