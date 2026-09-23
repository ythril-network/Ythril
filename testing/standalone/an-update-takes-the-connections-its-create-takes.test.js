/**
 * A door that accepts CONNECTIONS on create accepts them on update too.
 *
 * ## The defect
 *
 * `applyConnections` handles both halves of a write body: the `link*` fields, which say one record
 * CONCERNS another, and `edges`, which say how two records relate. Every create path called it. **No
 * update path did**, and none of their body-key allowlists named a connection field — so
 * `PATCH /api/brain/spaces/<s>/facts/<id>` with `linkEntities` answered
 * `400 "At least one field must be provided"`. The field was not rejected; it was not seen.
 *
 * ## Why that mattered more than it looks
 *
 * `entityIds` IS accepted on PATCH, so on an unconverted space a caller could still change a record's
 * links the old way. On a `completeLinkage` space `array-write-refusal` refuses `entityIds` outright —
 * so on a converted space there was **no way at all** to change a record's links after it was written,
 * by either door. The gap grew as spaces converted, which is the direction every space is going.
 *
 * ## The rule, and why it is not a list of routes
 *
 * The subject is DERIVED: every module whose CREATE handler calls `applyConnections`. Whatever that set
 * is, the update handler in the same module has to take the same fields — a create that can express a
 * relationship and an update that cannot is a record you can only get right the first time.
 *
 * A case naming `facts.ts` would be satisfied by `facts.ts` and say nothing about the fifth door
 * somebody adds, and the two read identically in a diff.
 *
 * ## Seen red
 *
 * Written against four update allowlists that named no connection field, listing all of them.
 *
 * Run: node --test testing/standalone/an-update-takes-the-connections-its-create-takes.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTrackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** The helper that turns a body's `link*` and `edges` into storage. */
const APPLY = 'applyConnections';
/** The shared allowlist constant a body-key check spreads in. */
const KEYS = 'CONNECTION_BODY_KEYS';

/**
 * Every REST brain module whose create path applies connections, with its update allowlists.
 *
 * Derived from the call, never listed. A module that stops calling it drops out of the subject on its
 * own, and one that starts calling it is in scope the day it does.
 */
function doorsThatAcceptConnections() {
  const found = [];
  for (const { file, text } of readTrackedSources('server/src/api/brain', { floor: 5 })) {
    const src = stripComments(text);
    if (!src.includes(`${APPLY}(`)) continue;
    const updateKeys = [...src.matchAll(/const\s+(\w*UPDATE_BODY_KEYS)\s*=\s*\[([^\]]*)\]/g)]
      .map(m => ({ name: m[1], body: m[2] }));
    found.push({ file: file.split('/').pop(), src, updateKeys });
  }
  return found;
}

describe('an update takes the connections its create takes', () => {
  it('the derivation finds the doors, so an empty set cannot pass', () => {
    // An empty scan passes every loop written over it and reports a green tick about nothing.
    const doors = doorsThatAcceptConnections();
    assert.ok(doors.length >= 3,
      `only ${doors.length} brain module(s) apply connections — the derivation is broken, not the code`);
    for (const known of ['facts.ts', 'chrono.ts', 'entities.ts']) {
      assert.ok(doors.some(d => d.file === known), `${known} must be in the subject: `
        + JSON.stringify(doors.map(d => d.file)));
    }
  });

  it('each of them has an update allowlist that names the connection fields', () => {
    const offenders = [];
    for (const d of doorsThatAcceptConnections()) {
      // A module with no update allowlist has no update route — nothing to be inconsistent with.
      for (const k of d.updateKeys) {
        if (!k.body.includes(KEYS)) offenders.push(`${d.file}:${k.name}`);
      }
    }
    assert.deepEqual(offenders, [],
      `these update allowlists do not name the connection fields their own create accepts:\n`
      + offenders.map(o => `  ${o}`).join('\n')
      + `\n\n      A key the allowlist does not name is not rejected — it is not SEEN, so the handler`
      + `\n      reports "At least one field must be provided" for a body that plainly has one. A create`
      + `\n      that can express a relationship and an update that cannot is a record you can only get`
      + `\n      right the first time, and on a converted space \`entityIds\` is refused too, so there is`
      + `\n      then no way to change a record's links at all.`);
  });

  it('and the update handler actually APPLIES them, not just accepts the key', () => {
    /*
     * The half that would be easy to half-do: widening the allowlist silences the `400` and changes
     * nothing else, which is the worse failure — the call then succeeds and the link still does not
     * exist. That is the `Q-28` shape arriving by a different route.
     *
     * Counted rather than located: a module applying connections on create AND update calls it twice.
     */
    const offenders = doorsThatAcceptConnections()
      .filter(d => d.updateKeys.length > 0)
      .filter(d => (d.src.match(new RegExp(`${APPLY}\\(`, 'g')) ?? []).length < 2)
      .map(d => d.file);
    assert.deepEqual(offenders, [],
      `these modules accept the connection fields on update and never apply them:\n`
      + offenders.map(o => `  ${o}`).join('\n')
      + `\n\n      A 200 with no link written is worse than the 400 it replaced.`);
  });
});

