/**
 * A file can be written as bytes through either door, and both doors mean the same thing by it.
 *
 * ## The report
 *
 * the canary operator, 2026-09-08T2340Z: a coding session of theirs was asked to put a photograph of a
 * whiteboard on a roadmap record and could not. `write_file` is the only file-writing tool a write-capable
 * token is offered, its `content` is a JSON string, and there was no `encoding` — so **a session reached
 * through MCP could create a text file and could never create a byte file**, while `POST /api/files/*` had
 * taken `{ content, encoding: 'base64' }` throughout.
 *
 * `CLAUDE.md` is explicit that this is the same defect as a missing capability: *a capability present on
 * both surfaces still violates the rule if one door accepts less*. Storage, type sniffing, the media
 * pipeline, the quota check and the chunking were already shared — only the door was narrower.
 *
 * ## What this gate holds, and why it is three separate things
 *
 * **The vocabulary is one list.** Both doors are checked against `CONTENT_ENCODINGS` in
 * `files/content-encoding.ts`, so a third encoding cannot arrive on one door alone — which is the shape the
 * original defect had.
 *
 * **Neither door decodes for itself.** Two decoders is one rule twice, and the weaker copy wins silently
 * here in a way nobody can see: `Buffer.from(s, 'base64')` SKIPS every character outside the alphabet
 * rather than failing, so the copy that forgot to validate stores a short, corrupt file under a success.
 *
 * **And the refusal is the same refusal.** A 400 on one door and a stored-but-wrong file on the other is
 * worse than either alone, because the behaviour then depends on which client the caller happened to pick.
 *
 * ## Seen red
 *
 * By mutation, three ways: dropping `encoding` from the tool schema, decoding in the route with a bare
 * `Buffer.from`, and removing the base64 character check from the module.
 *
 * Run: node --test testing/standalone/both-file-doors-take-the-same-encodings.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const src = p => stripComments(readFileSync(join(REPO_ROOT, p), 'utf8'));

const MODULE = 'server/src/files/content-encoding.ts';
const TOOL = 'server/src/mcp/tools/file.ts';
const ROUTE = 'server/src/api/files-upload.ts';

/**
 * The encodings, READ OUT OF the module that declares them rather than written here.
 *
 * A list in a gate is a second copy of the thing under test, and the two agree right up to the day
 * somebody adds a third encoding — at which point the gate reports that both doors support the two it
 * still knows about, which is true and useless.
 */
function declaredEncodings() {
  const m = /export const CONTENT_ENCODINGS = \[([^\]]*)\]/.exec(src(MODULE));
  assert.ok(m, `could not read CONTENT_ENCODINGS out of ${MODULE} — re-anchor this gate`);
  const found = [...m[1].matchAll(/'([a-z0-9]+)'/g)].map(x => x[1]);
  assert.ok(found.length >= 2,
    `only ${found.length} encoding(s) declared (${found.join(', ') || 'none'}); a short list makes every `
    + 'assertion below check less than it claims');
  return found;
}

describe('one vocabulary, read from the module that owns it', () => {
  const encodings = declaredEncodings();

  it('the MCP tool offers every declared encoding', async () => {
    /*
     * The BUILT schema, not the source text. A caller reads what `tools/list` hands them, and the schema is
     * free to spread `CONTENT_ENCODINGS` rather than spell the two out — a source grep calls that missing
     * and would push the tool towards a second hand-written copy of the list to appease a gate.
     */
    const { write_fileTool } = await import('../../server/dist/mcp/tools/file.js');
    const schema = write_fileTool.inputSchema({ requiredSpace: {}, optionalSpace: {} });
    const enumerated = schema?.properties?.encoding?.enum;
    assert.ok(Array.isArray(enumerated), '`write_file` declares no `encoding` at all — a session reached '
      + 'through MCP can write text and can never write bytes, which is the parity defect this gate exists for');
    assert.deepEqual([...enumerated].sort(), [...encodings].sort(),
      'the write_file schema and the module disagree about which encodings exist');
    assert.equal(schema.properties.encoding.default, 'utf8',
      'the default must stay utf8, or every existing caller writing text starts writing something else');
  });

  it('and it names the ceiling, so the next caller does not bisect an image to find it', async () => {
    // Asked for by name in the report: base64 inflates by a third and the cap is the JSON body, not the
    // file store, so a refusal that says only "too large" sends the caller looking at the wrong limit.
    const { write_fileTool } = await import('../../server/dist/mcp/tools/file.js');
    const d = write_fileTool.inputSchema({ requiredSpace: {}, optionalSpace: {} }).properties.encoding.description;
    assert.match(d, /10 MB/, 'the encoding description must name the request-body ceiling');
    assert.match(d, /api\/files/, 'it must point at the door that takes a bigger file');
  });

  it('the REST route accepts every declared encoding', () => {
    const route = src(ROUTE);
    for (const enc of encodings) {
      assert.ok(route.includes(enc),
        `${ROUTE} no longer mentions '${enc}' — the doors have drifted apart`);
    }
  });
});

