/**
 * No boot migration may write to a collection that replicates across a network.
 *
 * ## The rule, which is already written down and enforced by nothing
 *
 * `docs/contribution-guide.md`:
 *
 * > **Synced data → self-healing (lazy), never a one-time boot migration.** The per-space MongoDB record
 * > collections that replicate across networks — facts, entities, edges, chrono, links, `{space}_files`, and
 * > their fields — can be silently reverted by a **mixed-version peer**: an older-version instance that
 * > rewrites a record with a higher `seq` replaces the *whole* document and undoes any boot migration. So
 * > don't migrate these on boot — **repair or derive the field on access**, so it re-heals after any
 * > cross-version clobber.
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
 * ## It follows the CALL now, and that is `Q-24`
 *
 * This gate used to read a function's OWN body for a `col(…)` open followed by a write, and said so in a
 * comment because two attempts at following a call had been written and withdrawn: a name-keyed lookup
 * cannot tell one module's `start…` from another's, so it reported `wipeSpace()` — a destructive operator
 * action nothing calls at boot — and a gate whose failures are mostly false gets its assertion deleted
 * rather than its subject fixed.
 *
 * `_call-graph.mjs` resolves a call through the importing file's own imports and keys every function
 * `path:name`, so the walk follows the real boot graph to exhaustion. **On its first honest run it found
 * one**, three calls deep and eleven days old: the link conversion that started running at boot on
 * 2026-09-17 reaches `stampFileMetaSeqs`, whose own docblock opens *"Why it is here and not a boot
 * migration"*. Nothing had contradicted that paragraph, because nothing could see it had stopped being
 * true. The stamp now rides in `scripts/convert-links.mjs` instead.
 *
 * ## What it can and cannot see, stated rather than implied
 *
 * Two populations: functions **named** `migrate*`, and everything reachable by call from `index.ts`'s
 * startup sequence. A boot migration that is neither named `migrate*` nor reachable that way — spawned from
 * a callback, dispatched through a namespace import, or reached through an object method — still slips
 * through, and `_call-graph.mjs` lists each of those holes by name.
 *
 * Run: node --test testing/standalone/no-boot-migration-on-synced-data.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { balancedFrom, statementFrom } from './_structural-window.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';
import { moduleIndex, reachableFrom, callsIn } from './_call-graph.mjs';

const ROOT = process.cwd();
const BOOT_FILE = 'server/src/index.ts';

/**
 * The collections that replicate, READ OUT OF the module that decides which do.
 *
 * It was a hand-written list of five and `links` was not on it — added as a replicated family when link
 * RECORDS shipped, and never added here. So the one boot migration this repository actually has, over the
 * link collection, could not have been detected by the thing watching for it: the walk would have followed
 * the call and then asked about the wrong collections.
 *
 * `REPLICATED_FAMILIES` is the list both directions of a sync cycle iterate, which makes it the answer to
 * *"what replicates"* rather than a second opinion about it.
 */
function syncedCollections() {
  const src = readFileSync(join(ROOT, 'server/src/sync/replicated-families.ts'), 'utf8');
  const found = [...new Set([...stripComments(src).matchAll(/collection:\s*'([a-z_]+)'/g)].map(m => m[1]))];
  assert.ok(found.length >= 6,
    `only ${found.length} replicated families found in sync/replicated-families.ts (${found.join(', ') || 'none'}) `
    + '— re-anchor this before believing anything below, because a short list makes the detector ask about '
    + 'collections nobody is migrating and pass.');
  return found;
}

const SYNCED = syncedCollections();

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

/** Comments stripped, so the gate cannot fire on the prose that documents it. */
function code(path) {
  return stripComments(readFileSync(join(ROOT, path), 'utf8'));
}

