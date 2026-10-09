/**
 * A file's type is derived from its name when the caller does not state one.
 *
 * ## The bug
 *
 * External vision failed 100% of the time on 2.0.0 for `visionProvider: external`:
 *
 *     POST /v1/chat/completions -> 500 in ~120ms
 *     {"error":{"code":500,"message":"Invalid uri format: data:application/octet-stream;base64", ...}}
 *
 * The report read it as a hardcoded type in the vision request. It was not. `ExternalVisionProvider`
 * interpolates whatever MIME it is handed; the wrong value arrived from three entry points at once:
 * the web UI set `application/octet-stream` on every upload regardless of file, MCP `write_file`
 * sends no Content-Type at all, and `dispatchFileProcessing` defaulted both to a byte blob without
 * ever consulting the extension — on the line directly after `resolveInputFormat` had classified the
 * same file as an image *by that extension*.
 *
 * So the assertion worth pinning is not "vision builds a good data URI". It is that the type is
 * resolved from the name, at the one boundary all three entry points pass through.
 *
 * ## What else it broke
 *
 * The same wrong value reached four other consumers, none of them reported:
 *
 *   - Whisper's multipart filename (`audio.octet-stream`), which OpenAI rejects — its endpoint
 *     validates the extension against a whitelist;
 *   - ffmpeg's audio input name (`input.bin`);
 *   - ffmpeg's video input name — every video written as `input.mp4`;
 *   - the face-recognition re-enqueue, whose own inline map defaulted to `image/jpeg`, so a `.png`
 *     was not merely unknown but actively mislabelled.
 *
 * Run: node --test testing/standalone/media-mime-type.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources } from './_sources.mjs';
import { readFileSync } from 'node:fs';

const MIME_SRC = 'server/src/files/mime.ts';

/**
 * Load the real module rather than restating its rules.
 *
 * A test that reimplements the table would only prove it agrees with itself — which is exactly how
 * the storage-quota bug in the previous release survived, a spec and a type wrong together. The
 * compiled output is used when present; otherwise the source is transpiled on the fly.
 */
const mime = await (async () => {
  // Transpile the real source with the real compiler. Hand-rolled type-stripping was tried first and
  // rejected: a regex that mangles one annotation silently changes what is under test, and the whole
  // point of loading the module is that the test must not be able to disagree with the source.
  const ts = await import('typescript');
  const js = ts.default.transpileModule(readFileSync(MIME_SRC, 'utf8'), {
    compilerOptions: { module: ts.default.ModuleKind.ESNext, target: ts.default.ScriptTarget.ES2022 },
  }).outputText;
  const b64 = Buffer.from(js, 'utf8').toString('base64');
  return await import(`data:text/javascript;base64,${b64}`);
})();

const { mimeTypeForPath, extForMimeType, isInformativeMimeType, sniffImageMimeType, contentTypeForDownload } = mime;

describe('the reported failure', () => {
  it('a .png with no stated type resolves to image/png, not a byte blob', () => {
    // The exact shape of the report: an image uploaded with a generic header.
    assert.equal(mimeTypeForPath('/photos/cat.png', 'application/octet-stream'), 'image/png');
  });

  it('and with no header at all — the MCP write_file path', () => {
    assert.equal(mimeTypeForPath('/photos/cat.png'), 'image/png');
  });

  it('the data URI that reaches the model is therefore valid', () => {
    const uri = `data:${mimeTypeForPath('/photos/cat.png', 'application/octet-stream')};base64,AAAA`;
    assert.equal(uri.startsWith('data:image/png;base64,'), true);
    assert.doesNotMatch(uri, /octet-stream/);
  });
});

describe('a stated type is respected when it says something', () => {
  it('a specific declared type wins over the extension', () => {
    // The caller may genuinely know better; this preserves resolveInputFormat's existing precedence.
    assert.equal(mimeTypeForPath('/f/thing.bin', 'image/webp'), 'image/webp');
  });

  it('parameters are stripped so the value is usable in a data URI', () => {
    assert.equal(mimeTypeForPath('/f/page.html', 'text/html; charset=utf-8'), 'text/html');
  });

  it('aliases are folded onto the canonical spelling', () => {
    assert.equal(mimeTypeForPath('/f/clip.wav', 'audio/x-wav'), 'audio/wav');
  });
});

