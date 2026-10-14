/**
 * Each rule bundle-113's diff pass merged into one module still has ONE implementation (CLAUDE.md "Reuse a module" and "One rule, two
 * implementations"). Every case asks a RULE of `server/src` as a whole, read with its comments stripped and its functions parsed: the
 * subjects are DERIVED (the callers of the one function, the functions whose bodies hold the guard), never three files that once held a
 * copy, and a CALL is matched where it is made (`callsIn` of a function body), never a mention in prose or an import.
 *
 *  1. **The links a file delete owes.** "Which link rows are this instance's" is `fileLinksThisInstanceWrote`'s alone (a missing author is
 *     this instance's) and "remove them with tombstones" is `removeFileLinksThisInstanceWrote`'s. The delete path (the cascades, through
 *     `removeLinksOfDeletedFiles`) and the repair both CALL it; no other source that reads the links collection spells the author test;
 *     and the author-filtered removal the repair once had (`removeLinksWrittenBy`, which read a missing author as nobody's) is gone.
 *  2. **A caught file-act failure.** `answerFileActFailure` counts the answer and reports a 5xx cause: every door's catch calls it, and the
 *     only other caller of `fileActAnswer` is named, with its reason.
 *  3. **The live config entry of a space.** A write of a local-bookkeeping key of the entry happens inside `changeSpaceEntries`, and no
 *     caller of it saves the config itself.
 *  4. **A destination's two verdicts** (occupied bytes, a live record unless the state is an alias) are thrown by one core; the functions
 *     that ask a destination question end in it.
 *  5. **The client's code list** reads the server module without its comments, by the stripper the source gates use.
 *
 * Run: node --test testing/standalone/each-rule-the-bundle-113-dedupe-merged-has-one-implementation.test.js (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { callsIn, topLevelFunctions } from './_call-graph.mjs';

const textOf = (rel) => stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8').replaceAll('\r\n', '\n'));
const SOURCES = trackedSources(['server/src'], { floor: 100 });
/** Every top-level function of the server, as `{ file, name, body }`: the unit "who calls X" is answered over. */
const FUNCTIONS = SOURCES.flatMap(file => [...topLevelFunctions(textOf(file))].map(([name, body]) => ({ file, name, body })));
/** The functions whose body CALLS `name` (a call, never a mention, an import or a definition), inside the closures it hands on too. */
const callersOf = (name) => FUNCTIONS.filter(f => f.name !== name && callsIn(f.body, { closures: true }).has(name));
const bodyOf = (file, name) => {
  const hit = FUNCTIONS.find(f => f.file === file && f.name === name);
  assert.ok(hit, `${file} has no top-level function ${name}: it moved, so re-point this gate`);
  return hit.body;
};
const textsMatching = (re) => SOURCES.filter(f => re.test(textOf(f)));

describe('the scan itself reads the server', () => {
  it('finds the server\'s functions and the callers it is asked about (a scan that parsed nothing passes every loop)', () => {
    assert.ok(FUNCTIONS.length >= 500, `the parse found ${FUNCTIONS.length} functions`);
    assert.ok(callersOf('removeFileLinksThisInstanceWrote').length >= 2, 'no caller of the link remover was found: the call matcher reads nothing');
  });
});

