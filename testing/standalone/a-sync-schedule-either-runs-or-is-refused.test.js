/**
 * A sync schedule the server cannot run is REFUSED, and a stored shorthand is rewritten rather than dropped.
 *
 * ## The state this replaces
 *
 * `syncSchedule` was `z.string().optional()` on both network routes — no validation at all. Anything typed
 * into the schedule field on a network card got a `200`, and if it did not resolve to cron the scheduler
 * logged `Unrecognised sync schedule '…' — using manual sync only` and moved on. So an operator could set a
 * schedule, be told it saved, and have that network never sync again, with the only evidence in a server log
 * they have no reason to open.
 *
 * The networks API documents that ("an unrecognised value is ignored with a startup warning"), which makes it
 * knowable to an integrator reading the guide and no more visible to the operator in the UI — the settings
 * page says only *"enter a cron expression"*. A promise the product makes in a form field and does not keep
 * is a defect whichever page describes it.
 *
 * ## Why the refusal has to land WITH the shorthand removal, not after it
 *
 * `"every 5m"` and its slash-star spelling were legacy shorthands translated to cron on the way in, documented in
 * both the networks API and the sync protocol page for the whole of 2.x and 3.x. Delete the translation arm
 * on its own and every operator who followed those documents has an input that used to work and is now
 * inert — the exact failure this release refused to ship for three env vars. The refusal is what makes the
 * removal a message instead of a silence.
 *
 * ## And the stored ones are migrated, because a config is not a request
 *
 * A shorthand already sitting in `config.json` was written under the old rule, and refusing it at boot would
 * stop an instance for a value it accepted last week. `migrateSyncScheduleShorthands` rewrites it to the cron
 * expression it always translated to — the same expression, spelled the way the parser will still understand
 * next release — and persists. It is durable and retries on a failed write, so it joins the table in
 * `a-durable-config-migration-stays-wired.test.js`.
 *
 * **The out-of-range ones are the finding.** `"every 90m"` never resolved to anything: 90 is outside cron's
 * minute range, so `resolveSyncCron` returned null and the network has been on manual sync since the day it
 * was set. There is no honest translation — rounding it to two hours invents a schedule nobody asked for — so
 * the migration leaves it and WARNS with the network named. That warning is the first time such an instance
 * is told, which is worth more than the removal that prompted it.
 *
 * Run: node --test testing/standalone/a-sync-schedule-either-runs-or-is-refused.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let resolveSyncCron;
let syncScheduleRefusal;
let migrateSyncScheduleShorthands;

const src = (p) => stripComments(readFileSync(p, 'utf8'));

/** Every shorthand spelling the old parser accepted, with what it translated to. */
const SHORTHANDS = [
  ['*/5 minutes', '*/5 * * * *'],
  ['*/5 minute', '*/5 * * * *'],
  ['*/5 min', '*/5 * * * *'],
  ['every 5m', '*/5 * * * *'],
  ['every 5 min', '*/5 * * * *'],
  ['*/2 hours', '0 */2 * * *'],
  ['*/2 hour', '0 */2 * * *'],
  ['every 2h', '0 */2 * * *'],
  ['every 2 hr', '0 */2 * * *'],
];

/** Shorthands that were always out of cron's range, so they never scheduled anything. */
const NEVER_RESOLVED = ['every 90m', '*/90 minutes', 'every 40h', '*/0 minutes'];

describe('the parser accepts cron and nothing else', () => {
  before(async () => {
    ({ resolveSyncCron } = await import('../../server/dist/sync/schedule.js'));
  });

  it('a standard cron expression still resolves to itself', () => {
    for (const cron of ['*/5 * * * *', '0 * * * *', '0 3 * * 1', '15,45 * * * *']) {
      assert.equal(resolveSyncCron(cron), cron, `${cron} must be used as given`);
    }
  });

  it('a legacy shorthand no longer resolves — it is refused at input and migrated on disk instead', () => {
    for (const [shorthand] of SHORTHANDS) {
      assert.equal(resolveSyncCron(shorthand), null,
        `${shorthand} still translates. The translation arm is what this change removes; the paths that `
        + 'replace it are the input refusal and the boot migration.');
    }
  });

  it('and neither does anything else', () => {
    for (const junk of ['soon', 'hourly', '5', '', '   ', '* * * *']) {
      assert.equal(resolveSyncCron(junk), null, `${junk} must not resolve`);
    }
  });
});

