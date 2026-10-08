/**
 * FFmpeg stays a SEPARATE PROCESS, and no bundled ffmpeg binary sneaks in through npm.
 *
 * ## What this checks, and what it deliberately does not
 *
 * `NOTICE` documents Debian's ffmpeg as GPL-2.0-or-later and rests its position on one load-bearing fact: the
 * executable is **invoked as a separate process and never linked into Ythril**. That is the same argument the
 * file already makes for LibreOffice via `soffice`.
 *
 * **That fact is the only thing here worth a test.** An earlier version of this file also asserted that the
 * NOTICE section existed, that it named the right licence, that its source offer pointed somewhere, and that its
 * wording matched the Dockerfile comment — seven assertions guarding static prose. Prose does not drift on its
 * own, nothing regenerates that section, and "the paragraph is still in the file" is not a property worth
 * running on every preflight. Cut, on the owner's standard: a check earns its place by catching something that
 * can actually change.
 *
 * What CAN change is the mechanism. If somebody swaps the subprocess for a native binding, a WASM build, or an
 * npm package that ships its own ffmpeg binary, then:
 *
 *   - the "separate process, not linked" claim in NOTICE becomes false, and
 *   - a *different* ffmpeg binary is being redistributed through a channel NOTICE does not describe.
 *
 * Neither would fail any other test. Both are one plausible refactor away — reaching for `fluent-ffmpeg` or
 * `ffmpeg-static` is the obvious move for anyone tidying up the media pipeline.
 *
 * ## The other two levels, so nobody looks for them here
 *
 *   - **Is NOTICE actually in the image?** `notice-ships-in-the-image.test.js` (cause) and `publish.yml` (effect,
 *     against the published artefact).
 *   - **Is the binary the licence NOTICE claims?** `publish.yml` runs `ffmpeg -buildconf` in the published image
 *     and compares. That one cannot run here — the standalone suite is the offline subset and has no Docker — and
 *     release time is when the obligation attaches anyway.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Every server source file, walked rather than globbed so a new directory cannot slip past. */
function sources(dir = join(ROOT, 'server', 'src'), out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Comments stripped: a comment explaining the subprocess design is not an invocation of it. */
const strip = src => src
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, ' ');

describe('ffmpeg is only ever a separate process', () => {
  const files = sources().map(p => ({ p: p.slice(ROOT.length + 1).replace(/\\/g, '/'), src: strip(readFileSync(p, 'utf8')) }));
  const touching = files.filter(f => /\bffmpeg\b|\bffprobe\b/i.test(f.src));

  it('found the code that uses ffmpeg (guards against a vacuous pass)', () => {
    // If a refactor reduced this to zero, every assertion below would pass by examining nothing.
    // ONE file since bundle-89, and that is the fix rather than a loss of coverage: the audio and the video embedder
    // had a wrapper each, line for line the same and neither bounded, and they became `files/media/transcode.ts`. The
    // floor is what stops a vacuous pass, so it follows the code down; the rule below still holds every file that
    // names the binary, however many there come to be.
    assert.ok(touching.length >= 1, `expected ffmpeg use in at least 1 file, found ${touching.length}`);
  });

  it('every invocation is a child process, never a linked module', () => {
    // The claim NOTICE rests on. A native binding or a WASM build would make it false, and nothing else here
    // would notice.
    const bad = [];
    for (const { p, src } of touching) {
      for (const m of src.matchAll(/^\s*import\s[^\n]*?from\s*'([^']*ffmpeg[^']*)'/gmi)) {
        bad.push(`${p} imports '${m[1]}' as a module`);
      }
      for (const m of src.matchAll(/require\(\s*'([^']*ffmpeg[^']*)'\s*\)/gi)) {
        bad.push(`${p} requires '${m[1]}'`);
      }
    }
    assert.deepEqual(bad, [],
      'ffmpeg must be reached only as a child process. NOTICE states it is "invoked as a separate process; not '
      + 'linked", and that statement is what keeps its GPL out of Ythril\'s own licensing:\n  ' + bad.join('\n  '));
  });

  it('the invocations that exist are spawn-shaped', () => {
    // Positive form of the same property: at least one real subprocess call, so "no imports" cannot be satisfied
    // by ffmpeg having quietly stopped being used the documented way.
    const spawners = touching.filter(f => /spawn\(\s*'ffmpeg'|execFile\(\s*'ffmpeg'|spawn\(\s*'ffprobe'/.test(f.src));
    assert.ok(spawners.length >= 1,
      'no spawn(\'ffmpeg\') found — if the invocation mechanism changed, NOTICE\'s "separate process" claim and '
      + 'the licensing position built on it both need revisiting');
  });

  it('no dependency ships its own ffmpeg binary', () => {
    // A different redistribution channel for a different binary. `ffmpeg-static` and friends bundle an executable
    // whose build flags — and therefore licence — are not the Debian ones NOTICE documents.
    const pkgs = ['package.json', 'server/package.json']
      .map(f => JSON.parse(readFileSync(join(ROOT, f), 'utf8')));
    const names = pkgs.flatMap(p => [...Object.keys(p.dependencies ?? {}), ...Object.keys(p.optionalDependencies ?? {})]);
    const bundlers = names.filter(n => /ffmpeg|ffprobe/i.test(n));
    assert.deepEqual(bundlers, [],
      'these dependencies ship or wrap an ffmpeg binary, which would redistribute a build NOTICE does not '
      + `describe:\n  ${bundlers.join('\n  ')}`);
  });
});
