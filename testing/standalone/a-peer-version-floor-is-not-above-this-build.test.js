/**
 * No peer-version floor (`export const <NAME>_SINCE = '<x.y.z>'` in server/src) is above the version this build reports.
 *
 * ## Why a lint
 *
 * A floor says "a member running at least this version has the feature, so ask it". The version a build reports is the package's, and the package is
 * bumped only by the release. So every build of main between two releases reports the PREVIOUS release's number. A floor set to the coming release
 * therefore matches no member of any stack built from main: not the CI stacks, not a dev network. The feature is dormant everywhere until the release
 * ships, and its peer-to-peer tests can never pass before then.
 *
 * Bundle-265 set `SCHEMA_SNAPSHOT_SINCE = '6.6.0'` while the package said 6.5.5. The Full run's sync suite then failed: no member was ever asked for a
 * schema snapshot. A floor at the version main reports costs one request per older member per version: the 404 without a code that the
 * missing route answers is remembered per member and version.
 *
 * ## Seen red
 *
 * At d22767f4: `server/src/sync/schema-snapshot-fetch.ts: SCHEMA_SNAPSHOT_SINCE = 6.6.0 is above this build's 6.5.5`.
 *
 * Run: node --test testing/standalone/a-peer-version-floor-is-not-above-this-build.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTrackedSources } from './_sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'package.json'), 'utf8')).version;

/** Each `export const NAME_SINCE = 'x.y.z'` in `text`: the floors a member's reported version is compared with. */
function floorsIn(text) {
  const out = [];
  for (const m of text.matchAll(/export\s+const\s+([A-Z][A-Z0-9_]*_SINCE)\s*=\s*['"](\d+\.\d+\.\d+)['"]/g)) out.push({ name: m[1], version: m[2] });
  return out;
}

/** Compare two `x.y.z` strings numerically. */
function compare(a, b) {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

describe('a peer-version floor is not above this build', () => {
  const sources = readTrackedSources('server/src', { untracked: true });

  it('read the server tree and found the floors', () => {
    assert.ok(sources.length >= 150, `only ${sources.length} server sources were read: the listing is broken`);
    assert.match(BUILD_VERSION, /^\d+\.\d+\.\d+/, `server/package.json reports no version: ${BUILD_VERSION}`);
    assert.ok(sources.some(s => floorsIn(s.text).length > 0), 'no `_SINCE` floor was found: the pattern no longer matches how floors are written');
  });

  it('every floor is at most the version this build reports, so a stack built from this tree has members that meet it', () => {
    const above = [];
    for (const { file, text } of sources) {
      for (const f of floorsIn(text)) if (compare(f.version, BUILD_VERSION.replace(/-.*$/, '')) > 0) above.push(`${file}: ${f.name} = ${f.version} is above this build's ${BUILD_VERSION}`);
    }
    assert.deepEqual(above, [], 'set the floor to the version main reports (the release that ships the feature is a later one, and every build before it reports this number)');
  });

  it('the rule finds a floor above the build and passes one at or below it (it is not vacuous)', () => {
    assert.deepEqual(floorsIn("export const X_SINCE = '9.0.0';"), [{ name: 'X_SINCE', version: '9.0.0' }]);
    assert.ok(compare('6.6.0', '6.5.5') > 0 && compare('6.5.5', '6.5.5') === 0 && compare('5.7.0', '6.5.5') < 0 && compare('6.10.0', '6.9.0') > 0);
  });
});
