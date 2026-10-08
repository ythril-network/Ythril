/**
 * Every place the server starts `ffmpeg` bounds it in time and can kill it (bundle-89, Q-425 part 7, plan E5 item 4).
 *
 * ## The defect
 *
 * The two `ffmpeg` wrappers (`files/media/audio-embedder.ts`, `files/media/video-embedder.ts`) are `spawn(...)` plus a promise that
 * settles when the process closes. No timeout, no kill, no abort when the job loses its lease, and neither is among the budgets
 * the stall floor is raised by (`hopBudgets()`). A corrupt or adversarial file that wedges ffmpeg holds a worker slot until
 * stall recovery re-queues the job, and recovery then starts a SECOND ffmpeg on the same file while the first is still running.
 * Two such wedges are the whole pool.
 *
 * ## The rule, over the whole set
 *
 * **Every call that starts `ffmpeg` (or `ffprobe`) under `server/src` is bounded by a timeout it passes to the process, or by a
 * timer in the same function that kills it.** The set is DERIVED from the syntax tree (every `spawn`/`execFile`/`spawnSync`/
 * `execFileSync` whose command is the literal `ffmpeg` or `ffprobe`), never listed, and a floor says the scan found the two
 * sites the unchanged code has: an empty scan would pass every loop written over it. The merged wrapper the plan builds is one
 * such site and the rule holds it to the same line, so a third spelling of "run ffmpeg" cannot arrive unbounded.
 *
 * What counts, read from the function that starts the process (never from a comment: the tree has none):
 *
 *  - a `timeout` (or `signal`) option on the call, which Node enforces by killing the child; or
 *  - a `setTimeout` or `AbortSignal.timeout` in the same function AND a `.kill(` call in it.
 *
 * ## Seen red
 *
 * Red on the unchanged code at both wrappers. The self-test at the end feeds the detector one source of each shape (unbounded, an
 * option, a timer with a kill, a timer without one, a kill without a timer), so the gate is also seen to FIND and to PASS each
 * kind, not only to fail on today's tree.
 *
 * A behavioural test that a wedged ffmpeg is killed within a stated time needs a seam the unchanged code does not have (a named
 * timeout setting or an injectable clock, and a heartbeat while it runs); this gate holds what can be held without one.
 *
 * Run: node --test testing/standalone/every-ffmpeg-spawn-is-bounded-and-killed.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { ts, parseSource, lineOf } from '../_shared/syntax-tree.mjs';

const STARTERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync']);
const BINARIES = new Set(['ffmpeg', 'ffprobe']);

/**
 * The OUTERMOST function around a node (the wrapper, not the executor callback inside its `new Promise`), or the source file: a
 * timer set by the wrapper and the `spawn` inside the executor are one bound, and reading only the inner function would call it two.
 */
const enclosingFunction = (node) => {
  let outer = null;
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) outer = n;
  return outer ?? node.getSourceFile();
};

/** Every start of ffmpeg in one source: `{ key, line, bounded, why }`. The ONE detector, so the self-test and the sweep read the same rule. */
export function ffmpegStartSites(file, text) {
  const sf = parseSource(file, text);
  const sites = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : (ts.isIdentifier(node.expression) ? node.expression.text : '');
      const first = node.arguments[0];
      if (STARTERS.has(callee) && first && ts.isStringLiteralLike(first) && BINARIES.has(first.text)) {
        const fn = enclosingFunction(node);
        const optionNames = node.arguments.filter(ts.isObjectLiteralExpression)
          .flatMap(o => o.properties.map(p => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : '')));
        let timer = false, kill = false;
        const scan = (n) => {
          if (ts.isCallExpression(n)) {
            const c = n.expression;
            if (ts.isIdentifier(c) && c.text === 'setTimeout') timer = true;
            if (ts.isPropertyAccessExpression(c) && c.name.text === 'timeout' && c.expression.getText(sf) === 'AbortSignal') timer = true;
            if (ts.isPropertyAccessExpression(c) && c.name.text === 'kill') kill = true;
          }
          ts.forEachChild(n, scan);
        };
        scan(fn);
        const byOption = optionNames.includes('timeout') || optionNames.includes('signal');
        const bounded = byOption || (timer && kill);
        sites.push({
          key: `${file} :: line ${lineOf(sf, node)}`, line: lineOf(sf, node), bounded,
          why: byOption ? 'a timeout/signal option' : `${timer ? 'a timer' : 'no timer'}, ${kill ? 'a kill' : 'no kill'}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

describe('every start of ffmpeg under server/src is bounded and can be killed', () => {
  it('the detector finds and judges each shape (self-test)', () => {
    const wrap = (body, opts = '{ stdio: [] }') => `import { spawn } from 'child_process';\nfunction run() { const p = spawn('ffmpeg', ['-y'], ${opts}); ${body} }`;
    const judge = (src) => ffmpegStartSites('x.ts', src).map(s => s.bounded);
    assert.deepEqual(judge(wrap('')), [false], 'an unbounded wrapper must be found and refused');
    assert.deepEqual(judge(wrap('', '{ timeout: 1000 }')), [true], 'a timeout option bounds it');
    assert.deepEqual(judge(wrap('setTimeout(() => p.kill(), 1000);')), [true], 'a timer that kills bounds it');
    assert.deepEqual(judge(wrap('setTimeout(() => {}, 1000);')), [false], 'a timer that kills nothing bounds nothing');
    assert.deepEqual(judge(wrap('p.kill();')), [false], 'a kill nothing calls on a clock bounds nothing');
    assert.deepEqual(judge(`import { spawn } from 'child_process';\nspawn('git', ['status']);`), [], 'another command is not a site');
    assert.deepEqual(judge(wrap('// setTimeout(() => p.kill(), 1000);')), [false], 'a comment must not bound it');
  });

  it('every site is bounded', () => {
    const sites = readTrackedSources(['server/src'], { floor: 100 }).flatMap(({ file, text }) => ffmpegStartSites(file, text));
    assert.ok(sites.length >= 2, `only ${sites.length} ffmpeg start(s) found: the scan is looking in the wrong place (the unchanged code has two)`);
    const unbounded = sites.filter(s => !s.bounded).map(s => `${s.key} (${s.why})`);
    assert.deepEqual(unbounded, [],
      'ffmpeg is started here with no timeout and no kill: a wedged process holds a worker slot until the stall floor, and recovery starts a second one beside it');
  });
});
