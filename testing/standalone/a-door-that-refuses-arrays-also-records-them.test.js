/**
 * Every door that can refuse a legacy array write also records one — because they are the same inspection.
 *
 * ## What the pre-flight is for
 *
 * `completeLinkage` makes a space refuse `entityIds` / `memoryIds` / `chronoIds`, which is correct and is
 * opt-in. The canary operator's point (4.0.0 report, 2026-09-06 §5) is that the refusal lands on the
 * caller's NEXT WRITE rather than at conversion time: an operator converts, and finds out which of their
 * writers still use the old surface when one of them breaks. They would have had five and knew none of them
 * without grepping their own repositories.
 *
 * So the question is *"who wrote arrays to this space lately"*, and the only moment that fact exists is the
 * write itself.
 *
 * ## Why not the audit log, which looks like the answer
 *
 * It already records these field names per entry with a token, a label, a space and a time. Two things kill
 * it, and both UNDER-REPORT SILENTLY, which is worse than not answering:
 *
 *  - `AUDIT_CHANGE_FIELDS` covers `memory.update`, `chrono.update` and `file.meta.update`. A CREATE carrying
 *    `entityIds` records nothing — and a newly written caller is the one an operator most needs to hear
 *    about.
 *  - `changes` expire on their own short clock (`DEFAULT_RECORD_CHANGE_RETENTION_DAYS`, 14) because they
 *    carry user content. The ask is 30 days.
 *
 * A pre-flight built on it would answer "2 writers" where the truth is five, and say nothing about having
 * looked at half the window and none of the creates.
 *
 * ## What this gate asserts, and why it is the RULE rather than the sites
 *
 * A door that inspects a body for link arrays has all the facts the recorder needs. A door that inspects and
 * does not record is a hole in the pre-flight that nothing else can see — the count is simply lower, and a
 * lower count reads exactly like a cleaner space. So: the set of doors is DERIVED from who imports the
 * inspection at all, and every one of them must pass the actor through. A refusal-only call cannot record,
 * and this is what refuses to let one be written.
 *
 * Run: node --test testing/standalone/a-door-that-refuses-arrays-also-records-them.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';

const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');

const src = (p) => stripComments(readFileSync(p, 'utf8'));
/** The checkout's own line ending, so a block-close anchor works on CRLF and LF alike. */
const nl = readFileSync('server/src/brain/legacy-array-writers.ts', 'utf8')
  .includes(String.fromCharCode(13)) ? String.fromCharCode(13, 10) : String.fromCharCode(10);

/**
 * Every tracked source that reaches the array-write inspection, from git rather than a list.
 *
 * A list here would be the same defect the module itself documents: `LINK_ARRAY_FIELDS` is derived so that a
 * seventh link class is refused by the commit that declares it. A hand-written door list would be stale the
 * first time somebody adds an eighth door, and this gate would report clean about it.
 */
function doorFiles() {
  // `trackedSources`, not a hand-rolled `git ls-files`: it NUL-splits, so a path containing a space is not
  // silently dropped from the sweep, and it asserts a floor so a broken pathspec fails instead of reporting
  // clean. Six sweeps wrote that loop themselves before it was a module, and this gate is not the seventh.
  return trackedSources(['server/src'], { exclude: [/array-write-refusal\.ts$/] })
    // Stripped, so a file that only MENTIONS the function in a doc comment is not a door. `write-shape.ts`
    // names it in a comment explaining why its own refusals return a string, and it inspects nothing.
    .filter(f => /arrayWriteError|linkArrayFieldsNamed/.test(stripComments(readFileSync(f, 'utf8'))));
}

