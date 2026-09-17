/**
 * No boot migration may write to a collection that replicates across a network.
 *
 * ## The rule, which is already written down and enforced by nothing
 *
 * `docs/contribution-guide.md`:
 *
 * > **Synced data → self-healing (lazy), never a one-time boot migration.** The per-space MongoDB record
 * > collections that replicate across networks — memories, entities, edges, chrono, `{space}_files`, and their
 * > fields — can be silently reverted by a **mixed-version peer**: an older-version instance that rewrites a
 * > record with a higher `seq` replaces the *whole* document and undoes any boot migration. So don't migrate
 * > these on boot — **repair or derive the field on access**, so it re-heals after any cross-version clobber.
 *
 * ## Why it needs a gate rather than discipline
 *
 * **The failure is invisible to every single-instance test.** A boot migration over `{space}_files` works
 * perfectly on one instance: it runs, the field is right, every test passes. It only breaks in a network, only
 * when a peer is on an older build, and it breaks by *silently reverting data* — no error, no log line, no
 * failing assertion. The one place it would be caught is a multi-version network, which nobody has in CI.
 *
 * The canary operates **five instances off one manifest**. They upgrade together today, which is exactly why
 * nobody would notice this rule being broken until a network spans two organisations that do not.
 *
 * The rule is currently **held**: every write to a synced collection sits on a user-action path (delete, wipe,
 * the media pipeline, the face embedder), and the one migration-shaped thing at boot — token `prefix` backfill —
 * is explicitly self-healing on first use, with a comment in `index.ts` saying so. This gate exists to keep that
 * true, not to fix it.
 *
 * ## What it can and cannot see, stated rather than implied
 *
 * It checks two populations: functions **named** `migrate*`, and the functions `index.ts` calls in its startup
 * sequence. A boot migration that is neither named `migrate*` nor called directly from `index.ts` would slip
 * through. That is a real limit, not a covered case — the mitigation is that the naming convention is the one
 * contributors already follow (four of four current migrations use it) and that the startup sequence is short
 * enough to enumerate.
 *
 * Run: node --test testing/standalone/no-boot-migration-on-synced-data.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { balancedFrom, statementFrom } from './_structural-window.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources } from './_sources.mjs';

const ROOT = process.cwd();

/** The collections that replicate. Named in the contribution guide; this list must match it. */
const SYNCED = ['facts', 'entities', 'edges', 'chrono', 'files'];

