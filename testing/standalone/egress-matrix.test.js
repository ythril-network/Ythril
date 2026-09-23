/**
 * The documented egress matrix matches the code's actual set of admin-settable model endpoints.
 *
 * ## Why this is a gate and not a review item
 *
 * The guide already stated the invariant the code had broken. Its list of endpoints that go through the
 * SSRF-guarded fetch did not mention `DOC_VLM_URL` — while the document VLM was reaching an off-instance
 * host with **no guard at all**, silently, on any deployment pointing vision at a remote Ollama. And one
 * paragraph over, the guide promised *"no document content leaves your instance"* by default, which was
 * false in exactly that configuration.
 *
 * Neither statement was wrong when written. Both went stale because a slot was added and nothing compared
 * the prose to the code. A customer found it; a reviewer would have had to hold ten slot names in their
 * head to notice the seventh row was the last one.
 *
 * So the matrix is machine-checked against `EGRESS_SLOTS` — the same canonical list the per-slot
 * permission resolver and the security posture enumerate. Adding a model slot now fails here until the
 * table gains its row, which is the only mechanism that makes "the docs are complete" a fact rather than
 * an intention.
 *
 * Deliberately checks COMPLETENESS and IDENTITY, not prose. What a slot "sends" is judgement and belongs
 * to a human; *that the slot appears at all* is not, and is precisely what went missing.
 *
 * Run: node --test testing/standalone/egress-matrix.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readGuide } from './_docs.mjs';

// The guide is 17 files now; `readGuide()` joins them so this check keeps asking about the guide
// rather than about how it happens to be stored.

let EGRESS_SLOTS;
let rows;

/**
 * Parse the matrix out of the guide.
 *
 * Anchored on the heading rather than on a line number, and it asserts it found a table at all — a
 * parser that silently matches nothing turns this whole file green while checking nothing, which is the
 * same class of failure it exists to catch.
 */
function parseMatrix(md) {
  const heading = md.indexOf('#### Egress matrix');
  assert.ok(heading > 0, 'the guide must have an "Egress matrix" section');
  const after = md.slice(heading);
  const headerAt = after.search(/^\| Slot \| Slot key \|/m);
  assert.ok(headerAt > 0, 'the matrix must have a `Slot | Slot key | …` header row');

  const lines = after.slice(headerAt).split(/\r?\n/);
  const out = [];
  for (const line of lines.slice(2)) {              // skip the header and its separator
    if (!line.startsWith('|')) break;               // table ends at the first non-row line
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    out.push({
      label: cells[0],
      key: (cells[1] ?? '').replace(/`/g, ''),
      env: cells[2] ?? '',
      sends: cells[3] ?? '',
      guard: cells[4] ?? '',
      ack: cells[5] ?? '',
    });
  }
  return out;
}

describe('egress matrix ↔ code', () => {
  before(async () => {
    ({ EGRESS_SLOTS } = await import('../../server/dist/config/model-egress-policy.js'));
    rows = parseMatrix(readGuide());
  });

  it('the parser found the table', () => {
    // Guards the scanner itself. Every assertion below is vacuous on an empty parse.
    assert.ok(rows.length >= 8, `parsed only ${rows.length} matrix rows`);
  });

  it('documents exactly the slots the code has — no more, no fewer', () => {
    const documented = rows.map(r => r.key).sort();
    const actual = [...EGRESS_SLOTS].sort();
    assert.deepEqual(documented, actual,
      'the egress matrix must list every admin-settable model endpoint. A slot in the code and not the ' +
      'table is an undocumented egress path; a slot in the table and not the code is a setting a reader ' +
      'will configure and watch do nothing.');
  });

  it('every row is filled in', () => {
    for (const r of rows) {
      assert.ok(r.label.length > 0, `${r.key}: needs a human-readable name`);
      assert.ok(r.env.includes('`'), `${r.key}: must name its env var(s)`);
      assert.ok(r.sends.length > 0, `${r.key}: must say what it sends`);
      assert.ok(r.guard.length > 0, `${r.key}: must say when it is guarded`);
    }
  });

  it('the two acknowledgement-gated slots are marked as such', () => {
    // The assist model sends document content off the instance; the face model sends biometric data.
    // Both refuse to run without a recorded acknowledgement, and a matrix that did not say so would
    // understate the two rows a reader most needs to stop on.
    const required = rows.filter(r => /required/i.test(r.ack)).map(r => r.key).sort();
    assert.deepEqual(required, ['assist', 'decision', 'faceExternal']);
  });

  it('the guarded-endpoints bullet no longer enumerates a stale subset', () => {
    // It used to list seven slots by name — and the one it omitted was the unguarded one. A prose list
    // that has to be kept in sync with a table two lines below it will not be; it now points at the
    // matrix instead, which is the thing this test checks.
    const md = readGuide();
    const bullet = md.slice(md.indexOf('- **Model provider endpoints**'), md.indexOf('#### Egress matrix'));
    assert.ok(bullet.length > 0 && bullet.length < 400, 'expected the short bullet above the matrix');
    assert.match(bullet, /egress matrix/i, 'the bullet should defer to the matrix rather than re-list slots');
  });

  it('every documented env var is real', () => {
    // The nastier direction: a reader copies the name into their manifest, it does nothing, and there is
    // no error to explain why.
    //
    // `env-var-docs-coverage` cannot see these — it scopes itself to the `YTHRIL_`/`MONGO_`/`MCP_`/
    // `OIDC_` namespaces, and every model endpoint sits outside all four. On its first run this check
    // found three phantoms shipped in the matrix (`EMBEDDING_BASE_URL`, `RERANK_BASE_URL`,
    // `NLI_BASE_URL`; the real names drop the `BASE_`), which is what that blind spot costs.
    const names = rows.flatMap(r => [...r.env.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map(m => m[1]));
    assert.ok(names.length >= 10, `expected the matrix to name env vars, found ${names.length}`);
    const src = ['server/src/config/loader.ts', 'server/src/config/types.ts']
      .map(f => readFileSync(f, 'utf8')).join('\n');
    const missing = names.filter(n => !src.includes(n));
    assert.deepEqual(missing, [], `documented but not read anywhere: ${missing.join(', ')}`);
  });
});
