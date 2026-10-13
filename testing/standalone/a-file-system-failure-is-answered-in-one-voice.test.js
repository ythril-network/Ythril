/**
 * A file-system failure that is the server's is answered one way, on every door, in words that name no path (bundle-44, S5).
 *
 * ## The defect
 *
 * `FileSystemFault` (a failed `mkdir`/`rename` that is not about the caller's path) was answered `500` path-free by the MCP
 * dispatcher's own branch and by nothing else: a REST route answered it through its own fallback (`Failed to move path`). And the
 * sentence a store-failure refusal says about a file-system error was a second implementation of the one the fault says.
 *
 * ## What this pins
 *
 *  1. `fileActAnswer` answers a `FileSystemFault` itself: `500`, code `file_system_fault`, no path, no `Retry-After` — the one
 *     answer `api/send-failure.ts` and `mcp/call-tool.ts` both read.
 *  2. The sentence carries the errno code and never the error's own message (which holds the server's absolute data path).
 *  3. A store-failure refusal and a file act's fault say the same words about the same code.
 *
 * Run: node --test testing/standalone/a-file-system-failure-is-answered-in-one-voice.test.js (requires a prior `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let fileActAnswer, FileSystemFault, fsRefusalOf, refusalText;
before(async () => {
  ({ fileActAnswer, FileSystemFault } = await import('../../server/dist/files/act-answers.js'));
  ({ fsRefusalOf } = await import('../../server/dist/files/destination.js'));
  ({ refusalText } = await import('../../server/dist/brain/store-failure.js'));
});

const SECRET = '/srv/ythril/data/spaces/s1/files/private/dir';
const fsError = (code) => Object.assign(new Error(`${code}: operation failed, rename '${SECRET}/a' -> '${SECRET}/b'`), { code, syscall: 'rename', path: `${SECRET}/a` });

describe('a file-system failure of the server is answered in one voice', () => {
  it('fileActAnswer answers the fault: 500, file_system_fault, no path, no Retry-After', () => {
    const answer = fileActAnswer(fsRefusalOf(fsError('EACCES'), ['a', 'b']));
    assert.ok(answer, 'fileActAnswer did not recognise the fault');
    assert.equal(answer.status, 500);
    assert.equal(answer.body.code, 'file_system_fault');
    assert.equal(answer.body.path, undefined);
    assert.equal(answer.retryAfterSeconds, undefined);
  });

  it('the sentence names the code and nothing of the path the filesystem put in its message', () => {
    const err = new FileSystemFault(fsError('EACCES'));
    assert.ok(err.message.includes('EACCES'), err.message);
    assert.ok(!err.message.includes(SECRET), 'the fault repeats the server path');
    assert.ok(!JSON.stringify(fileActAnswer(err)).includes(SECRET), 'the answer repeats the server path');
  });

  it('a failure with no usable code is `unknown`, never its text', () => {
    assert.ok(new FileSystemFault(new Error(SECRET)).message.includes('unknown'));
    assert.ok(new FileSystemFault(fsError('not a code /srv/x')).message.includes('unknown'));
  });

  it('a store-failure refusal and a file act fault say the same words about the same code', () => {
    assert.equal(refusalText(fsError('EIO')), new FileSystemFault(fsError('EIO')).message);
  });
});