describe('the links a file delete owes are selected and removed in one place', () => {
  it('the remover is CALLED by the delete\'s link step and by the repair, and the delete\'s step is called by every cascade', () => {
    const callers = callersOf('removeFileLinksThisInstanceWrote');
    assert.ok(callers.some(f => f.file === 'server/src/files/remove-file-here.ts' && f.name === 'removeLinksOfDeletedFiles'), 'the delete\'s link step does not call the remover');
    assert.ok(callers.some(f => f.file === 'server/src/files/leaked-rows-repair.ts'), 'the repair does not call the remover');
    // The delete path: every function that removes a file's rows and bytes (the cascades) calls the link step, not a spelling of its own.
    const steps = callersOf('removeLinksOfDeletedFiles').filter(f => f.file === 'server/src/files/delete-cascade.ts').map(f => f.name).sort();
    assert.deepEqual(steps, ['deleteDirectoryCascade', 'deleteFileCascade', 'removeWhatAMovedFileLeftAtItsSource'], 'a cascade stopped calling the one link step, or one grew a second path');
  });

  it('the author-filtered copy the repair once had is not defined or called anywhere', () => {
    const named = SOURCES.filter(f => /\bremoveLinksWrittenBy\b/.test(textOf(f)));
    assert.deepEqual(named, [], 'removeLinksWrittenBy is back: it reads a missing author as nobody\'s, which the delete does not');
  });

  it('the remover selects through the one author rule and writes a tombstone per row', () => {
    const remover = bodyOf('server/src/brain/links.ts', 'removeFileLinksThisInstanceWrote');
    assert.ok(callsIn(remover).has('fileLinksThisInstanceWrote'), 'the remover no longer selects through the one author rule');
    assert.ok(callsIn(remover).has('removeWithTombstones'), 'the remover no longer writes a tombstone per removed link');
    assert.match(textOf('server/src/brain/link-adjacency.ts'), /author: \{ \$exists: false \}/, 'the one rule lost its missing-author clause');
  });

  it('no other source that reads the links collection spells the link author test', () => {
    const readsLinks = textsMatching(/spaceCollection\([^)]*'links'\)|\bLinkDoc\b/);
    assert.ok(readsLinks.length >= 5, `only ${readsLinks.length} sources read the links collection: the scan reads none`);
    const AUTHOR_TEST = /author\??\.instanceId\s*===|author: \{ \$exists: false \}|'author\.instanceId'\s*:\s*(?:self|authorRef)/;
    const spellers = readsLinks.filter(f => AUTHOR_TEST.test(textOf(f)));
    assert.deepEqual(spellers, ['server/src/brain/link-adjacency.ts'], 'a source that reads links spells the author test itself: the second copy of "which links are this instance\'s"');
  });
});

describe('a caught file-act failure is answered by one function', () => {
  it('every door\'s catch calls answerFileActFailure, and the only other caller of fileActAnswer is named', () => {
    const doors = new Set(callersOf('answerFileActFailure').map(f => f.file));
    for (const door of ['server/src/api/send-failure.ts', 'server/src/mcp/call-tool.ts', 'server/src/api/conflicts.ts']) {
      assert.ok(doors.has(door), `${door} does not call answerFileActFailure`);
    }
    // Who may classify a failure into an answer by hand: the one function, and the conflicts' bulk item, which wraps a raw file-system error
    // it was handed into the file-system fault sentence (it counts nothing and reports nothing: that step is `answerFileActFailure`'s).
    const ALLOWED = new Map([
      ['server/src/files/act-failure-answer.ts', 'is the one function'],
      ['server/src/api/conflicts.ts', 'wraps a raw file-system error into the fault sentence for a bulk item'],
    ]);
    const classifiers = [...new Set(callersOf('fileActAnswer').map(f => f.file))].filter(f => f !== 'server/src/files/act-answers.ts');
    assert.deepEqual(classifiers.filter(f => !ALLOWED.has(f)), [], 'a source classifies a failure into an answer itself: the second copy of the count and the report');
    for (const door of ['server/src/api/send-failure.ts', 'server/src/mcp/call-tool.ts']) assert.ok(!classifiers.includes(door), `${door} calls fileActAnswer itself`);
  });

  it('counts the answer and reports a server-side cause, and neither for a failure that is not a file act\'s or for a 409', async () => {
    const answers = await import('../../server/dist/files/act-answers.js');
    const { answerFileActFailure } = await import('../../server/dist/files/act-failure-answer.js');
    const { fileActAnswerCounts } = answers;
    const { log } = await import('../../server/dist/util/log.js');
    const before = fileActAnswerCounts();
    assert.equal(answerFileActFailure(new Error('not a file act'), 'test op'), undefined);
    assert.deepEqual(fileActAnswerCounts(), before, 'a failure that is not a file act\'s was counted');

    const lines = [];
    const original = log.error;
    log.error = (...args) => { lines.push(args.map(String).join(' ')); };
    try {
      const refusal = answerFileActFailure(new answers.DestinationExists('x.txt', 'bytes'), 'test op');
      assert.equal(refusal?.status, 409);
      assert.equal(fileActAnswerCounts().destination_exists, before.destination_exists + 1, 'the answer was not counted');
      assert.deepEqual(lines, [], 'a 409 is the caller\'s and was reported as a server failure');
      const fault = answerFileActFailure(new answers.FileSystemFault(Object.assign(new Error('EIO'), { code: 'EIO' })), 'test op');
      assert.equal(fault?.status, 500);
      assert.ok(lines.length >= 1, 'a file-system fault left nothing in the log');
    } finally {
      log.error = original;
    }
  });
});