describe('which stated types count as "not stated"', () => {
  for (const generic of [
    'application/octet-stream',
    'binary/octet-stream',
    'application/binary',
    '*/*',
    '',
    'nonsense-without-a-slash',
  ]) {
    it(`${generic || '(empty)'} defers to the extension`, () => {
      assert.equal(isInformativeMimeType(generic), false);
      assert.equal(mimeTypeForPath('/photos/cat.png', generic), 'image/png');
    });
  }

  it('undefined defers to the extension', () => {
    assert.equal(isInformativeMimeType(undefined), false);
  });

  it('octet-stream survives only when the extension is unknown too', () => {
    // The one case where it is a true statement rather than a shrug.
    assert.equal(mimeTypeForPath('/f/mystery.qqq', 'application/octet-stream'), 'application/octet-stream');
  });
});

describe('every format the pipeline classifies has a real type', () => {
  // If the conversion pipeline will route a file to a provider, the provider must be able to name it.
  // Reading the pipeline's own table keeps the two from drifting — the drift is the whole bug.
  const pipelineSrc = readFileSync('server/src/files/converters/pipeline.ts', 'utf8');
  const extMapBlock = pipelineSrc.slice(
    pipelineSrc.indexOf('const EXT_MAP'),
    pipelineSrc.indexOf('};', pipelineSrc.indexOf('const EXT_MAP')),
  );
  const exts = [...extMapBlock.matchAll(/'(\.[a-z0-9]+)':/g)].map(m => m[1]);

  it('the pipeline table was actually found', () => {
    assert.ok(exts.length > 20, `expected the pipeline EXT_MAP, parsed ${exts.length} entries`);
  });

  for (const ext of exts) {
    it(`${ext} resolves to a concrete type`, () => {
      const resolved = mimeTypeForPath(`/f/file${ext}`);
      assert.notEqual(resolved, 'application/octet-stream');
      assert.match(resolved, /^[a-z]+\/[a-z0-9.+-]+$/);
    });
  }
});

describe('MIME to extension — the filenames ffmpeg and Whisper are given', () => {
  it('audio/x-wav yields wav, not x-wav', () => {
    // `mimeType.split('/')[1]` produced `x-wav`; OpenAI's transcription endpoint validates the
    // extension against a whitelist and rejects anything off it.
    assert.equal(extForMimeType('audio/x-wav', 'wav'), 'wav');
  });

  it('audio/mpeg yields mp3', () => {
    assert.equal(extForMimeType('audio/mpeg', 'wav'), 'mp3');
  });

  it('audio/mp4 yields m4a', () => {
    assert.equal(extForMimeType('audio/mp4', 'wav'), 'm4a');
  });

  it('video/webm yields webm, so a webm is no longer written as input.mp4', () => {
    assert.equal(extForMimeType('video/webm', 'mp4'), 'webm');
  });

  it('the OpenAI whitelist is satisfied for every audio type we produce', () => {
      // set-claim: the audio extensions OpenAI's transcription endpoint accepts -- an EXTERNAL whitelist
      // this codebase must satisfy, not a set it defines.
    const allowed = new Set(['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']);
    for (const ext of ['.mp3', '.wav', '.ogg', '.m4a', '.flac']) {
      const produced = extForMimeType(mimeTypeForPath(`/a/clip${ext}`), 'wav');
      assert.ok(allowed.has(produced), `${ext} produced "${produced}", which OpenAI rejects`);
    }
  });

  it('an unknown type falls back to the fallback the caller passed', () => {
    assert.equal(extForMimeType('application/octet-stream', 'bin'), 'bin');
    assert.equal(extForMimeType('application/octet-stream', 'mp4'), 'mp4');
  });

  it('a type with several spellings yields the canonical one', () => {
    // The table is inverted first-listing-wins, which is what makes this deterministic. Left untested
    // it silently becomes last-wins on any reordering, and `.htm`/`.oga`/`.jpeg` start appearing where
    // the canonical extension is expected.
    assert.equal(extForMimeType('image/jpeg', 'x'), 'jpg');
    assert.equal(extForMimeType('text/html', 'x'), 'html');
    assert.equal(extForMimeType('audio/ogg', 'x'), 'ogg');
    assert.equal(extForMimeType('text/yaml', 'x'), 'yaml');
    assert.equal(extForMimeType('image/tiff', 'x'), 'tiff');
  });
});

describe('sniffing — the defence that cannot be lied to', () => {
  // A job row queued by an older build carries the old MIME and is retried after the upgrade.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(8)]);
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]);

  it('PNG', () => assert.equal(sniffImageMimeType(png), 'image/png'));
  it('JPEG', () => assert.equal(sniffImageMimeType(jpeg), 'image/jpeg'));
  it('GIF', () => assert.equal(sniffImageMimeType(gif), 'image/gif'));
  it('WEBP', () => assert.equal(sniffImageMimeType(webp), 'image/webp'));
  it('a short buffer is not guessed at', () => assert.equal(sniffImageMimeType(Buffer.alloc(4)), undefined));

  it('a truncated file is not claimed as its signature', () => {
    // The length guard has to be load-bearing: these three bytes ARE the JPEG signature, but three
    // bytes are not a JPEG. Reporting a type for a file too short to have one would send a corrupt
    // upload to the model as though it were sound.
    assert.equal(sniffImageMimeType(Buffer.from([0xff, 0xd8, 0xff])), undefined);
    assert.equal(sniffImageMimeType(Buffer.from([0x42, 0x4d])), undefined);
  });
  it('unrecognised bytes yield undefined so the caller keeps its fallback', () => {
    assert.equal(sniffImageMimeType(Buffer.alloc(32)), undefined);
  });
});