describe('a schedule the server cannot run is refused at input', () => {
  before(async () => {
    ({ syncScheduleRefusal } = await import('../../server/dist/sync/schedule.js'));
  });

  it('absent or empty is allowed — that is manual sync, and it is a real choice', () => {
    // The one case that must NOT be refused. Clearing the field is how an operator turns scheduling off.
    assert.equal(syncScheduleRefusal(undefined), null);
    assert.equal(syncScheduleRefusal(''), null);
    assert.equal(syncScheduleRefusal('   '), null);
  });

  it('a cron expression is allowed', () => {
    assert.equal(syncScheduleRefusal('*/5 * * * *'), null);
    assert.equal(syncScheduleRefusal('0 3 * * 1'), null);
  });

  it('a legacy shorthand is refused, and the message says what it translated to', () => {
    /*
     * The half that decides whether this change is a message or a silence. An operator who followed the
     * networks API guide for two majors has this string in their notes; being told "not valid" and left to
     * work out the replacement is barely better than being ignored.
     */
    for (const [shorthand, cron] of SHORTHANDS) {
      const refusal = syncScheduleRefusal(shorthand);
      assert.ok(refusal, `${shorthand} must be refused, not accepted and then ignored`);
      assert.ok(refusal.includes(cron),
        `the refusal for '${shorthand}' must name '${cron}' — it is the same schedule, respelled: ${refusal}`);
    }
  });

  it('an out-of-range shorthand is refused WITHOUT inventing a schedule for it', () => {
    // `every 90m` has no cron equivalent. Rounding it to two hours would be the server deciding something
    // the operator did not ask for, on a setting whose whole purpose is to say when.
    for (const bad of NEVER_RESOLVED) {
      const refusal = syncScheduleRefusal(bad);
      assert.ok(refusal, `${bad} must be refused`);
      // Quoting the operator's own value back is right and is not a suggestion. What must not appear is a
      // five-field expression built from that number — that would be the server answering "when" for them.
      const n = /(\d+)/.exec(bad)[1];
      assert.doesNotMatch(refusal, new RegExp(`\\*/${n} \\*|0 \\*/${n} \\*`),
        `the refusal derives a cron expression from an out-of-range value: ${refusal}`);
    }
  });

  it('anything else is refused and names the format', () => {
    const refusal = syncScheduleRefusal('hourly');
    assert.ok(refusal);
    assert.match(refusal, /cron/i, 'a refusal that does not name the format leaves the caller guessing');
  });

  it('a non-string is refused rather than coerced', () => {
    // The route schema is `z.string().optional()`, so this is defence in depth — but a helper that stringifies
    // a number would accept `5` and refuse `"5"`, which is the kind of difference nobody reports.
    for (const wrong of [5, true, {}, []]) {
      assert.ok(syncScheduleRefusal(wrong), `${JSON.stringify(wrong)} must be refused`);
    }
  });
});