/** Mutating Mongo operations. A read never reverts anything, so a boot-time read is fine. */
const WRITES = ['updateMany', 'updateOne', 'bulkWrite', 'deleteMany', 'deleteOne', 'insertMany', 'insertOne',
  'replaceOne', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete'];

/*
 * `untracked: true` — the scan includes files that are on disk but not committed yet.
 *
 * A boot migration is written and then run on the next start, so the moment it is worth refusing is BEFORE
 * it is pushed. A tracked-only listing cannot see one that was written five minutes ago, which is the run
 * where a person could still choose the lazy migration instead.
 */
function sourceFiles() {
  return trackedSources('server/src', { untracked: true });
}

/** Comments stripped line-first, so the gate cannot fire on the prose that documents it. */
function code(path) {
  return readFileSync(join(ROOT, path), 'utf8')
    .split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/** Extract `name -> body` for every top-level function in a file, by brace matching. */
function functions(src) {
  const out = new Map();
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*\{/gm)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    out.set(m[1], src.slice(start, i + 1));
  }
  return out;
}

/**
 * Does this function body write to a synced collection? Returns the offending fragment, or null.
 *
 * A WINDOW, converted, and the bound is the VARIABLE the open declares rather than 80 characters of proximity.
 * The old pattern found `_facts\`` and looked 80 characters ahead for a mutating call, which reaches a write
 * on a DIFFERENT collection opened just after it, and misses the ordinary two-statement shape entirely:
 *
 *     const memoryColl = col<FactDoc>(`${spaceId}_facts`);
 *     …
 *     await memoryColl.updateMany(filter, patch);
 *
 * A boot migration written that way was invisible to this gate — and a gate whose whole job is refusing boot
 * migrations on synced data does not get to see only the one-line spelling of them.
 */
function writesSynced(body) {
  const writeCall = new RegExp(`\\.(${WRITES.join('|')})\\b`);
  for (const coll of SYNCED) {
    for (const m of body.matchAll(/\bcol\s*(?:<[^>]*>)?\s*\(/g)) {
      const open = body.indexOf('(', m.index);
      /*
       * BOTH SPELLINGS of a collection name, and the second is now the majority.
       *
       * This matched `` col(`${spaceId}_facts`) `` alone. `A-5` gave collections one name via
       * `spaceCollection(space, 'facts')`, and 70 of the 81 `col()` opens in the server use that form —
       * so the detector had been reading 14% of the code and passing on the rest. It is the gate matching
       * the wrong thing silently: nothing contradicted it, because a gate that finds nothing looks exactly
       * like a codebase with nothing to find.
       */
      const args = balancedFrom(body, open, 'the col() arguments');
      const named = new RegExp(`_${coll}\``).test(args)
        || new RegExp('spaceCollection\\([^)]*\\b' + coll + '\\b').test(args);
      if (!named) continue;

      // Chained on the open itself: `col(...).updateOne(...)`, one statement.
      const stmt = statementFrom(body, m.index, `the ${coll} open`);
      const chained = writeCall.exec(stmt);
      if (chained) return `${coll}: .${chained[1]}()`;

      // Or bound to a name, and written through later. Follow the NAME, not the distance.
      const varName = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(body.slice(0, m.index))?.[1];
      if (!varName) continue;
      const after = body.slice(m.index + stmt.length);
      for (const u of after.matchAll(new RegExp(`\\b${varName}\\b`, 'g'))) {
        const used = writeCall.exec(statementFrom(after, u.index, `a use of ${varName}`));
        if (used) return `${coll}: ${varName}.${used[1]}()`;
      }
    }
  }
  return null;
}

/** Functions index.ts invokes in its startup sequence, before the server begins serving. */
function bootCallees() {
  const src = code('server/src/index.ts');
  const listen = src.search(/\.listen\(|startServer\(/);
  const startup = listen > 0 ? src.slice(0, listen) : src;
  const names = new Set();
  for (const m of startup.matchAll(/(?:await\s+)?([a-z][\w$]*)\s*\(\s*\)/g)) names.add(m[1]);

  /*
   * IT DOES NOT FOLLOW A CALL, and that limit is now load-bearing rather than theoretical.
   *
   * `convertLinksOnBoot` walked straight past this gate on 2026-09-17. It writes `<space>_links` at boot
   * and does it through `convertSpaceLinks()`, so the `col()` scan of its own body finds nothing. The gate
   * passed on the exact shape of change it exists to notice.
   *
   * Two attempts at a one-hop expansion were written and both were withdrawn, which is why this comment
   * exists instead of code. Collecting every call in a boot callee's body and matching those names
   * tree-wide reported `wipeSpace()` — a destructive operator action nothing calls at boot. Narrowing the
   * hop to the callee's own imports reported it too, because `functions()` is keyed by NAME and cannot
   * tell one module's `startX` from another's. Resolving it properly means module-aware resolution, which
   * is `Q-24`. A gate whose failures are mostly false gets its assertion deleted rather than its subject
   * fixed, so the honest state is: this sees one level, `SANCTIONED` records what it cannot see, and the
   * entry is a DECISION on the record rather than a suppression of a detection.
   */
  return names;
}

/**
 * Boot migrations over synced data that are DELIBERATE, each with the argument that makes it safe.
 *
 * The rule exists because a peer running older code writes the old shape back, and a boot migration
 * cannot see that happen. **A version floor suspends the rule** — when the handshake refuses every peer
 * below our own major, the network is homogeneous or it is not a network — and that is the only argument
 * accepted here. "It seemed fine" is not one, and neither is "it is only additive": additive protects the
 * DATA, not the migration's premise.
 */
const SANCTIONED = new Map([
  ['convertLinksOnBoot', 'The 5.0 link-array migration, owner-directed 2026-09-17 after the canary operator '
    + 'reported that `npm run links:convert` cannot run on a deployed instance (`scripts/` is not in the '
    + 'image). `MIN_PEER_VERSION` derives from our own major, so a 5.0 instance refuses every 4.x peer at '
    + 'the handshake and no peer can write the arrays back. Additive on top of that: it creates link '
    + 'records and removes no array, and a space is correct before, during and after. Removed at 6.0.'],
]);

describe('the sweep works before it is trusted', () => {
  it('finds the migrate* functions', () => {
    const found = [];
    for (const f of sourceFiles()) {
      for (const name of functions(code(f)).keys()) if (/^migrate/.test(name)) found.push(name);
    }
    // Four exist today. A floor of 3 leaves room for one to be retired without the gate going quiet.
    assert.ok(found.length >= 3, `expected the migrate* functions, found ${JSON.stringify(found)}`);
    assert.ok(found.includes('migrateStateFilesAtRest'),
      'the known migration set is not being found, so this gate is checking nothing');
  });

  it('finds the startup call sequence', () => {
    const callees = bootCallees();
    assert.ok(callees.size >= 4, `only ${callees.size} startup calls found; the enumeration broke`);
    assert.ok(callees.has('loadConfig'), 'loadConfig is not in the startup sequence — the parse is wrong');
  });

  it('and it can actually detect a violation — the detector is tested, not assumed', () => {
    // A gate whose detector is never exercised is a gate that passes because it finds nothing, which is
    // indistinguishable from passing because there is nothing to find.
    const fake = 'function migrateSomething() {\n'
      + '  await col(`${space.id}_files`).updateMany({}, { $set: { x: 1 } });\n}';
    assert.ok(writesSynced(fake), 'the detector cannot see a plain updateMany on a synced collection');
    const safeRead = 'function migrateSomething() {\n'
      + '  const n = await col(`${space.id}_files`).countDocuments({});\n}';
    assert.equal(writesSynced(safeRead), null, 'the detector flags a READ, which reverts nothing');

    /*
     * AND THE TWO-STATEMENT SPELLING, which the 80-character gap this detector used to carry could not see.
     *
     * Measured: with the write reached through the variable rather than chained onto the open, the old pattern
     * MISSED it at 80 and would have found it at 200 — so the number decided, not the shape. A boot migration
     * written this ordinary way was invisible to the gate whose whole job is refusing one.
     */
    const viaVariable = 'function migrateSomething() {\n'
      + '  const fileColl = col(`${space.id}_files`);\n'
      + '  const stale = await fileColl.find({ legacy: true }).toArray();\n'
      + '  await fileColl.updateMany({ legacy: true }, { $unset: { legacy: 1 } });\n}';
    assert.ok(writesSynced(viaVariable),
      'a write reached through the variable the open declares is the same violation, however far away it is');

    const readViaVariable = 'function migrateSomething() {\n'
      + '  const fileColl = col(`${space.id}_files`);\n'
      + '  const n = await fileColl.countDocuments({});\n}';
    assert.equal(writesSynced(readViaVariable), null, 'following the variable must not turn a READ into a write');
  });
});

describe('no boot migration writes to a synced collection', () => {
  it('no migrate* function does', () => {
    const offenders = [];
    for (const f of sourceFiles()) {
      for (const [name, body] of functions(code(f))) {
        if (!/^migrate/.test(name)) continue;
        const hit = writesSynced(body);
        if (hit) offenders.push(`${f} → ${name}() writes ${hit}`);
      }
    }
    assert.deepEqual(offenders, [], 'a boot migration writes to a collection that replicates across networks. An '
      + 'older peer rewriting one of those records replaces the WHOLE document and silently undoes the '
      + 'migration — with no error, no log line, and every single-instance test still green.\n  '
      + offenders.join('\n  ')
      + '\n\nRepair or derive the field ON ACCESS instead, so it re-heals after a cross-version clobber. See '
      + 'the token `prefix` backfill in index.ts for the shape.');
  });

  it('nor does anything index.ts calls during startup', () => {
    const callees = bootCallees();
    const offenders = [];
    for (const f of sourceFiles()) {
      for (const [name, body] of functions(code(f))) {
        if (!callees.has(name) || SANCTIONED.has(name)) continue;
        const hit = writesSynced(body);
        if (hit) offenders.push(`${f} → ${name}() writes ${hit}`);
      }
    }
    assert.deepEqual(offenders, [], 'a function called during startup writes to a synced collection:\n  '
      + offenders.join('\n  '));
  });
});

describe('the rule and the gate move together', () => {
  it('the contribution guide still states the rule this gate enforces', () => {
    // A gate outliving its documented rule is a gate nobody can argue with. If the rule is deliberately
    // changed, this failing is the prompt to change the gate in the same commit — not to delete this assertion.
    const doc = readFileSync(join(ROOT, 'docs/contribution-guide.md'), 'utf8');
    assert.match(doc, /never a one-time boot migration/i,
      'the synced-data migration rule is gone from the contribution guide, but this gate still enforces it');
    for (const coll of SYNCED) {
      assert.ok(doc.includes(coll),
        `the guide no longer names \`${coll}\` as a synced collection, so this gate's list may be out of date`);
    }
  });
});
