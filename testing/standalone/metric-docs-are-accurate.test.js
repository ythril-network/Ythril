/**
 * The docs must describe what the code DOES, not merely mention that it exists.
 *
 * ## Why coverage was not enough
 *
 * `metric-docs-coverage` asserts that every metric on `/metrics` appears in the docs. It passed for a full release
 * while `ythril_storage_used_bytes`'s row read *"Storage used in bytes by area"* — after the collector had stopped
 * walking the disk and its own `help` string had gained *"— from a cached measurement, see the age gauge"*. The
 * metric was mentioned, so coverage was green, and the documentation described the previous release's behaviour.
 *
 * Coverage and accuracy are different axes. That mistake — a guard satisfied on the wrong axis — is the one this
 * batch kept finding in the product; this is the same mistake in the gates themselves.
 *
 * ## What this checks, and why the help string is the right yardstick
 *
 * A metric's `help` is the **code's own description of itself**, it ships to every scrape, and it is edited in the
 * same commit as the behaviour. So when the help carries a qualifier — the clause after an em dash or in
 * parentheses, the part that says *how* rather than *what* — the docs row must carry that concept too.
 *
 * It compares distinctive words rather than exact phrasing, so the docs stay free to word things better than the
 * help does. What it catches is a whole missing concept: "cached, not per scrape", "collected at scrape time",
 * "collection metadata, not a scan".
 *
 * Run: node --test testing/standalone/metric-docs-are-accurate.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const src = readFileSync(join(ROOT, 'server/src/metrics/registry.ts'), 'utf8');
const doc = readFileSync(join(ROOT, 'docs/integration-guide/11-setup-api.md'), 'utf8');

/**
 * Rows allowed to describe themselves by pointing at a sibling, with the row they point at.
 *
 * Three of the brain totals say "same estimate as above", which refers to `ythril_facts_total` — and that row
 * does spell out "read from collection metadata, not counted per scrape". That is accurate **by reference**, and
 * forcing each row to repeat it would make the table worse to read. The exemption names the referent so the
 * pointer cannot rot silently.
 */
const BY_REFERENCE = new Map([
  ['ythril_entities_total', 'ythril_facts_total'],
  ['ythril_edges_total', 'ythril_facts_total'],
  ['ythril_chrono_entries_total', 'ythril_facts_total'],
  ['ythril_sync_items_pushed_total', 'ythril_sync_items_pulled_total'],
]);

/** name -> help, straight from the registry. */
function registryHelp() {
  const out = new Map();
  for (const m of src.matchAll(/name:\s*'(ythril_[a-z0-9_]+)',\s*\r?\n\s*help:\s*'((?:[^'\\]|\\.)*)'/g)) {
    out.set(m[1], m[2].replace(/\\'/g, "'"));
  }
  return out;
}

const rowOf = (name) => doc.split(/\r?\n/).find(l => l.startsWith(`| \`${name}\``));

/**
 * The clauses that say HOW — each em-dash tail and each parenthetical, evaluated SEPARATELY.
 *
 * Joining them first was wrong, and the self-test caught it. A help like *"Storage used in bytes by area (brain,
 * files, total) — from a cached measurement"* has one clause the row legitimately repeats (the value list) and one
 * it had dropped (the cached-ness). Joined, the repeated clause diluted the missing one to 50% and the threshold
 * let it through — on the exact row that shipped a release out of date. Per clause, the dropped one is 100% absent.
 */
function qualifiersOf(help) {
  const out = [];
  for (const part of help.split(/—/).slice(1)) out.push(part.replace(/\([^)]*\)/g, '').trim());
  for (const m of help.matchAll(/\(([^)]{12,})\)/g)) out.push(m[1].trim());
  return out.filter(q => q.length >= 12);
}

/** Is this clause essentially absent from the row? */
function clauseMissing(clause, row) {
  const words = clause.toLowerCase().match(/[a-z]{5,}/g) ?? [];
  if (!words.length) return false;
  const absent = words.filter(w => !row.toLowerCase().includes(w));
  return absent.length / words.length > 0.6;
}

describe('the sweep works before it is trusted', () => {
  it('parses the registry help strings', () => {
    const helps = registryHelp();
    assert.ok(helps.size >= 30, `only ${helps.size} metrics parsed from the registry; the enumeration broke`);
    assert.ok(helps.has('ythril_storage_used_bytes'), 'the metric that motivated this gate is not being parsed');
  });

  it('the detector would have caught the original bug', () => {
    // The exact regression: a help with a qualifier, a row without it. Asserted against synthetic text so the gate
    // cannot pass merely because the tree is currently clean.
    const help = 'Storage used in bytes by area (brain, files, total) — from a cached measurement, see the age gauge';
    const staleRow = '| `ythril_storage_used_bytes` | gauge | Storage used in bytes by area (brain, files, total) |';
    const clauses = qualifiersOf(help);
    assert.ok(clauses.length >= 2, `expected the value list AND the cached clause, got ${clauses.length}`);
    assert.ok(clauses.some(q => clauseMissing(q, staleRow)),
      'the detector no longer flags the row that shipped a release out of date');
    // And it must NOT flag the clause the row legitimately repeats, or every row in the table becomes an offender.
    assert.ok(clauses.some(q => !clauseMissing(q, staleRow)),
      'the detector flags a clause the row DOES carry, which would make it fire on everything');
  });

  it('every by-reference exemption points at a row that exists and carries the concept', () => {
    // An exemption whose referent has moved is an exemption covering nothing.
    for (const [name, referent] of BY_REFERENCE) {
      assert.ok(rowOf(name), `${name} is exempted but has no docs row`);
      const target = rowOf(referent);
      assert.ok(target, `${name} defers to ${referent}, which has no docs row`);
      assert.ok(target.length > 60,
        `${name} defers to ${referent}, whose row is too thin to be carrying the explanation`);
    }
  });
});

describe("every metric row says what the code's help says", () => {
  it('no documented metric omits a concept its help carries', () => {
    const offenders = [];
    for (const [name, help] of registryHelp()) {
      const row = rowOf(name);
      if (!row) continue;                    // coverage is a different gate's job
      if (BY_REFERENCE.has(name)) continue;
      for (const q of qualifiersOf(help)) {
        if (!clauseMissing(q, row)) continue;
        offenders.push(`${name}\n      help says:    ${q.slice(0, 84)}\n      row omits it: ${row.slice(0, 84)}`);
      }
    }
    assert.deepEqual(offenders, [], 'these docs rows omit what the code says about the metric. The help string is '
      + 'edited in the same commit as the behaviour; a row that has fallen behind it is describing an older '
      + `release:\n\n  ${offenders.join('\n\n  ')}\n\n`
      + 'Either bring the row up to date, or add it to BY_REFERENCE **naming the row that carries the concept**.');
  });
});