describe('one decoder, because the guard is the part a second copy drops', () => {
  it('neither door calls Buffer.from with an encoding of its own', () => {
    /*
     * The specific shape that loses data. `Buffer.from(s, 'base64')` skips characters outside the alphabet
     * and decodes the rest, so a door with its own decode accepts a `data:` URL prefix and stores a short,
     * corrupt file under a 2xx — with a sha256 and a size like any other file, and nothing downstream able
     * to tell.
     */
    for (const path of [TOOL, ROUTE]) {
      const own = [...src(path).matchAll(/Buffer\.from\([^)]*(?:base64|encoding)[^)]*\)/g)].map(m => m[0]);
      assert.deepEqual(own, [],
        `${path} decodes content itself:\n  ${own.join('\n  ')}\n`
        + 'Both doors must go through `decodeContent` — a second decode is a second place for the base64 '
        + 'validation to be missing, and the copy without it fails silently.');
    }
  });

  it('both doors reach the shared decoder', () => {
    for (const path of [TOOL, ROUTE]) {
      assert.match(src(path), /decodeContent/,
        `${path} does not use the shared decoder, so its rule for turning content into bytes is its own`);
    }
  });
});

describe('the decoder refuses rather than returning bytes it cannot vouch for', () => {
  let decodeContent;
  let CONTENT_ENCODINGS;

  before(async () => {
    ({ decodeContent, CONTENT_ENCODINGS } = await import('../../server/dist/files/content-encoding.js'));
  });

  it('utf8 is the default, so an omitted encoding writes what it used to', () => {
    assert.equal(decodeContent('hello').toString('utf8'), 'hello');
    assert.equal(decodeContent('hello', undefined).toString('utf8'), 'hello');
  });

  it('base64 round-trips', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.deepEqual(decodeContent(bytes.toString('base64'), 'base64'), bytes);
  });

  it('a data URL prefix is REFUSED, not silently skipped', () => {
    // The one a caller actually sends. `Buffer.from` accepts it and drops the prefix characters, so the
    // stored file is short by a few bytes and corrupt from its first byte onward.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    assert.throws(() => decodeContent(`data:image/png;base64,${png}`, 'base64'), /not base64/);
  });

  it('prose is refused', () => {
    assert.throws(() => decodeContent('this is a whiteboard photo, honestly', 'base64'), /not base64/);
  });

  it('whitespace inside base64 is fine, because encoders wrap', () => {
    const bytes = Buffer.from('a somewhat longer payload so that wrapping is realistic');
    const wrapped = bytes.toString('base64').replace(/(.{20})/g, '$1\n');
    assert.deepEqual(decodeContent(wrapped, 'base64'), bytes);
  });

  it('an unknown encoding names what is on offer', () => {
    assert.throws(() => decodeContent('x', 'hex'), err => {
      for (const enc of CONTENT_ENCODINGS) assert.match(err.message, new RegExp(enc));
      return true;
    });
  });

  it('it throws a RangeError, which is what both doors already map to a refusal', () => {
    assert.throws(() => decodeContent('x', 'hex'), RangeError);
    assert.throws(() => decodeContent('%%%%', 'base64'), RangeError);
  });
});
