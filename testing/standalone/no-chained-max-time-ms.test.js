/**
 * A read's deadline goes in the OPTIONS object of the call, never on the cursor (`Q-358`, bundle-53 P4).
 *
 * ## What it prevents
 *
 * Driver 7.1.1 silently DROPS a `maxTimeMS` that is chained onto a cursor (`find(f).maxTimeMS(n)`) when it applies an
 * injected `timeoutMS`, and drops an optioned one the same way — it never throws, it applies `timeoutMS` alone. The
 * write bound (`db/write-bound.ts`, `planBound`) therefore LOWERS a numeric `options.maxTimeMS` of a read to the
 * scope's figure instead of letting the driver pick, and it can only do that for a figure it can SEE in the options
 * argument. A chained call is invisible to it: under a housekeeping or hold scope the read keeps its own, much larger
 * deadline, or loses it altogether, and a scope that exists to end a hung read ends nothing. Every read that can be
 * reached from inside a scope has to carry its deadline as `find(f, { maxTimeMS })` / `aggregate(p, { maxTimeMS })`.
 *
 * ## What it reads, and why it cannot read less than all of it
 *
 * Every tracked `.ts` file under `server/src`, read as a syntax tree: a comment or a string that talks about
 * `.maxTimeMS(` is not a call, so the prose that explains this very rule cannot trip it. There is NO exemption table
 * (owner decision on `Q-274`, `planAmendments2`): a chained call that is "never reached inside a scope" is the sentence
 * that stops being true the day somebody wraps the caller in one, and nobody revisits the table. The set is derived,
 * never listed, and floored twice — on the number of files read and on the number of `maxTimeMS` option sites found,
 * because a scan that reads the tree wrongly finds no chained call and no option either, and an empty answer passes
 * every loop written over it.
 *
 * The detector is itself held on samples (a chained call, an optioned one, a comment, a string, a bracket spelling),
 * so a mutation of the scan fails here and not only on the repository.
 *
 * Run: node --test testing/standalone/no-chained-max-time-ms.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { lineOf, parseSource, ts } from '../_shared/syntax-tree.mjs';

const NAME = 'maxTimeMS';

/**
 * What `text` (read as the language `file`'s name says) says about `maxTimeMS`: `chained` are the calls made ON a value
 * (`x.maxTimeMS(n)`, `x?.maxTimeMS(n)`, `x['maxTimeMS'](n)`), `options` are the places the name is written as a
 * property of an object (`{ maxTimeMS: n }`, `{ maxTimeMS }`). Comments and string contents are not nodes, so neither
 * can produce a hit.
 */
export function maxTimeMsSites(file, text) {
  const sf = parseSource(file, text);
  const chained = [];
  const options = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // The line of the NAME, not of the chain's start: a chain spans lines and the reader is looking for the call.
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === NAME) chained.push(lineOf(sf, callee.name));
      else if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
        && callee.argumentExpression.text === NAME) chained.push(lineOf(sf, callee.argumentExpression));
    }
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.text === NAME) {
      options.push(lineOf(sf, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { chained, options };
}

/** The fewest `maxTimeMS` option sites that means the scan read the tree — far under what the server holds. */
const OPTION_SITE_FLOOR = 8;

const sources = () => trackedSources(['server/src'], { floor: 100 });

describe('maxTimeMsSites (the detector, held on samples)', () => {
  it('finds a chained call on a cursor, however it is spelled', () => {
    const text = [
      'const a = col.find(f).maxTimeMS(5);',
      'const b = col.find(f)?.maxTimeMS(5);',
      "const c = col.find(f)['maxTimeMS'](5);",
      'cursor.maxTimeMS(ms);',
    ].join('\n');
    assert.deepEqual(maxTimeMsSites('x.ts', text).chained, [1, 2, 3, 4]);
  });

  it('names a call chained across lines at the line of the call itself', () => {
    const text = 'const a = col\n  .find(f)\n  .maxTimeMS(5)\n  .toArray();';
    assert.deepEqual(maxTimeMsSites('x.ts', text).chained, [3]);
  });

  it('counts the options form as an option site and never as a chained call', () => {
    const text = 'col.find(f, { maxTimeMS: 5 });\ncol.aggregate(p, { maxTimeMS });\nfoo({ maxTimeMS: remaining() });';
    const { chained, options } = maxTimeMsSites('x.ts', text);
    assert.deepEqual(chained, []);
    assert.deepEqual(options, [1, 2, 3]);
  });

  it('is not moved by a comment or a string that names a chained call', () => {
    const text = [
      '// col.find(f).maxTimeMS(5)',
      '/* cursor.maxTimeMS(ms) */',
      "const s = 'x.maxTimeMS(5)';",
      'const t = `y.maxTimeMS(${n})`;',
    ].join('\n');
    const { chained, options } = maxTimeMsSites('x.ts', text);
    assert.deepEqual(chained, []);
    assert.deepEqual(options, []);
  });
});

describe('a read carries its deadline in its options', () => {
  it('NO .maxTimeMS( is chained onto a cursor anywhere in server/src', () => {
    const hits = [];
    for (const file of sources()) {
      for (const line of maxTimeMsSites(file, readFileSync(join(REPO_ROOT, file), 'utf8')).chained) hits.push(`${file}:${line}`);
    }
    assert.deepEqual(hits, [],
      `${hits.length} chained .maxTimeMS( call(s): ${hits.join(', ')}. Driver 7.1.1 drops a chained maxTimeMS when it applies an `
      + 'injected timeoutMS, and the write bound lowers only a maxTimeMS it can see in the options argument — so under a '
      + 'housekeeping or hold scope a chained deadline is a no-op. Write find(filter, { maxTimeMS }) or '
      + 'aggregate(pipeline, { maxTimeMS }); a figure that is read lazily stays lazy as { maxTimeMS: remaining() }.');
  });

  it('the scan reads enough to mean something (a floor on files and on maxTimeMS option sites)', () => {
    let optionSites = 0;
    for (const file of sources()) optionSites += maxTimeMsSites(file, readFileSync(join(REPO_ROOT, file), 'utf8')).options.length;
    assert.ok(optionSites >= OPTION_SITE_FLOOR,
      `only ${optionSites} maxTimeMS option site(s) found in server/src (floor ${OPTION_SITE_FLOOR}): the scan is reading the tree wrongly, `
      + 'and a scan that finds no option finds no chained call either.');
  });
});
