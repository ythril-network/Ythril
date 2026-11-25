#!/usr/bin/env node
/**
 * Puts an Oxigraph record and a Ythril record of the same run side by side and marks every query that Ythril
 * answers more than `factor` (10) times slower than Oxigraph, on the median.
 *
 *   node benchmarks/rdf/compare.mjs <oxigraph-record.json> <ythril-record.json> [--factor 10]
 *
 * ## What this prevents
 *
 * - **A comparison of two different data sets.** The records must name the same size, the same variant and the
 *   same variant sha256; anything else is refused, because a ratio between engines that loaded different triples
 *   says nothing about the engines.
 * - **A failed query read as a fast one.** A query Ythril did not answer (an error, or absent from its record) is a
 *   row saying so and is listed apart; it is never a ratio and never "not slower".
 * - **A mark that follows the wrong number.** The ratio is Ythril over Oxigraph, on the median; the p95 ratio is
 *   shown beside it and never marks a row.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const queryNumber = (name) => Number(/^Q(\d+)$/.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);
const timed = (q) => q !== undefined && typeof q.median === 'number' && typeof q.p95 === 'number';
const ratio = (a, b) => (b > 0 ? a / b : null);

function assertComparable(base, other) {
  if (base.engine !== 'oxigraph') throw new Error(`the first record must be the oxigraph run, it is ${base.engine}`);
  if (other.engine !== 'ythril') throw new Error(`the second record must be the ythril run, it is ${other.engine}`);
  if (base.size !== other.size) throw new Error(`the records are of different size: ${base.size} and ${other.size} products`);
  const a = base.dataset;
  const b = other.dataset;
  if (!a?.variant || !b?.variant) throw new Error('a record names no dataset variant: it predates the variant and cannot be compared');
  if (a.variant !== b.variant) throw new Error(`the records ran on different dataset variants: ${a.variant} and ${b.variant}`);
  if (a.sha256 !== b.sha256) throw new Error(`the records ran on different bytes of the variant (sha256 ${a.sha256} and ${b.sha256})`);
}

/**
 * Compares two records. Returns `{ rows, slower, noAnswer }`: one row per query (number order) with both
 * engines' median and p95, the two ratios (Ythril over Oxigraph; `null` where either side has no timing), `slower`
 * (median ratio above `factor`) and a `note` for a row without a ratio; `slower` and `noAnswer` list the names.
 */
export function compareRecords(base, other, { factor = 10 } = {}) {
  assertComparable(base, other);
  const names = [...new Set([...Object.keys(base.queries), ...Object.keys(other.queries)])].sort((x, y) => queryNumber(x) - queryNumber(y));
  const rows = names.map((query) => {
    const b = base.queries[query];
    const o = other.queries[query];
    const row = { query, base: timed(b) ? b : null, other: timed(o) ? o : null, ratioMedian: null, ratioP95: null, slower: false, note: '' };
    if (row.base && row.other) {
      row.ratioMedian = ratio(o.median, b.median);
      row.ratioP95 = ratio(o.p95, b.p95);
      row.slower = row.ratioMedian !== null && row.ratioMedian > factor;
    } else if (o === undefined) row.note = 'not in the ythril record';
    else if (b === undefined) row.note = 'not in the oxigraph record';
    else if (!row.other) row.note = `ythril error ${o.error?.code ?? 'unknown'}`;
    else row.note = `oxigraph error ${b.error?.code ?? 'unknown'}`;
    return row;
  });
  return { factor, rows, slower: rows.filter((r) => r.slower).map((r) => r.query), noAnswer: rows.filter((r) => r.note).map((r) => r.query) };
}

const ms = (q) => q.median.toFixed(2);
const p95 = (q) => q.p95.toFixed(2);
const times = (r) => (r === null ? '-' : `${r.toFixed(1)}x`);

/** The markdown comparison of two records (see `compareRecords`). */
export function renderComparison(base, other, options = {}) {
  const cmp = compareRecords(base, other, options);
  const f = cmp.factor;
  const d = base.dataset;
  const load = (r, who) => (typeof r.loadMs === 'number' ? `${who} loaded in ${r.loadMs} ms` : `${who} load refused: ${r.loadRefusal?.code ?? 'no load recorded'}${r.loadRefusal?.message ? ` (${r.loadRefusal.message})` : ''}`);
  const lines = [
    `BSBM Explore, ${base.size} products, variant ${d.variant} (${d.triples} triples, sha256 ${d.sha256})`,
    `${load(base, 'Oxigraph')}; ${load(other, 'Ythril')}`,
    '',
    '| query | Oxigraph median ms | Oxigraph p95 ms | Ythril median ms | Ythril p95 ms | median ratio | p95 ratio | |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const r of cmp.rows) {
    const o = r.other ? [ms(r.other), p95(r.other)] : [r.note.startsWith('ythril error') ? r.note.replace('ythril ', '') : '-', '-'];
    const b = r.base ? [ms(r.base), p95(r.base)] : ['-', '-'];
    const last = r.slower ? `**>${f}x slower**` : r.note;
    lines.push(`| ${r.query} | ${b[0]} | ${b[1]} | ${o[0]} | ${o[1]} | ${times(r.ratioMedian)} | ${times(r.ratioP95)} | ${last} |`);
  }
  lines.push('', `Queries more than ${f}x slower than Oxigraph: ${cmp.slower.length ? cmp.slower.join(', ') : 'none'} (${cmp.slower.length} of ${cmp.rows.length}), by median.`);
  if (cmp.noAnswer.length) lines.push(`Queries with no ratio: ${cmp.noAnswer.join(', ')}.`);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--factor');
  const factor = fi >= 0 ? Number(args.splice(fi, 2)[1]) : 10;
  if (args.length !== 2 || !(factor > 0)) {
    console.error('usage: compare.mjs <oxigraph-record.json> <ythril-record.json> [--factor 10]');
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(renderComparison(JSON.parse(readFileSync(args[0], 'utf8')), JSON.parse(readFileSync(args[1], 'utf8')), { factor }));
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  }
}