/**
 * The MCP half of the same rule.
 *
 * `CLAUDE.md`: *"Every capability must exist on both surfaces, and take the same parameters… not
 * 'eventually', not 'the tool wraps the route later' — the same commit."* A tool file declaring the
 * connection schema once has it on its create and not on its update, which is the REST defect wearing
 * a different door.
 *
 * Counted rather than located, for the same reason as above: a file that builds the schema twice and
 * applies it twice has both verbs covered, and the count survives either function being renamed.
 */
describe('and the MCP tools take them on update too', () => {
  // The call takes the record KIND since 5.0 — a fact names entities and nothing else, so a door
  // advertises only the classes its kind can hold. Matched on the call rather than on `()`, or this
  // derivation finds nothing and reports every tool clean.
  const SCHEMAS = 'connectionSchemas(';

  /** Every tool module that offers connections at all — derived from the shared builder, never listed. */
  function toolsThatOfferConnections() {
    return readTrackedSources('server/src/mcp/tools', { floor: 8 })
      .map(({ file, text }) => ({ file: file.split('/').pop(), src: stripComments(text) }))
      .filter(t => t.src.includes(SCHEMAS));
  }

  it('the derivation finds them, so an empty set cannot pass', () => {
    const tools = toolsThatOfferConnections();
    assert.ok(tools.length >= 3,
      `only ${tools.length} tool module(s) offer connections — the derivation is broken, not the code`);
  });

  /**
   * What a tool module DELEGATES its write to — the brain modules it imports.
   *
   * A count of `applyConnections(` in the tool file answers *"does this file mention it"*, and that is only
   * the same question as *"is the capability reached"* while every tool writes its own record. `save_bulk`
   * does not: its whole body is coercion over the shared `bulkWrite`, exactly as its docblock says, and the
   * connections are applied there. Reading the tool file alone reported `applies them 0x` about a door that
   * applies them three times.
   */
  function delegatedWriters(src) {
    return [...src.matchAll(/from '\.\.\/\.\.\/brain\/([\w-]+)\.js'/g)]
      .map(m => m[1])
      /*
       * NOT the module that DEFINES it. Every tool here imports `write-connections.js` for the schema
       * builder, and that file contains the string `applyConnections(` as its own export — so a scan for
       * the name alone reported every delegating tool clean, including one whose writer had been mutated
       * to call nothing. A symbol's NAME is not its contents; the CALL is what this is asking about.
       */
      .filter(name => name !== 'write-connections')
      .map(name => join(REPO_ROOT, 'server/src/brain', `${name}.ts`))
      .filter(p => existsSync(p))
      .map(p => stripComments(readFileSync(p, 'utf8')));
  }

  it('each declares them on BOTH verbs and applies them on both', () => {
    const offenders = [];
    for (const t of toolsThatOfferConnections()) {
      const declared = (t.src.match(/connectionSchemas\(/g) ?? []).length;
      const applied = (t.src.match(/applyConnections\(/g) ?? []).length;
      /*
       * TWO SUBJECTS, because there are two shapes and one rule read against both.
       *
       * A tool that writes its own record has a create verb and an update verb in the same file, so one of
       * each is the create-only gap this gate was written for and two is both covered.
       *
       * A tool that delegates its whole write has ONE verb — `save_bulk` inserts and upserts through the
       * same call — so there is no second verb to be inconsistent with, and what has to be true is that the
       * writer it hands the body to applies them. Counting the tool file for that reports a gap that is not
       * there, which is a gate concluding about a mechanism it never looked at.
       */
      if (applied === 0) {
        if (!delegatedWriters(t.src).some(w => w.includes('applyConnections('))) {
          offenders.push(`${t.file}: neither applies connections nor delegates to a writer that does`);
        }
        continue;
      }
      if (declared < 2) offenders.push(`${t.file}: declares the schema ${declared}x`);
      if (applied < 2) offenders.push(`${t.file}: applies them ${applied}x`);
    }
    assert.deepEqual(offenders, [],
      'these tools let a caller set connections when a record is created and never change them:\n  '
      + offenders.join('\n  ')
      + '\n\n      REST and MCP are one API with two doors. A capability on the create verb and not the'
      + '\n      update verb is the same defect whichever door it is missing from.');
  });
});