describe('the inspection is one function, and the doors are found not listed', () => {
  const doors = doorFiles();

  it('found the doors', () => {
    // A floor, because an empty set passes every loop below it. Seven was the count when M-2 shipped and the
    // number is not asserted — only that the derivation returned a real set.
    assert.ok(doors.length >= 6, `only ${doors.length} files reach the array-write inspection`);
  });

  it('nobody re-derives which fields are link arrays', () => {
    // The module exports `LINK_ARRAY_FIELDS`, derived from `LINK_CLASSES`. A door that spells the three
    // names itself is a second implementation that a seventh link class would not reach.
    const offenders = doors.filter(f => /\[\s*'entityIds'\s*,\s*'memoryIds'/.test(src(f)));
    assert.deepEqual(offenders, [],
      `these spell the link-array field names themselves instead of reading LINK_ARRAY_FIELDS: ${offenders.join(', ')}`);
  });
});

describe('a door that can refuse also records', () => {
  const doors = doorFiles();

  it('every door passes the actor to the inspection', () => {
    /*
     * The whole gate. Refusing and recording are the same inspection of the same body, and the only thing
     * the recorder needs beyond it is WHO — which every door already holds: REST as `req.authToken`, MCP as
     * the `actor` on its tool context.
     *
     * A door calling the inspection without an actor still refuses correctly and records nothing, so the
     * pre-flight simply reports a smaller number. Nothing errors, nothing logs, and a smaller number is
     * indistinguishable from a cleaner space — which is why this is asserted rather than remembered.
     */
    const missing = doors.filter(f => !/actor\s*:/.test(callToInspection(src(f))));
    assert.deepEqual(missing, [],
      'these doors inspect a write body for link arrays and do not say who wrote it, so their callers are '
      + `invisible to the conversion pre-flight: ${missing.join(', ')}`);
  });

  it('the recorder cannot fail a write', () => {
    // An advisory observation that can 500 a write is worse than no observation. The recorder is fired and
    // not awaited, and its rejection is caught inside the module — asserted here because a future edit that
    // awaits it turns a slow Mongo into failed writes on the hot path.
    const mod = src('server/src/brain/legacy-array-writers.ts');
    assert.match(mod, /\.catch\(/, 'the recorder must swallow its own failure');
  });

  it('the two doors treat an over-large window the same way', () => {
    /*
     * Found by sweeping the guidelines over this change before tagging it, in this change's own code.
     *
     * The MCP dispatcher enforces a tool's `inputSchema` BEFORE the handler runs. So a `maximum` on
     * `windowDays` refused a larger window outright, while the REST door passed the same value to the
     * resolver and had it capped -- a 400 on one door and a silent adjustment on the other, which
     * `CLAUDE.md` names in those words as worse than either alone, because it makes the behaviour depend on
     * which client the caller happened to pick.
     *
     * The cap lives in the resolver, which both doors call, so it is one implementation. What this asserts
     * is that the schema does not add a SECOND bound in front of it.
     */
    const tool = src('server/src/mcp/tools/link.ts');
    const at = tool.indexOf('windowDays: {');
    assert.ok(at > -1, 'windowDays is no longer declared in the link tool schema -- re-anchor this gate');
    const decl = tool.slice(at, tool.indexOf('},', at));
    assert.doesNotMatch(decl, /maximum/,
      'a `maximum` here makes MCP REFUSE a window the REST door serves capped -- the cap belongs in the '
      + 'resolver both doors call, and it already is there');
    assert.match(decl, /minimum:\s*1/,
      'zero and negatives have no honest answer, so both doors refuse them');
  });

  it('the pre-flight reports the window it covers, rather than assuming one', () => {
    // The failure the audit log would have had. A count with no window on it cannot be told apart from a
    // count over a shorter window, and the operator is about to make an irreversible-feeling decision on it.
    const mod = src('server/src/brain/legacy-array-writers.ts');
    assert.match(mod, /since/i, 'the answer must carry the window it was computed over');
  });
});

/**
 * The fields of the answer, read out of the interface that defines it.
 *
 * Never a list here. The whole reason this section exists is that `recorderStartedAt` was added to the
 * answer and the MCP schema's RESPONSE line kept naming the five fields it had known about — a list in a
 * gate rots the same way, and a rotted list reports clean about the field nobody documented.
 */
function preflightFields() {
  const mod = src('server/src/brain/legacy-array-writers.ts');
  const at = mod.indexOf('export interface ConvertPreflight {');
  assert.ok(at > -1, '`ConvertPreflight` is gone or renamed — re-anchor this derivation');
  const body = mod.slice(at, mod.indexOf(nl + '}', at));
  const fields = [...body.matchAll(/^ {2}(\w+)\s*\??\s*:/gm)].map(m => m[1]);
  assert.ok(fields.length >= 5, `only ${fields.length} field(s) read off ConvertPreflight — the parse broke`);
  return fields;
}

/** What the resolver is ASKED for, which a door legitimately spells because it is the call. */
function preflightInputs() {
  const mod = src('server/src/brain/legacy-array-writers.ts');
  const at = mod.indexOf('export async function legacyArrayWriters(input: {');
  assert.ok(at > -1, '`legacyArrayWriters` no longer takes a named input object — re-anchor this');
  const body = mod.slice(at, mod.indexOf('}):', at));
  const fields = [...body.matchAll(/^ {2}(\w+)\s*\??\s*:/gm)].map(m => m[1]);
  assert.ok(fields.length >= 2, `only ${fields.length} input field(s) — the parse broke`);
  return fields;
}

describe('the window in the answer is one that was actually watched', () => {
  const mod = src('server/src/brain/legacy-array-writers.ts');

  it('`since` is the LATER of what was asked for and when recording began', () => {
    /*
     * THE GUARANTEE, and it is the whole of `B-13`. `since` was `now - windowDays` and nothing else, so a
     * freshly upgraded instance answered "ninety days" over a window thirty minutes wide. The canary
     * operator, 2026-09-15: a space holding 270 chronos that already carry `entityIds` came back with
     * `count: 1`, because exactly one write had happened since the process started.
     *
     * Our own guidance — read `since` before you read the count — could not save a reader, because `since`
     * was the misleading field. And the sequence it breaks is the normal one: upgrade, run the pre-flight,
     * see `writers: []`, convert, then meet the writers one at a time as 400s.
     *
     * LATER of the two rather than simply the stamp: asking for a window SHORTER than the recorder's life
     * must still narrow the answer, or the parameter stops meaning anything on a long-lived instance.
     */
    assert.match(mod, /startedAt && startedAt > asked \? startedAt : asked/,
      'the window is no longer clamped to when recording began, so a count can be reported over a window '
      + 'nobody was watching — which reads exactly like a clean space');
  });

  it('the stamp cannot move once it is written', () => {
    // `$setOnInsert`. A stamp that a later boot overwrites says the instance started recording today,
    // however long it has really been running — and the clamp then narrows every answer to this boot.
    const fn = mod.slice(mod.indexOf('export async function stampRecorderStart'));
    assert.match(fn, /\$setOnInsert/, 'the recorder start is not write-once, so a restart moves it');
    assert.doesNotMatch(fn.slice(0, fn.indexOf('catch')), /\$set\s*:/,
      'a `$set` beside the `$setOnInsert` moves the stamp on every boot');
  });

  it('and it is the OLDEST NOTE rather than `now`', () => {
    /*
     * The half that is easy to leave out, and it is silent in the safe direction — which is why it needs a
     * gate rather than a comment. An instance that has recorded for a year, upgrading to the build that
     * added the stamp, would claim it began today: every answer then narrows to this boot and the operator
     * is told nothing was written, over a window of minutes, for a space with a year of evidence in it.
     *
     * A note from sixty days ago is proof the recorder was running sixty days ago. `now` is the fallback
     * for when there is no evidence at all, not the rule.
     */
    const fn = mod.slice(mod.indexOf('export async function stampRecorderStart'));
    assert.match(fn, /sort\(\{\s*firstAt:\s*1\s*\}\)/,
      'the stamp is not taken from the oldest note, so an instance with history claims it started today');
    assert.match(fn, /firstAt\s*\?\?\s*new Date\(\)/,
      '`now` must be the fallback when there are no notes, not the value');
  });

  it('stamping cannot take a boot down', () => {
    // An observation about the observer. Failing to record it makes `recorderStartedAt` null, which the
    // answer already has a meaning for; throwing makes the instance unbootable for the same problem.
    const fn = mod.slice(mod.indexOf('export async function stampRecorderStart'));
    const body = fn.slice(fn.indexOf('{') + 1);
    assert.match(body.trimStart().slice(0, 6), /^try/, 'the stamp does work outside a try');
  });

  it('every path that configures an instance stamps it, not just the boot one', () => {
    /*
     * If nothing calls it, `recorderStartedAt` is null for ever and the clamp never happens — the defect
     * ships again, with a field in the answer implying it did not.
     *
     * AND THE FIRST VERSION PUT IT IN `index.ts`, beside the two boot migrations, where a FIRST-RUN
     * instance never reaches it: that path skips the whole block and the setup route starts the services
     * itself. So a freshly installed instance went unstamped for its entire first run — which is exactly
     * the install this clamp was written for, and the integration suite caught it against a rebuilt
     * stack rather than anybody reading the code.
     *
     * `startConfiguredInstanceServices` is the one function both paths go through, so the assertion is
     * that the stamp lives THERE and that no caller repeats it. A caller with its own copy is a path
     * that can be added without one.
     */
    assert.match(src('server/src/bootstrap.ts'), /stampRecorderStart\(\)/,
      'the stamp is not in the function both startup paths share, so one of them can miss it');
    const callers = trackedSources(['server/src'])
      .filter(f => !f.endsWith('bootstrap.ts'))
      .filter(f => /startConfiguredInstanceServices\(\)/.test(src(f)));
    assert.ok(callers.length >= 2, `only ${callers.length} startup path(s) found — the derivation broke`);
    const duplicating = callers.filter(f => /stampRecorderStart/.test(src(f)));
    assert.deepEqual(duplicating, [],
      'these stamp the recorder themselves as well as going through the shared startup, so a third '
      + `startup path would be written without one: ${duplicating.join(', ')}`);
  });

  it('every field of the answer is named in the MCP schema, which is what a caller reads', () => {
    /*
     * A tool's `inputSchema` description is the reference a caller reads WHILE constructing arguments, and
     * `help()` says so. A field present in the answer and absent from that text is a capability nobody
     * knows they have — the fleet integrator built around a stale sentence in one of these once.
     *
     * Derived from the interface, so a seventh field is covered by the commit that adds it. That is not
     * hypothetical: the RESPONSE line named five fields for exactly as long as it took to notice.
     *
     * Read off the BUILT tool rather than out of the source: `link.ts` declares four tools and the first
     * `RESPONSE:` in it belongs to `upsert_link`. That is the version this gate was first written with,
     * and it failed on all six fields at once — loudly, because the description it was reading was the
     * wrong one entirely. A gate that matched the wrong thing quietly is the version worth fearing.
     */
    const tool = ALL_TOOLS.find(t => t.name === 'graph_link_preflight');
    assert.ok(tool, 'the pre-flight tool is gone or renamed — re-anchor this gate');
    const undocumented = preflightFields().filter(f => !tool.description.includes(f));
    assert.deepEqual(undocumented, [],
      `these are in the pre-flight answer and not in the MCP schema a caller reads: ${undocumented.join(', ')}`);
  });

  it('and neither door builds the answer itself', () => {
    /*
     * The parity rule, asserted as one rather than by checking both doors say the same thing. `since` and
     * `recorderStartedAt` are resolved once, in the module both doors call, and handed through whole — so
     * a field added to the answer reaches both surfaces without anybody remembering to add it twice.
     *
     * A door that spells a response key is building a second answer, and the two drift in the direction
     * nobody looks: the door somebody is not using.
     *
     * The INPUT names are subtracted, and derived rather than listed. `spaceId` and `converted` are both
     * asked for and answered back, so a door writing `converted: usesLinkRecords(spaceId)` — which is the
     * call itself — is not building anything. The first version of this case did not subtract them and
     * reported both doors, which is a gate that would have been deleted rather than believed.
     */
    const doors = trackedSources(['server/src'])
      .filter(f => /legacyArrayWriters/.test(stripComments(readFileSync(f, 'utf8'))))
      .filter(f => !f.endsWith('legacy-array-writers.ts'));
    assert.ok(doors.length >= 2, `only ${doors.length} door(s) call the pre-flight — the derivation broke`);
    const inputs = new Set(preflightInputs());
    const fields = preflightFields().filter(f => !inputs.has(f));
    assert.ok(fields.length >= 3, `only ${fields.length} answer-only field(s) — the subtraction ate the set`);
    const offenders = doors.filter(f => fields.some(k => new RegExp(`(^|[^.\\w])${k}\\s*:`).test(src(f))));
    assert.deepEqual(offenders, [],
      'these construct a pre-flight response field themselves instead of returning what the resolver '
      + `computed, so the two doors can report different windows: ${offenders.join(', ')}`);
  });
});

/** The argument list of the call to the inspection, as written in this file. */
function callToInspection(s) {
  const at = s.search(/arrayWriteError\s*\(/);
  if (at < 0) return '';
  // To the matching close paren — a call is one expression, so bracket-count rather than a character window.
  let depth = 0;
  for (let i = s.indexOf('(', at); i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return s.slice(at, i + 1);
  }
  return s.slice(at);
}
