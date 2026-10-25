/**
 * Every database name a test file claims on the harness Mongo, with the file that claims it — the ONE sweep.
 *
 * Two gates ask "who claims which harness database": `a-db-harness-name-is-unique` (no two files claim one, because the
 * suite runs in parallel and `openTestMongo` drops its database on entry and exit) and
 * `a-db-shards-keep-a-harness-database-on-one-mongo` (the same, held across the shards the `-db` third is spread over).
 * Each holding its own copy of the regex would drift, and the copy that missed a spelling would report clean about the files
 * written in it — `a-db-harness-name-is-unique` once missed `openPushDoor`'s `suite:` for exactly that reason.
 */
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** The sources every sweep reads: the tracked tests and helpers under `testing`, comments stripped, with a floor. */
function sweptSources() {
  return readTrackedSources('testing', { ext: ['.test.js', '.mjs'], floor: 100 })
    // The harness module DEFINES the function and takes the name as a parameter — it claims no database.
    .filter(({ file }) => !file.replace(/\\/g, '/').endsWith('_mongo-harness.mjs'))
    .map(({ file, text }) => ({ file: file.replace(/\\/g, '/'), code: stripComments(text) }));
}

/**
 * Every literal suite name handed to the harness, with the file that used it.
 *
 * A wrapper that opens the harness for its caller (`_push-door.mjs`, and `_stalled-write-doors.mjs` over it) takes the
 * name as `suite:`, and a name it is handed claims a database exactly as a direct call does — left out, those files
 * were never checked.
 *
 * @returns {Array<{ file: string, name: string }>}
 */
export function harnessNames() {
  const found = [];
  for (const { file, code } of sweptSources()) {
    for (const m of code.matchAll(/(?:openTestMongo\(\s*|(?:openPushDoor|openStalledWriteDoors|landingExperiment)\(\s*\{[^}]*?\bsuite:\s*)'([^']+)'/g)) {
      found.push({ file, name: m[1] });
    }
  }
  return found;
}

/**
 * Every `ythril_harness_<name>` database a file spells out in full, beside the names it hands the harness: the spelling a
 * file uses to reach its own database through the driver (`testMongoUri('ythril_harness_x')`, `driverWriteFailures(...)`),
 * which `harnessNames` cannot see because no harness function takes it. A template (`ythril_harness_${SUITE}`) is the
 * file's own constant, already swept as the name it hands the harness.
 *
 * @returns {Array<{ file: string, name: string }>}
 */
export function harnessDatabaseClaims() {
  const found = harnessNames().map(({ file, name }) => ({ file, name }));
  for (const { file, code } of sweptSources()) {
    for (const m of code.matchAll(/ythril_harness_([A-Za-z0-9_]+)/g)) found.push({ file, name: m[1] });
  }
  return found;
}