describe('the live config entry of a space is changed and saved in one place', () => {
  it('every write of a local-bookkeeping key of the entry is inside changeSpaceEntries, and no caller of it saves the config itself', () => {
    const callers = [...new Set(callersOf('changeSpaceEntries').map(f => f.file))];
    assert.ok(callers.length >= 2, `${callers.length} sources call changeSpaceEntries: the scan reads none`);
    const BOOKKEEPING = /\.(?:deliveredByBackfilled|leakedRowScan)\s*=(?!=)/g;
    for (const file of SOURCES.filter(f => f !== 'server/src/config/types.ts')) {
      const text = textOf(file);
      for (const m of text.matchAll(BOOKKEEPING)) {
        const opener = text.lastIndexOf('changeSpaceEntries(', m.index);
        assert.ok(opener >= 0 && m.index - opener < 400, `${file} writes a space's bookkeeping key outside changeSpaceEntries: the second copy of read the live entry, change it, save`);
      }
    }
    for (const file of callers) assert.doesNotMatch(textOf(file), /\bsaveConfig\(/, `${file} calls changeSpaceEntries and saves the config itself`);
  });
});

describe('a destination\'s two verdicts are written once', () => {
  it('the functions that ask a destination question end in the one core, and no other function throws the pair', () => {
    const core = 'assertNeitherBytesNorRecord';
    const askers = callersOf(core).filter(f => f.file === 'server/src/files/destination.ts').map(f => f.name).sort();
    assert.deepEqual(askers, ['assertDestinationFree', 'assertNothingStandsAt'], 'a destination question stopped ending in the shared core (or a new one does not)');
    // The verdicts are the standings `bytes` and `record`; the one other site is named: placeIfFree answers the no-overwrite primitive's own
    // refusal (the link found the name taken), which is the same verdict reached by the race and not by a read.
    const EXEMPT = new Map([['server/src/files/files.ts:placeIfFree', 'answers the no-overwrite primitive\'s refusal, not a read of the destination']]);
    const throwers = FUNCTIONS.filter(f => /new DestinationExists\([^)]*'(?:bytes|record)'/.test(f.body) && f.name !== core)
      .map(f => `${f.file}:${f.name}`).filter(k => !EXEMPT.has(k));
    assert.deepEqual(throwers, [], 'a function throws the bytes/record verdict itself instead of through the core');
  });
});

describe('the client\'s act-code list reads code, not prose', () => {
  it('strips the server module\'s comments with the shared stripper before it reads a code', () => {
    const helper = readFileSync(join(REPO_ROOT, 'client/src/app/testing/server-act-codes.ts'), 'utf8');
    assert.match(helper, /_strip-comments\.mjs/, 'the client helper does not use the shared comment stripper');
    assert.match(helper, /stripComments\(readFileSync\(ACT_ANSWERS/, 'the module is read without its comments stripped');
  });
});
