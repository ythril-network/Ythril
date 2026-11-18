/**
 * A schema conversion run resumes at boot, and its watcher stops at shutdown (Q-746, bundle-284 design r5 section 5.2 "Resume", finding N8):
 * the source half; `a-conversion-run-resumes-at-boot-db` holds the behaviour.
 *
 * ## The rule
 *
 * - The run module exports `resumeSchemaConvertRuns` and `stopSchemaConvertWatcher`.
 * - `bootstrap.ts` calls `resumeSchemaConvertRuns()` from the function every configured start runs, beside the reindex resume, so a run a
 *   restart cut short is continued without a new schema write.
 * - `shutdown.ts` calls `stopSchemaConvertWatcher()`, so no tick starts a page while the process drains toward `closeMongo`.
 * - The watcher is the module's one `intervalJob` (one tick at a time, contained), never a bare timer.
 *
 * Seen red on 14af4644: neither the module nor either call exists.
 *
 * Run: node --test testing/standalone/a-conversion-run-resumes-at-boot.test.js (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { moduleOrNull } from './_b81c-door.mjs';

const RUN_SRC = 'server/src/spaces/schema-convert-run.ts';
const code = (file) => stripComments(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));

describe('a conversion run resumes at boot and its watcher stops at shutdown', () => {
  it('the run module exports the resume and the stop', async () => {
    const mod = await moduleOrNull('spaces/schema-convert-run.js');
    assert.ok(mod, `${RUN_SRC} is not built: there is no run to resume`);
    assert.equal(typeof mod.resumeSchemaConvertRuns, 'function', 'resumeSchemaConvertRuns is exported');
    assert.equal(typeof mod.stopSchemaConvertWatcher, 'function', 'stopSchemaConvertWatcher is exported');
  });

  it('bootstrap.ts resumes the runs, imported from the run module', () => {
    const src = code('server/src/bootstrap.ts');
    assert.match(src, /import\(['"]\.\/spaces\/schema-convert-run\.js['"]\)/, 'bootstrap imports the run module');
    assert.match(src, /\bresumeSchemaConvertRuns\(\)/, 'bootstrap calls resumeSchemaConvertRuns()');
    const resume = src.indexOf('resumeSchemaConvertRuns()');
    const reindex = src.indexOf('resumeReindexRuns()');
    assert.ok(reindex >= 0, 'precondition: the reindex resume is where the design puts this one beside');
    const fnStart = src.lastIndexOf('\nexport async function ', reindex);
    assert.ok(resume > fnStart, 'the resume is in the same function as the reindex resume: the one every configured start runs');
  });

  it('shutdown.ts stops the watcher', () => {
    const src = code('server/src/shutdown.ts');
    assert.match(src, /import\(['"]\.\/spaces\/schema-convert-run\.js['"]\)/, 'shutdown imports the run module');
    assert.match(src, /\bstopSchemaConvertWatcher\(\)/, 'shutdown calls stopSchemaConvertWatcher()');
  });

  it('the watcher is an intervalJob of the run module, and the module arms no bare timer', () => {
    assert.ok(existsSync(RUN_SRC), `${RUN_SRC} exists`);
    const src = code(RUN_SRC);
    assert.equal((src.match(/\bintervalJob\(/g) ?? []).length, 1, 'one intervalJob: the watcher');
    assert.doesNotMatch(src, /\bsetInterval\(/, 'no bare repeating timer');
  });
});
