/**
 * The conversation extractor's decomposition keeps its own numbers honest, and its schemas match the
 * vocabulary the writer validates against (`F-31`).
 *
 * `server/src/extractor/conversation/DECOMPOSITION.md` argues for its design with a count — how many of the
 * prompt's rules are code, how many are bounded decisions, how many are writing. A count in prose is the
 * fastest thing in this repository to go stale, so the tally is recomputed here from the step tables and
 * compared. And every step carries exactly one of the three tags, because a step with none is a rule the
 * decomposition dropped without saying so.
 *
 * The schemas are laid out one file per record type, the way the `flows` space lays out its own. Until the
 * benchmark reads them from here, `benchmarks/space/schema.json` is a second copy of the same vocabulary —
 * so the two are compared entry for entry, and the day one changes without the other this fails.
 *
 * Run: node --test testing/standalone/the-extractor-decomposition-counts-itself.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'server/src/extractor/conversation';
const doc = readFileSync(join(DIR, 'DECOMPOSITION.md'), 'utf8');

/** Every step row: `| 3.4 | … | tag | … |`. */
const steps = doc.split('\n')
  .filter(l => /^\| \d+\.\d+ \|/.test(l))
  .map(l => { const c = l.split('|').map(x => x.trim()); return { id: c[1], tag: c[3] }; });

/** The classification rule the document states: any generative part wins, then any jev, else mechanical. */
const treatmentOf = (tag) => /generative/.test(tag) ? 'generative' : /jev/.test(tag) ? 'jev' : /mechanical/.test(tag) ? 'mechanical' : null;

describe('the decomposition counts itself', () => {
  it('finds the steps it is counting', () => {
    assert.ok(steps.length >= 40, `only ${steps.length} step rows parsed — the table format changed, not the design`);
  });

  it('every step carries a treatment', () => {
    const untagged = steps.filter(s => treatmentOf(s.tag) === null).map(s => s.id);
    assert.deepEqual(untagged, [], `steps with no mechanical / jev / generative tag: ${untagged.join(', ')}`);
  });

  it('step ids are unique', () => {
    const ids = steps.map(s => s.id);
    assert.equal(new Set(ids).size, ids.length, 'a step id appears twice');
  });

  it('the tally table matches the step tables', () => {
    const counted = { mechanical: 0, jev: 0, generative: 0 };
    for (const s of steps) counted[treatmentOf(s.tag)]++;
    for (const t of Object.keys(counted)) {
      const m = doc.match(new RegExp(`^\\| ${t} \\| (\\d+) \\| (\\d+)% \\|`, 'm'));
      assert.ok(m, `the tally has no row for ${t}`);
      assert.equal(Number(m[1]), counted[t], `the tally says ${m[1]} ${t} steps; the tables hold ${counted[t]}`);
      assert.equal(Number(m[2]), Math.round(100 * counted[t] / steps.length), `the ${t} share is stale`);
    }
    const total = doc.match(/^Of the (\d+) steps/m);
    assert.ok(total, 'the total is no longer stated where this test reads it');
    assert.equal(Number(total[1]), steps.length, `the prose says ${total[1]} steps; the tables hold ${steps.length}`);
  });
});

describe('the extractor schemas are one file per type, and match the vocabulary the writer validates', () => {
  const files = readdirSync(join(DIR, 'schemas')).filter(f => f.endsWith('.json'));
  const split = files.map(f => ({ f, e: JSON.parse(readFileSync(join(DIR, 'schemas', f), 'utf8')) }));
  const bench = JSON.parse(readFileSync('benchmarks/space/schema.json', 'utf8'));

  it('each file is named for the record it holds', () => {
    for (const { f, e } of split) {
      assert.equal(f, `conversation_${e.knowledgeType}_${e.typeName}.json`, `${f} holds ${e.knowledgeType}/${e.typeName}`);
    }
  });

  it('the split holds exactly the entries the writer validates against', () => {
    const key = e => `${e.knowledgeType}/${e.typeName}`;
    assert.deepEqual(split.map(s => key(s.e)).sort(), bench.map(key).sort(),
      'a type exists in one vocabulary and not the other');
    for (const b of bench) {
      const s = split.find(x => key(x.e) === key(b));
      assert.deepEqual(s.e, b, `${key(b)} differs between the extractor schemas and benchmarks/space/schema.json`);
    }
  });
});
