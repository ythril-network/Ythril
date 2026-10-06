/**
 * A once-only warning is a `warnOnce`, never a hand-written latch (`Q-317`, bundle-53 G26).
 *
 * ## The defect it prevents
 *
 * "Say this once" was written as a module-scope boolean, `if (!warned) { warned = true; log.warn(…) }`, six times in six
 * spellings, and every copy had the same two flaws. **It never says it again** after the condition clears and returns: a
 * provider that came back and failed a second time was silent about the second outage, because the flag was set for the life of
 * the process. And **nothing reset it**: the test that wanted to see the line twice reached into the module to put the flag
 * back, or could not, and a test that passed in one order failed in another. The retention announcement even grew a comment
 * explaining why `stop()` clears it — "a latch that outlives its owner is a test seam that lies about the second run" — which is
 * the flaw written down as a feature. `util/warn-once.ts` is bounded, resettable and windowed; this holds that no code says
 * "once" any other way.
 *
 * ## What it holds, and where each part comes from
 *
 * A LATCH is read out of the source by its shape, in every file under `server/src`, with no exemption row:
 *
 * - **a flag, tested and set in one move** — `if (!X) { X = true; …` (the test may be one conjunct of a longer condition), or the
 *   early-return spelling `if (X) return; X = true;` (`continue` too). `X` is a name or a member path;
 * - **a set or map used the same way** — `if (!S.has(k)) { S.add(k); …` / `S.set(k, …)`, or `if (S.has(k)) return; S.add(k);`.
 *
 * A latch is a once-only WARNING when what it guards is a log line: a log call inside the guarded block, or, in the early-return
 * spelling, a log call that is the whole of what follows the assignment (the function returns on the second call, so a function
 * that does anything else after the log is guarding THAT work). That is the question this gate asks, and it is why a start guard
 * (`if (running) return; running = true; log.info('started'); void loop();`), a re-entrancy guard (the shutdown handler's
 * `shuttingDown`) and a de-duplication of a walk (`if (seen.has(id)) continue; seen.add(id);`) are not findings: the same shape,
 * a different question, told apart by what follows the assignment and not by a name on a list.
 *
 * **Two state machines are NOT latches, and the shape excludes them, no row does.** `sync/peer-floor.ts`'s `reported` is a
 * version string (`typeof version === 'string' ? version.trim() : ''`), and `spaces/search-readiness.ts`'s `lastWarnAt` is a
 * timestamp moved by state transitions; neither is ever set to the constant `true` under its own test, so neither matches. They
 * are pinned below as fixtures, because a pattern widened one day to catch "any assignment under an `if`" would catch them and
 * the gate would be deleted for it.
 *
 * ## It cannot pass by reading nothing
 *
 * The scan has three floors, because an empty set passes every loop written over it: the number of source files read, the number
 * of latch-SHAPED statements found (a start guard or a de-duplication counts here, a log line is not needed) — which the tree has
 * dozens of, so a pattern that stopped matching shows up at once — and the number of `warnOnce` call sites, the spelling this
 * gate wants. And each spelling above is a fixture that must be found.
 *
 * ## Seen red
 *
 * On the six sites the audit named, in their own words (the fixtures below are those spellings, from the tree before bundle-53
 * G23 and G24), and by hand against the live tree, put back by hand: a boolean latch around a warning in `mcp/validate-args.ts`,
 * the early-return spelling in `files/media/face-descriptor.ts`, and a `Set` latch in `brain/chrono-redaction.ts`.
 *
 * Run: node --test testing/standalone/a-once-only-warning-is-a-warn-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom, statementFrom } from './_structural-window.mjs';

const IDENT = String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*`;
/** A log call anywhere in a guarded block. */
const LOG_IN = /\b(?:log\.(?:warn|info|error|debug)|console\.(?:warn|error|log|info)|warn[A-Za-z]*)\s*\(/;
/** A statement that IS a log call. */
const LOG_STATEMENT = /^(?:log\.(?:warn|info|error|debug)|console\.(?:warn|error|log|info)|warn[A-Za-z]*)\s*\(/;

/**
 * Every latch-shaped statement in one source (comments already stripped).
 *
 * @returns {{ at: number, kind: 'flag'|'set', name: string, form: 'block'|'early', guardsLog: boolean }[]}
 */
export function latchesIn(src) {
  const out = [];
  for (const m of src.matchAll(/\bif\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const condText = balancedFrom(src, open, 'an `if` condition');
    const cond = condText.slice(1, -1).trim();
    const afterCond = open + condText.length;
    const bodyAt = afterCond + /^\s*/.exec(src.slice(afterCond))[0].length;
    // Every test of the consequence below is anchored at its START (`^`), so it reads only the head it needs: the block is balanced (and
    // so must parse) only when its head already has a latch's shape, so a file this reader cannot balance a large unrelated block of is
    // not a file it silently drops. Nothing here is a window — the rest of the source is merely what follows the anchor.
    const head = src.slice(bodyAt);

    // (1) `if (!X) { X = true; … }` and `if (!S.has(k)) { S.add(k); … }`
    const negFlag = new RegExp(String.raw`(?:^|&&)\s*!\s*(${IDENT})\s*(?=&&|$)`).exec(cond)?.[1];
    if (negFlag && new RegExp(String.raw`^\{\s*${esc(negFlag)}\s*=\s*true\s*;`).test(head)) {
      out.push({ at: m.index, kind: 'flag', name: negFlag, form: 'block', guardsLog: LOG_IN.test(balancedFrom(src, bodyAt, 'a latch block')) });
    }
    const negSet = new RegExp(String.raw`(?:^|&&)\s*!\s*(${IDENT})\.has\(([^()]*)\)\s*(?=&&|$)`).exec(cond);
    if (negSet) {
      const [, set, key] = negSet;
      if (new RegExp(String.raw`^\{\s*${esc(set)}\.(?:add|set)\(\s*${esc(key)}\s*[,)]`).test(head)) {
        out.push({ at: m.index, kind: 'set', name: set, form: 'block', guardsLog: LOG_IN.test(balancedFrom(src, bodyAt, 'a latch block')) });
      }
    }

    // (2) `if (X) return; X = true;` and `if (S.has(k)) return; S.add(k);`
    if (/^(?:\{\s*)?(?:return|continue)\b/.test(head)) {
      const posFlag = new RegExp(String.raw`(?:^|\|\|)\s*(${IDENT})\s*(?=\|\||$)`).exec(cond)?.[1];
      const posSet = new RegExp(String.raw`(?:^|\|\|)\s*(${IDENT})\.has\(([^()]*)\)\s*(?=\|\||$)`).exec(cond);
      if (posFlag || posSet) {
        const consequence = src[bodyAt] === '{' ? balancedFrom(src, bodyAt, 'an early-return block') : statementFrom(src, bodyAt, 'an early-return statement');
        const afterAt = bodyAt + consequence.length;
        const rest = src.slice(afterAt).trimStart();
        const restAt = afterAt + (src.length - afterAt - rest.length);
        if (posFlag && new RegExp(String.raw`^${esc(posFlag)}\s*=\s*true\s*;`).test(rest)) {
          out.push({ at: m.index, kind: 'flag', name: posFlag, form: 'early', guardsLog: nextStatementIsLog(src, restAt + rest.indexOf(';') + 1) });
        }
        if (posSet && new RegExp(String.raw`^${esc(posSet[1])}\.(?:add|set)\(\s*${esc(posSet[2])}\s*[,)]`).test(rest)) {
          out.push({ at: m.index, kind: 'set', name: posSet[1], form: 'early', guardsLog: nextStatementIsLog(src, restAt + statementFrom(rest, 0, 'a set insert').length) });
        }
      }
    }
  }
  return out;
}

const esc = text => text.replace(/[.?$()[\]*+^|\\{}]/g, '\\$&');

/**
 * Is the first statement after `from` a log call that is also the LAST statement of its block?
 *
 * The early-return spelling returns from the whole function on the second call, so the function's remaining work happens once
 * too. If anything follows the log, the latch is guarding THAT work (a start guard: `if (running) return; running = true;
 * log.info('started'); void loop();`, or a re-entrancy guard: `if (shuttingDown) return; shuttingDown = true; log.debug(…); …`)
 * and the log is progress, not a warning. If the log is all there is, the function exists to say it once.
 */
function nextStatementIsLog(src, from) {
  const next = src.slice(from).trimStart();
  if (!LOG_STATEMENT.test(next)) return false;
  return /^\s*\}/.test(next.slice(statementFrom(next, 0, 'the statement after a latch').length));
}

/** The latch's own text, for the message: line numbers of a comment-stripped source are not the file's. */
const excerpt = (src, at) => src.slice(at, src.indexOf('\n', at) < 0 ? src.length : src.indexOf('\n', at)).replace(/\s+/g, ' ').trim();

describe('the latch reader finds each spelling (fixtures are the audit\'s own, so the reader is seen red on them)', () => {
  /** [what it is, source, kind, form] — every one is a once-only warning. */
  const WARNINGS = [
    ['change-retention: a module flag set before the first announcement',
      "if (!_announced) {\n  _announced = true;\n  const seen = await col(C).countDocuments({}, { limit: 1 });\n  if (seen === 0) log.info('Retention: nothing to age');\n}",
      'flag', 'block'],
    ['face-descriptor: a flag set under a length test',
      "if (embedding.length === expectedDims) return true;\nif (!warned) {\n    warned = true;\n    log.warn(`Face descriptor width is ${embedding.length}`);\n  }",
      'flag', 'block'],
    ['face-embedder: a flag set under a longer condition',
      "if (!faces && externalFaceReady() && !inProcessFallbackAllowed()) {\n    if (!warnedFallbackDisabled) {\n      warnedFallbackDisabled = true;\n      log.warn('Face recogniser: the external provider did not answer');\n    }\n  }",
      'flag', 'block'],
    ['validate-args: a flag set in a branch',
      "if (key === null) {\n    if (!warnedUnkeyable) {\n      warnedUnkeyable = true;\n      log.warn('tool validator: a space id outside [a-z0-9-]+ was given');\n    }\n  }",
      'flag', 'block'],
    ['search-readiness: a flag as one conjunct of a longer test',
      "if (!waiters.has(key) && waiters.size >= MAX_WAITERS) {\n      if (!overflowWarned) {\n        overflowWarned = true;\n        log.warn(`Search readiness: ${MAX_WAITERS} items are waiting`);\n      }\n      return;\n    }",
      'flag', 'block'],
    ['chrono-redaction: a set keyed by what was announced',
      "const key = `${spaceId}|${collection}`;\n    if (!announced.has(key)) {\n      announced.add(key);\n      log.info(`Retention: '${spaceId}' ${collection} is being stamped`);\n    }",
      'set', 'block'],
    ['the early-return spelling of a flag (TST-6)',
      "function note() {\n  if (warned) return;\n  warned = true;\n  log.warn('said once');\n}",
      'flag', 'early'],
    ['the early-return spelling of a set',
      "function note(k) {\n  if (announced.has(k)) return;\n  announced.add(k);\n  log.info('said once per key');\n}",
      'set', 'early'],
    ['the early-return spelling inside a block, with `continue`',
      "for (const k of keys) {\n  if (announced.has(k)) { continue; }\n  announced.add(k);\n  console.warn(k);\n}",
      'set', 'early'],
    ['a member path',
      "if (!this.warned) {\n  this.warned = true;\n  log.warn('x');\n}",
      'flag', 'block'],
  ];
  for (const [what, src, kind, form] of WARNINGS) {
    it(`finds: ${what}`, () => {
      const hits = latchesIn(src).filter(l => l.guardsLog);
      assert.equal(hits.length, 1, `expected exactly one once-only warning in:\n${src}\nfound ${JSON.stringify(latchesIn(src))}`);
      assert.equal(hits[0].kind, kind);
      assert.equal(hits[0].form, form);
    });
  }

  /** [what it is, source] — latch-SHAPED, or near it, and not a warning. */
  const NOT_WARNINGS = [
    ['a start guard (embed-worker)',
      "if (running) return;\n  running = true;\n  stopping = false;\n  void runEmbedBootSweeps().catch(err => log.warn(`startup sweeps failed: ${err}`));\n  stallJob.start();"],
    ['a start guard whose first act is a progress line (media worker)',
      "if (running) return;\n  running = true;\n  log.info('Media embedding worker: started');\n  void workerLoop();\n}"],
    ['a re-entrancy guard whose first act is a debug line (the shutdown handler)',
      "if (shuttingDown) return;\n    shuttingDown = true;\n    log.debug(`${signal} received — shutting down`);\n\n    beginShutdown();\n  };"],
    ['a de-duplication of a walk',
      "if (visited.has(neighborId)) continue;\n      visited.add(neighborId);\n      newNeighborIds.push(neighborId);"],
    ['a one-way declaration that signals a listener, not a log',
      "if (!stepSet.has(step)) {\n    stepSet.add(step);\n    steps.push(step);\n    signalHousekeeping({ type: 'step-declared', step });\n  }"],
    ['a re-entrancy guard that logs after other work (the log is not the next statement)',
      "if (shuttingDown) return;\n    shuttingDown = true;\n    doTheWork();\n    log.debug('received');"],
  ];
  for (const [what, src] of NOT_WARNINGS) {
    it(`does not report: ${what}`, () => {
      assert.deepEqual(latchesIn(src).filter(l => l.guardsLog), [], `${what} is not a once-only warning, and must not be reported`);
    });
  }

  /**
   * The two state machines the audit kept, verbatim. Neither is `X = true` under its own test, so the SHAPE leaves them out;
   * these pin that, because a pattern widened to "any assignment under an `if`" would catch both.
   */
  const STATE_MACHINES = [
    ['peer-floor `reported` (a version string)',
      "const reported = typeof version === 'string' ? version.trim() : '';\n  if (!reported) {\n    if (!versionCheckedAt) return null;\n    return `Peer reports no version`;\n  }\n  if (!parseable(reported)) {\n    return `Peer reports version '${reported}'`;\n  }"],
    ['search-readiness `lastWarnAt` (a timestamp moved by transitions)',
      "if (state === 'absent') { setState('down'); lastWarnAt = now(); return; }\n    if (now() - lastWarnAt >= HOURLY_WARN_MS) {\n      lastWarnAt = now();\n      log.warn(`Database search has been down`);\n    }"],
    ['a flag persisted in the database (`warnedStalled`)',
      "} else if (!run.warnedStalled && now - Date.parse(run.progressAt) > STALLED_MS) {\n        log.warn('stalled');\n        await runs(space.id).updateOne({ _id: RUN_ID }, { $set: { warnedStalled: true } });\n      }"],
  ];
  for (const [what, src] of STATE_MACHINES) {
    it(`leaves a different question alone by shape: ${what}`, () => {
      assert.deepEqual(latchesIn(src), [], `${what} is not a latch`);
    });
  }

  it('the compliant spelling is not a finding', () => {
    assert.deepEqual(latchesIn("const stallWarnings = warnOnce();\nstallWarnings('k', () => { log.warn('x'); });"), []);
  });
});

describe('no code in server/src says "once" with a hand-written latch', () => {
  const files = trackedSources('server/src', { untracked: true });
  const read = file => stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
  const sources = new Map(files.map(file => [file, read(file)]));
  const all = [...sources].flatMap(([file, src]) => latchesIn(src).map(l => ({ file, src, ...l })));

  it('reads a tree worth reading (the floors)', () => {
    assert.ok(sources.size >= 300, `only ${sources.size} source files were read`);
    assert.ok(all.length >= 10,
      `only ${all.length} latch-shaped statement(s) were found in server/src — the tree has dozens (start guards, de-duplications), `
      + 'so the reader has stopped matching, and an empty set would pass every assertion below about nothing');
    const adopters = [...sources].filter(([, src]) => /\bwarnOnce\s*[<(]/.test(src)).length;
    assert.ok(adopters >= 8, `only ${adopters} file(s) use warnOnce: the module this gate points at has been abandoned or the pattern is wrong`);
  });

  it('every once-only warning is a warnOnce', () => {
    const findings = all.filter(l => l.guardsLog)
      .map(l => `${l.file}: \`${l.name}\` is a hand-written ${l.kind} latch (${l.form}) around a log line — \`${excerpt(l.src, l.at)}…\``);
    assert.deepEqual(findings, [],
      `a once-only warning written by hand never says it again after the condition clears and cannot be reset:\n  ${findings.join('\n  ')}\n`
      + 'Use `warnOnce` (util/warn-once.ts): bounded, resettable with `forget`, and windowed if the line should come back.');
  });
});
