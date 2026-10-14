/**
 * The second copies bundle-113's diff pass found were merged into one module each; this holds each at one (CLAUDE.md "Reuse a module" and
 * "One rule, two implementations"). Each case asks a RULE of the sources — never a list of the files that used to hold a copy.
 *
 *  1. **The links a file delete owes**: "which link rows are this instance's" is `fileLinksThisInstanceWrote`'s alone (a missing author is
 *     this instance's) and "remove them with tombstones" is `removeFileLinksThisInstanceWrote`'s; the delete and the repair both call it,
 *     and the author-filtered removal that the repair had (`removeLinksWrittenBy`, which read a missing author as nobody's) is gone.
 *  2. **A caught file-act failure**: `answerFileActFailure` counts the answer and reports a 5xx cause; the REST catch, the MCP dispatcher
 *     and the bulk resolution call it and none calls `fileActAnswer` for that step itself.
 *  3. **The live config entry of a space**: `changeSpaceEntries` is how the back-fill's marker and the repair's restart change and save it.
 *  4. **A destination's two verdicts** (occupied bytes, a live record unless the state is an alias): written once, for a move and for a
 *     placing.
 *  5. **The client's code list** reads the server module without its comments, by the stripper the source gates use.
 *
 * Run: node --test testing/standalone/a-rule-the-bundle-113-dedupe-merged-stays-one-copy.test.js (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { join } from 'node:path';

const read = (rel) => stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8').replaceAll('\r\n', '\n'));
/** The text of one top-level function: from its declaration to the next line that is a lone closing brace. */
function functionBody(src, name) {
  const at = src.search(new RegExp(`function ${name}\\b`));
  assert.notEqual(at, -1, `no function ${name}: it moved, so re-point this gate`);
  const end = src.indexOf('\n}\n', at);
  return src.slice(at, end === -1 ? src.length : end);
}

describe('the links a file delete owes are selected and removed in one place', () => {
  const links = read('server/src/brain/links.ts');
  const delet = read('server/src/files/remove-file-here.ts');
  const repair = read('server/src/files/leaked-rows-repair.ts');
  const adjacency = read('server/src/brain/link-adjacency.ts');

  it('the delete and the repair call the one remover, and the author-filtered copy is gone', () => {
    assert.match(delet, /removeFileLinksThisInstanceWrote\(/, 'the delete no longer calls the remover');
    assert.match(repair, /removeFileLinksThisInstanceWrote\(/, 'the repair no longer calls the remover');
    assert.doesNotMatch(links, /removeLinksWrittenBy/, 'the repair\'s own author-filtered remover is back');
    assert.doesNotMatch(repair, /removeLinksWrittenBy/);
  });

  it('the remover selects through the one author rule, and no other source spells the link author test', () => {
    assert.match(functionBody(links, 'removeFileLinksThisInstanceWrote'), /fileLinksThisInstanceWrote\(/);
    assert.match(adjacency, /author: \{ \$exists: false \}/, 'the one rule lost its missing-author clause');
    for (const [file, src] of [['links.ts', links], ['remove-file-here.ts', delet], ['leaked-rows-repair.ts', repair]]) {
      assert.doesNotMatch(src, /author\??\.instanceId\s*===/, `${file} compares a link's author itself: it is the second author predicate`);
    }
  });

  it('writes a tombstone per removed row: the remover goes through removeWithTombstones', () => {
    assert.match(functionBody(links, 'removeFileLinksThisInstanceWrote'), /removeWithTombstones\(/);
  });
});

describe('a caught file-act failure is answered by one function', () => {
  const sendFailure = read('server/src/api/send-failure.ts');
  const callTool = read('server/src/mcp/call-tool.ts');
  const conflicts = read('server/src/api/conflicts.ts');

  it('the REST catch, the MCP dispatcher and the bulk resolution call it, and the first two never call fileActAnswer', () => {
    for (const [file, src] of [['send-failure.ts', sendFailure], ['call-tool.ts', callTool], ['conflicts.ts', conflicts]]) {
      assert.match(src, /answerFileActFailure\(/, `${file} does not call answerFileActFailure`);
    }
    for (const [file, src] of [['send-failure.ts', sendFailure], ['call-tool.ts', callTool]]) {
      assert.doesNotMatch(src, /\bfileActAnswer\(/, `${file} classifies the failure itself: the second copy of the count and the report`);
    }
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
  it('the back-fill and the repair\'s restart both call changeSpaceEntries, and the back-fill saves nothing itself', () => {
    const backfill = read('server/src/sync/delivered-by-backfill.ts');
    const repair = read('server/src/files/leaked-rows-repair.ts');
    assert.match(backfill, /changeSpaceEntries\(/);
    assert.match(repair, /changeSpaceEntries\(/);
    assert.doesNotMatch(backfill, /saveConfig\(/, 'the back-fill saves the config itself: the second copy of read, change and save');
  });
});

describe('a destination\'s two verdicts are written once', () => {
  it('a move\'s question and a placing\'s both end in the one core, and neither throws the pair itself', () => {
    const src = read('server/src/files/destination.ts');
    for (const name of ['assertDestinationFree', 'assertNothingStandsAt']) {
      const body = functionBody(src, name);
      assert.match(body, /assertNeitherBytesNorRecord\(/, `${name} no longer ends in the shared core`);
      assert.doesNotMatch(body, /new DestinationExists\(requested, '(?:bytes|record)'/, `${name} throws the bytes/record verdict itself`);
    }
  });
});

describe('the client\'s act-code list reads code, not prose', () => {
  it('strips the server module\'s comments with the shared stripper before it reads a code', () => {
    const helper = readFileSync(join(REPO_ROOT, 'client/src/app/testing/server-act-codes.ts'), 'utf8');
    assert.match(helper, /_strip-comments\.mjs/, 'the client helper does not use the shared comment stripper');
    assert.match(helper, /stripComments\(readFileSync\(ACT_ANSWERS/, 'the module is read without its comments stripped');
  });
});