describe('downloads keep their charset', () => {
  it('text types carry charset=utf-8', () => {
    assert.equal(contentTypeForDownload('/f/notes.md'), 'text/markdown; charset=utf-8');
    assert.equal(contentTypeForDownload('/f/data.json'), 'application/json; charset=utf-8');
  });

  it('binary types do not', () => {
    assert.equal(contentTypeForDownload('/f/cat.png'), 'image/png');
  });

  it('and a charset never leaks into the processing type', () => {
    // The two functions are separate precisely so `; charset=utf-8` cannot reach a data URI.
    assert.equal(mimeTypeForPath('/f/notes.md'), 'text/markdown');
  });
});

// ── The call sites, so a future edit cannot quietly reintroduce the default ──

describe('the entry points all go through the shared resolver', () => {
  const strip = src => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  it('dispatch derives the type instead of defaulting it', () => {
    const src = strip(readFileSync('server/src/files/dispatch.ts', 'utf8'));
    assert.match(src, /mimeTypeForPath\(filePath, input\.contentType\)/);
    assert.doesNotMatch(src, /\?\?\s*'application\/octet-stream'/);
  });

  it('the media worker re-derives, so a pre-upgrade job row heals itself', () => {
    // Without this, an instance upgrading with a backlog reproduces the original failure on every
    // retry forever — the fix would appear not to work for exactly the users who hit the bug.
    const src = strip(readFileSync('server/src/files/media/worker.ts', 'utf8'));
    assert.match(src, /mimeTypeForPath\(filePath, job\.mimeType\)/);
  });

  it('external vision never emits a generic data URI', () => {
    const src = strip(readFileSync('server/src/files/media/providers.ts', 'utf8'));
    assert.match(src, /isInformativeMimeType\(mimeType\)/);
    assert.match(src, /sniffImageMimeType\(await readHeader\(image\)\)/);
  });

  it('Whisper names its upload from the table, not by splitting the MIME', () => {
    // `mimeType.split('/')[1]` is not an extension derivation. It yields `x-wav` for audio/x-wav and
    // `octet-stream` for an untyped job — both rejected by OpenAI's extension whitelist.
    const src = strip(readFileSync('server/src/files/media/providers.ts', 'utf8'));
    assert.match(src, /extForMimeType\(mimeType, 'wav'\)/);
    assert.doesNotMatch(src, /mimeType\.split\('\/'\)\[1\]/);
  });

  it('the web UI stops labelling every upload as bytes', () => {
    const src = strip(readFileSync('client/src/app/core/files-api.service.ts', 'utf8'));
    assert.doesNotMatch(src, /'Content-Type':\s*'application\/octet-stream'/);
    assert.match(src, /'Content-Type':\s*uploadType/);
  });

  it('but still withholds application/json, which the global body parser would intercept', () => {
    // express.json is mounted ahead of the file router; forwarding the true type would divert a
    // .json upload into the JSON {content} branch and corrupt it.
    const src = strip(readFileSync('client/src/app/core/files-api.service.ts', 'utf8'));
    assert.match(src, /application\\\/json/);
  });

  it('no inline MIME table survives outside the shared module', () => {
    // Four partial copies existed; each disagreed with the others about some extension.
    // `git ls-files`, never a directory walk: gitignored and Docker-written files under the working
    // tree have broken this kind of check before (EACCES on a 0600 file that CI never tracked).
    const files = trackedSources(['server/src', 'client/src']);
    const offenders = [];
    for (const f of files) {
      if (f === MIME_SRC) continue;
      const src = strip(readFileSync(f, 'utf8'));
      // A map literal with two or more image/audio/video MIME values is a private table.
      const mimeLiterals = [...src.matchAll(/'(?:image|audio|video)\/[a-z0-9.+-]+'/g)].length;
      if (mimeLiterals >= 3) offenders.push(`${f} (${mimeLiterals} media MIME literals)`);
    }
    assert.deepEqual(offenders, [], `these files still carry their own MIME table:\n  ${offenders.join('\n  ')}`);
  });
});