/**
 * Does this function body write to a synced collection? Returns the offending fragment, or null.
 *
 * A WINDOW, and the bound is the VARIABLE the open declares rather than 80 characters of proximity. The old
 * pattern found `_facts\`` and looked 80 characters ahead for a mutating call, which reaches a write on a
 * DIFFERENT collection opened just after it, and misses the ordinary two-statement shape entirely:
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

/** The module-aware index of the server, built once — parsing 367 files per test case is not free. */
const INDEX = moduleIndex('server/src');

/**
 * The functions `index.ts` invokes in its startup sequence, as `path:name`.
 *
 * Each one is a separate ROOT rather than one merged set, because an exemption has to name the migration
 * it excuses and not the boot. `main` itself is excluded by `callsIn` refusing to read a declaration as a
 * call — it reaches everything, so an exemption attributed to it would cover the whole startup.
 */
function bootRoots() {
  const src = code(BOOT_FILE);
  const listen = src.search(/\.listen\(|startServer\(/);
  const startup = listen > 0 ? src.slice(0, listen) : src;
  const roots = new Set();
  for (const name of callsIn(startup)) {
    const key = INDEX.resolve(BOOT_FILE, name);
    if (key) roots.add(key);
  }
  return roots;
}

/**
 * Boot migrations over synced data that are DELIBERATE, each with the argument that makes it safe.
 *
 * Keyed by the STARTUP ENTRY POINT, and each entry names the WRITES it excuses — not just the entry.
 *
 * **Exempting the entry alone was written first and a mutation caught it.** Putting `stampFileMetaSeqs`
 * back into the boot path left the gate green, because the walk skipped the sanctioned root and everything
 * under it. An exemption that covers a subtree grants whatever is added to that subtree later, which is the
 * opposite of a recorded decision: the argument below is about link records and says nothing whatever about
 * file seqs, and there is no version floor that makes stamping them safe — every peer is 5.0 and every one
 * of them stamps the same records with its own counter.
 *
 * So a write is excused only when every startup entry reaching it is listed here AND lists it. A migration
 * that grows a second write has to come back and argue for that one too.
 *
 * The rule exists because a peer running older code writes the old shape back, and a boot migration cannot
 * see that happen. **A version floor suspends the rule** — when the handshake refuses every peer below our
 * own major, the network is homogeneous or it is not a network — and that is the only argument accepted
 * here. "It seemed fine" is not one, and neither is "it is only additive": additive protects the DATA, not
 * the migration's premise.
 */
const SANCTIONED = new Map([
  ['server/src/brain/links-convert-on-boot.ts:convertLinksOnBoot', {
    writes: ['server/src/brain/links.ts:reconcileLinks'],
    why: 'The 5.0 link-array migration, owner-directed 2026-09-17 after the canary operator reported that '
      + '`npm run links:convert` cannot run on a deployed instance (`scripts/` is not in the image). '
      + '`MIN_PEER_VERSION` derives from our own major, so a 5.0 instance refuses every 4.x peer at the '
      + 'handshake and no peer can write the arrays back. Additive on top of that: it creates link records '
      + 'and removes no array, and a space is correct before, during and after. Removed at 6.0.',
  }],
]);

describe('the sweep works before it is trusted', () => {
  it('finds the migrate* functions', () => {
    const found = [...INDEX.bodies.keys()].filter(k => /:migrate/.test(k));
    // Four exist today. A floor of 3 leaves room for one to be retired without the gate going quiet.
    assert.ok(found.length >= 3, `expected the migrate* functions, found ${JSON.stringify(found)}`);
    assert.ok(found.some(k => k.endsWith(':migrateStateFilesAtRest')),
      'the known migration set is not being found, so this gate is checking nothing');
  });

  it('finds the startup call sequence', () => {
    const roots = bootRoots();
    assert.ok(roots.size >= 4, `only ${roots.size} startup calls resolved; the enumeration broke`);
    assert.ok(roots.has('server/src/config/loader.ts:loadConfig'),
      'loadConfig is not in the startup sequence — the parse is wrong');
  });

  it('the boot walk follows a call into another module, which is the whole of Q-24', () => {
    /*
     * The case the gate was blind to, asserted as a REACHABILITY rather than as the absence of a comment.
     * `convertLinksOnBoot` is reached through a dynamic import, calls a local helper, and that helper
     * calls into a second module — three hops, two modules and an `await import(…)`, every one of which
     * was a reason the earlier attempts resolved nothing.
     */
    const reach = reachableFrom(INDEX, bootRoots());
    assert.ok(reach.has('server/src/brain/links-conversion.ts:convertSpaceLinks'),
      'the boot walk no longer reaches the link conversion, so it is back to reading one body at a time');
  });

  it('every sanctioned entry is still a boot entry point', () => {
    // An exemption for something that is no longer called at boot is a suppression nobody will notice has
    // outlived its subject — and the next function to take that name inherits it.
    const roots = bootRoots();
    for (const [key, entry] of SANCTIONED) {
      assert.ok(roots.has(key), `${key} is sanctioned as a boot migration but nothing calls it at startup`);
      const reach = reachableFrom(INDEX, [key]);
      for (const write of entry.writes) {
        // A named write that is no longer reached, or no longer writes, is an exemption outliving its
        // subject — and the next thing to take that name inherits an argument written about something else.
        assert.ok(reach.has(write), `${key} is excused for ${write}, which it no longer reaches`);
        assert.ok(writesSynced(INDEX.bodies.get(write).body),
          `${key} is excused for ${write}, which no longer writes a synced collection — drop the exemption`);
      }
    }
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

    // And the collection that was missing from the hand-written list, so the derivation is exercised too.
    const links = 'function migrateSomething() {\n'
      + '  await col(spaceCollection(space.id, \'links\')).deleteOne({});\n}';
    assert.ok(writesSynced(links), 'link records replicate, so a boot write to them is the same violation');
  });
});

describe('no boot migration writes to a synced collection', () => {
  it('no migrate* function does', () => {
    const offenders = [];
    for (const [key, entry] of INDEX.bodies) {
      if (!/^migrate/.test(entry.name)) continue;
      const hit = writesSynced(entry.body);
      if (hit) offenders.push(`${key}() writes ${hit}`);
    }
    assert.deepEqual(offenders, [], 'a boot migration writes to a collection that replicates across networks. An '
      + 'older peer rewriting one of those records replaces the WHOLE document and silently undoes the '
      + 'migration — with no error, no log line, and every single-instance test still green.\n  '
      + offenders.join('\n  ')
      + '\n\nRepair or derive the field ON ACCESS instead, so it re-heals after a cross-version clobber. See '
      + 'the token `prefix` backfill in index.ts for the shape.');
  });

  it('nor does anything the startup sequence REACHES, however many calls away', () => {
    /*
     * Per ROOT, not over the union, and the exemption is checked per WRITE. A union cannot say which
     * startup decision a write came from, so one sanctioned entry would silence every other path to the
     * same function — and a sanction read at the root alone silences whatever that root grows later.
     */
    const offenders = [];
    for (const root of bootRoots()) {
      const allowed = SANCTIONED.get(root)?.writes ?? [];
      for (const key of reachableFrom(INDEX, [root])) {
        if (allowed.includes(key)) continue;
        const hit = writesSynced(INDEX.bodies.get(key).body);
        if (hit) offenders.push(`${root} reaches ${key}(), which writes ${hit}`);
      }
    }
    assert.deepEqual(offenders, [], 'something the server runs at startup writes to a collection that '
      + 'replicates across networks:\n  ' + offenders.join('\n  ')
      + '\n\nRepair or derive the field ON ACCESS instead. If the write is genuinely safe, the argument goes '
      + 'in SANCTIONED against the STARTUP ENTRY that reaches it, naming THIS function among its `writes` — and '
      + 'a version floor is the only argument accepted, because '
      + '"additive" protects the data rather than the migration\'s premise.');
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

  it('the scan reads the tree it claims to', () => {
    assert.ok(sourceFiles().length > 100, 'the server source listing is too short to be the server');
  });
});