describe('both network routes ask before they save', () => {
  // Source-read, because the alternative is standing up a network per case. What matters structurally is
  // that NEITHER door is the weaker one: this repo's most common defect is one rule with two
  // implementations, and a create that validates beside an update that does not is that defect exactly.
  it('the create and the update both call the refusal', () => {
    const crud = src('server/src/api/networks/crud.ts');
    assert.equal((crud.match(/syncScheduleRefusal\(/g) ?? []).length, 2,
      'both POST /api/networks and PATCH /api/networks/:id must refuse an unrunnable schedule — a schedule '
      + 'accepted on one door and refused on the other makes the behaviour depend on which the caller used');
  });

  it('and the operator SEES the refusal, which is the only reason to write it for a person', () => {
    /*
     * The link the whole change hangs on. These messages are written to be read — "send the five-field
     * expression, it is the same schedule" — and a component that swallowed the body and showed its own
     * "could not save" would make that work invisible in the one place it matters: the field the operator
     * just typed into. The server's sentence has to win over the local fallback.
     */
    const ui = src('client/src/app/pages/settings/networks.component.ts');
    const at = ui.indexOf('saveSchedule(net: Network)');
    assert.notEqual(at, -1, 'saveSchedule is gone — this gate is reading the wrong component');
    const fn = ui.slice(at, ui.indexOf('\n  }', at));
    assert.match(fn, /err\.error\?\.error\s*\?\?/,
      'the schedule save must show the server message and fall back to its own only when there is none');
  });

  it('and there is no MCP door to keep in step', () => {
    /*
     * Stated rather than assumed, because "MCP and REST are one API with two doors" is the rule this repo
     * breaks most expensively. Networks are REST-only: no tool creates or updates one, and the two
     * network-adjacent tools (`network_peers`, `network_sync`) neither read nor write a schedule. So there is
     * nothing to keep in parity here — and if a network tool ever arrives, this case is what fails.
     */
    const tools = src('server/src/mcp/tools/index.ts') + SHORTHANDS.length;
    assert.doesNotMatch(tools, /syncSchedule/,
      'a tool now touches syncSchedule — it needs the same refusal, with the same message');
  });
});

describe('a stored shorthand is rewritten, and an unrunnable one is reported', () => {
  before(async () => {
    ({ migrateSyncScheduleShorthands } = await import('../../server/dist/sync/schedule.js'));
  });

  const cfg = (...schedules) => ({
    spaces: [], tokens: [],
    networks: schedules.map((s, i) => ({ id: `net-${i}`, label: `N${i}`, ...(s === null ? {} : { syncSchedule: s }) })),
  });

  it('rewrites every shorthand to the expression it already translated to', () => {
    for (const [shorthand, cron] of SHORTHANDS) {
      const c = cfg(shorthand);
      assert.equal(migrateSyncScheduleShorthands(c).changed, true, `${shorthand} must be migrated`);
      assert.equal(c.networks[0].syncSchedule, cron,
        `${shorthand} must become ${cron} — the same schedule, so the instance keeps syncing at the same rate`);
    }
  });

  it('leaves a cron expression exactly as it is', () => {
    const c = cfg('*/5 * * * *', '0 3 * * 1');
    assert.equal(migrateSyncScheduleShorthands(c).changed, false, 'nothing to do means no write');
    assert.equal(c.networks[0].syncSchedule, '*/5 * * * *');
    assert.equal(c.networks[1].syncSchedule, '0 3 * * 1');
  });

  it('reports an unrunnable schedule with the network named, and does NOT guess one', () => {
    // The finding. These have been on manual sync since the day they were set, and nothing has ever said so
    // except a startup line about a value the operator no longer remembers typing.
    const c = cfg('every 90m');
    const { changed, unrunnable } = migrateSyncScheduleShorthands(c);
    assert.equal(changed, false, 'an unrunnable value must not be rewritten into an invented one');
    assert.equal(c.networks[0].syncSchedule, 'every 90m', 'the operator’s value stays so they can see it');
    assert.deepEqual(unrunnable, [{ networkId: 'net-0', schedule: 'every 90m' }],
      'the caller needs the network id to warn usefully — "some network" is not actionable');
  });

  it('is idempotent: the second boot changes nothing', () => {
    const c = cfg('every 5m');
    migrateSyncScheduleShorthands(c);
    assert.equal(migrateSyncScheduleShorthands(c).changed, false, 'a migration that keeps saving never settles');
    assert.equal(c.networks[0].syncSchedule, '*/5 * * * *');
  });

  it('survives a config with no networks, and one with a network that has no schedule', () => {
    assert.equal(migrateSyncScheduleShorthands({ networks: [] }).changed, false);
    assert.equal(migrateSyncScheduleShorthands({}).changed, false);
    assert.equal(migrateSyncScheduleShorthands(cfg(null)).changed, false);
  });

  it('handles several networks in one pass', () => {
    // One boot, one write. Migrating one network per boot would take as many restarts as there are networks.
    const c = cfg('every 5m', '*/5 * * * *', 'every 2h', 'every 90m');
    const { changed, unrunnable } = migrateSyncScheduleShorthands(c);
    assert.equal(changed, true);
    assert.equal(c.networks[0].syncSchedule, '*/5 * * * *');
    assert.equal(c.networks[2].syncSchedule, '0 */2 * * *');
    assert.equal(unrunnable.length, 1, 'the one that cannot be translated is still reported');
  });
});

describe('the documented format is the format', () => {
  /*
   * Not "the shorthand is never mentioned" — it HAS to be, or a reader with `every 5m` in their notes has
   * nowhere to look it up. The rule is the one the removed env vars are held to: a legacy spelling may
   * appear only on a line that also says it is gone. That covers the removal note and the upgrade table and
   * nothing else, so there is no exemption list to grow, and it is the shape a reader needs — seeing the old
   * spelling with no removal beside it is exactly what leaves them sending it.
   */
  const REMOVAL = /remov|refus|no longer|never|4\.0/i;

  /*
   * A shorthand as a VALUE — quoted or backticked, or the `N` placeholder the guides used. Deliberately not
   * `every \d+\s*[mh]`, which was the first attempt and caught two lines of ordinary English: a prune that
   * runs "every 6 h", and "every 5 minutes" describing what a cron expression means. A gate that fires on
   * prose gets an exemption list, and an exemption list is where the next real offender hides.
   */
  const SHORTHAND_VALUE = /[`"']every \d+\s*[mh]|[`"']\*\/\d+\s*(min|hour)|every N[mh]\b|\*\/N (minutes|hours)/;

  const offenders = (path) => readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => SHORTHAND_VALUE.test(text))
    .filter(({ text }) => !REMOVAL.test(text))
    .map(({ line, text }) => `${path}:${line}: ${text.trim().slice(0, 90)}`);

  it('the networks API names a shorthand only where it says it was removed', () => {
    const found = offenders('docs/integration-guide/08-networks-api.md');
    assert.deepEqual(found, [], `these lines still offer a shorthand as if it worked:\n  ${found.join('\n  ')}`);
  });

  it('and so does the sync-protocol page', () => {
    const found = offenders('docs/sync-protocol.md');
    assert.deepEqual(found, [], `these lines still offer a shorthand as if it worked:\n  ${found.join('\n  ')}`);
  });

  it('the check can fire, and does not fire on prose', () => {
    // Mutation-check on the predicate: a rule that cannot fire looks exactly like a clean document, and one
    // that fires on English gets an exemption list.
    const bad = 'Send `"every 5m"` for a five-minute cycle.';
    assert.ok(SHORTHAND_VALUE.test(bad) && !REMOVAL.test(bad), 'the predicate must flag this line');

    const ok = 'The shorthand `"every 5m"` was removed in 4.0 — send `"*/5 * * * *"`.';
    assert.ok(SHORTHAND_VALUE.test(ok) && REMOVAL.test(ok), 'and must allow a line that names the removal');

    for (const prose of [
      'The prune (`brain/tombstone-prune.ts`, every 6 h) deletes old tombstones.',
      'Give a cron expression, e.g. `"*/5 * * * *"` = every 5 minutes.',
    ]) {
      assert.ok(!SHORTHAND_VALUE.test(prose), `must not fire on prose: ${prose}`);
    }
  });
});
