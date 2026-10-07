/**
 * The first boot on a new version rewrites `config.json`. Every rewrite that drops a field must be documented,
 * because it decides whether a rollback is possible.
 *
 * ## The finding — Observability & Operability audit lens
 *
 * The lens asks about "the upgrade path (does a new version read old config/data?)". The docs covered that
 * direction — named volumes persist, indexes rebuild, back up first — and said **nothing at all** about the
 * direction an operator needs at three in the morning.
 *
 * `loadConfig()` runs three migrations and **persists** each one. Two of them `delete` a field:
 *
 *   - `mediaEmbedding.enabled` — verified from history, the default before it was removed was **`true`**, so an
 *     instance where media embedding had been deliberately switched **off** would start sending uploads to the
 *     vision and speech models again after a rollback;
 *   - a space's `description` — the field an older build serves to MCP clients as space instructions.
 *
 * Neither failure announces itself: the field is simply absent, which an old build reads as "never configured"
 * rather than "removed".
 *
 * The mechanism to go back already existed — the docs tell you to back up before upgrading — it just was never
 * named as the rollback, and the specific consequences were never stated.
 *
 * ## What this gate holds
 *
 * That the documented list stays complete. A migration added to `loadConfig` without a row in the rollback table
 * is a one-way door nobody was told about, and this is the only thing that would notice.
 *
 * Run: node --test testing/standalone/rollback-is-documented.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { markdownSectionWithSubsections } from './_structural-window.mjs';

const read = (p) => readFileSync(p, 'utf8');
const LOADER = read('server/src/config/loader.ts');
// The upgrade and rollback notes have their own page since 02-hosting reached the document size limit (bundle-46).
const DOC = read('docs/integration-guide/02b-upgrading.md');

/** Strip comments, so a migration named only in prose is not mistaken for a call. */
const CODE = LOADER.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of `loadConfig`, where a persisted migration has to be invoked to run at boot. */
function loadConfigBody() {
  const at = CODE.indexOf('export function loadConfig()');
  assert.ok(at > 0, 'loadConfig is gone — re-anchor this gate');
  const end = CODE.indexOf('\n}', at);
  assert.ok(end > at, 'could not bound loadConfig');
  return CODE.slice(at, end);
}

/** Every `migrateX(...)` invoked from loadConfig, i.e. every rewrite an upgrade performs. */
function bootMigrations() {
  return [...new Set([...loadConfigBody().matchAll(/\b(migrate[A-Za-z0-9_]+)\s*\(/g)].map(m => m[1]))];
}

/** The rollback section of the hosting guide. */
function rollbackSection() {
  const section = markdownSectionWithSubsections(DOC, 'Rolling Back');
  assert.ok(section, 'the Rolling Back section is gone — a one-way upgrade with no documented way back');
  return section;
}

/*
 * Boot migrations that deliberately write NOTHING, and therefore have nothing for a rollback to undo.
 *
 * At module scope because BOTH suites below need it — the persistence count and the field map. Two
 * copies of one exemption is how they drift apart, and the half that still exempts is the half that
 * wins silently. `CLAUDE.md` names it as the defect this repo produces most.
 *
 * Named individually with a reason rather than pattern-matched: an exemption a future migration could
 * fall into by accident is the hole this whole gate exists to prevent.
 */
const IN_MEMORY_ONLY = {
  migrateTokenRightsOnBoot:
    'derives a rights matrix in memory and writes nothing — deliberately, because enforcement still '
    + 'reads the legacy fields, so persisting a derivation before it has been compared against the '
    + 'behaviour it reproduces would make any defect in it durable (see loadConfig, and `D-2`)',
};

describe('the sweep works before it is trusted', () => {
  it('every exemption names a migration that still runs, and gives a reason', () => {
    // An exemption for a migration that no longer exists is a hole with a name in front of it.
    for (const [name, why] of Object.entries(IN_MEMORY_ONLY)) {
      assert.ok(bootMigrations().includes(name), `${name} is exempted here and no longer runs at boot`);
      assert.ok(why.length > 40, `${name} is exempted without a real reason`);
    }
  });
  it('finds the boot migrations', () => {
    const found = bootMigrations();
    assert.ok(found.length >= 3, `expected the boot migrations, found ${JSON.stringify(found)}`);
    assert.ok(found.includes('migrateMediaEmbeddingMasterSwitch'), 'the known migration set is not being found');
  });

  it('each one actually persists, which is what makes it one-way', () => {
    // A migration that only adjusts the in-memory config is harmless to a rollback. It is `saveConfig` that
    // rewrites the file on disk, and that is what an older build then has to read.
    //
    // Counted in the loader AND in the modules it delegates to. `migrateTokenRightsOnBoot` lives in
    // `auth/backfill-token-rights.ts` — it was moved out when persisting it pushed the loader past its
    // god-file freeze — and it saves there. Counting only the loader body made this gate report three saves
    // for four migrations and call the fourth non-persisting, which was the opposite of true.
    const body = loadConfigBody();
    const delegated = [...LOADER.matchAll(/import \{ (migrate[A-Za-z0-9_]+) \} from '([^']+)'/g)]
      // Resolved against the LOADER's own directory, not `server/src`. A sibling import — `./migrate-x.js`
      // from inside `config/` — landed on `server/src/migrate-x.ts`, which does not exist, so the module
      // was read as '' and its `saveConfig` went uncounted. The count then passed only because it happened
      // to tie; the next delegated migration is what turned a silent under-count into a red gate.
      .map(m => m[2].replace(/\.js$/, '.ts'))
      .map(rel => {
        const abs = rel.startsWith('../') ? `server/src/${rel.slice(3)}` : `server/src/config/${rel.replace(/^\.\//, '')}`;
        try { return read(abs); } catch { return ''; }
      })
      .join('\n');
    const saves = [...body.matchAll(/saveConfig\(_config\)/g)].length
      + [...delegated.matchAll(/persist\(config\)|saveConfig\(config\)/g)].length;
    /*
     * IN-MEMORY MIGRATIONS ARE EXCLUDED, and the rule this gate already states is why: *"a migration
     * that only adjusts the in-memory config is harmless to a rollback"*. It then required every
     * migration to persist, which is the opposite of that sentence — and it passed only because
     * `migrateTokenRightsOnBoot` CONTAINED a `persist(config)` call that threw on every boot.
     *
     * So the count was matching a call that never did anything, and the rollback section it protects
     * described a file change that has never happened on any instance.
     *
     * Named individually with a reason rather than pattern-matched: an exemption a future migration
     * could fall into by accident is the hole this gate exists to prevent.
     */
    const migrations = bootMigrations().filter(m => !(m in IN_MEMORY_ONLY)).length;
    // One save is not enough: a single `saveConfig` left behind while the others were removed satisfied a bare
    // `assert.match`, so the gate would have kept describing a hazard that only partly existed.
    assert.ok(saves >= migrations,
      `${migrations} boot migration(s) but only ${saves} saveConfig call(s) — if a migration no longer persists, `
      + 'the rollback section should be simplified rather than left describing a hazard that is gone');
  });
});

describe('every rewrite an upgrade performs is documented as one-way', () => {
  it('the rollback section names each dropped field', () => {
    // Matched on the FIELD rather than the function name: an operator reads config.json, not our source. The
    // mapping is stated here so a new migration fails this test until its field is added to the table.
    const FIELD_BY_MIGRATION = {
      migrateMediaEmbeddingMasterSwitch: 'mediaEmbedding.enabled',
      migrateSpaceDescriptionToPurpose: 'description',
      migrateFaceRecognitionSwitch: 'faceRecognition.enabled',
      // Writes a `rights` matrix onto every token that lacked one, so an older build reads tokens carrying a
      // field it does not know. Harmless in itself — the legacy fields are left in place — but an operator
      // rolling back needs to know the file changed shape.
      // NOT LISTED: `migrateTokenRightsOnBoot` derives in memory and writes nothing, so there is no
      // field for the rollback section to name. It was mapped to `tokens[].rights` and the guide
      // described that shape change — over a write that threw on every boot, so it never occurred.
      // Add a row here on the day persistence ships (`D-2`), not before.
      // MOVES a credential rather than dropping a setting, which is why the rollback row says the key is
      // still recoverable: it is in `secrets.json` (0o600) and can be pasted back for an older build. The
      // consequence of not doing that is a 401 from an external provider, not a changed default.
      migrateProviderApiKeysOnBoot: 'apiKey',
      // The config-file half of the 2.1 rename. Dropping these without the lift would not error — it
      // would silently resolve to the built-in default endpoint, which is the worst shape a rollback
      // note can describe, so the table says which four names an older build stops finding.
      migrateMediaAliasesOnBoot: 'ollamaUrl',
      // The only rewrite on this list with NO rollback cost, and it is listed for exactly that reason: an
      // operator reading the table has to be able to tell the safe row from the five that are not. A
      // shorthand becomes the cron expression it always translated to, and every 3.x build tried
      // `validate()` first — so an older build runs the rewritten value identically. The row says so
      // rather than leaving a rewrite unmentioned, which is what a reader would otherwise have to assume
      // the worst about.
      migrateSyncScheduleShorthands: 'syncSchedule',
      // Q-137 follow-up: fills a never-stated schedule with the join default. An older build runs the cron it wrote.
      defaultUnstatedJoinedSchedules: 'syncSchedule',
      // Q-133: MOVES a network's schema layer / membership origin from a renamed space's old name to its current
      // one. Nothing is deleted; an older build looks under the old key again and finds the layer gone there.
      migrateNetworkSpaceKeys: 'schema layer or membership origin',
    };
    const section = rollbackSection();
    const undocumented = [];
    for (const fn of bootMigrations()) {
      // A migration that writes nothing has no field to name — the same list the persistence count
      // uses, so the two cannot disagree about which migrations touch the file.
      if (fn in IN_MEMORY_ONLY) continue;
      const field = FIELD_BY_MIGRATION[fn];
      if (field === undefined) {
        undocumented.push(`${fn} — no entry in this gate's field map, so nobody has said what it drops`);
        continue;
      }
      if (!section.includes(field)) undocumented.push(`${fn} → \`${field}\` is missing from the rollback table`);
    }
    assert.deepEqual(undocumented, [], 'a boot migration rewrites config.json and the rollback section does not '
      + `mention it, so rolling back would lose the setting in silence:\n  ${undocumented.join('\n  ')}`);
  });

  it('it says what an older build DOES, not merely that a field changed', () => {
    // "The field moved" is not the information. "Media embedding turns back on" is.
    const section = rollbackSection();
    assert.match(section, /defaults it back to \*\*`true`\*\*|starts sending uploads/i,
      'the media-embedding row must state the consequence: the old default was true, so a rollback re-enables it');
    assert.match(section, /silent/i,
      'it must say the loss is silent — an absent field reads as "never configured", not "removed"');
  });

  it('it gives the procedure, and names the pre-upgrade config copy as the mechanism', () => {
    const section = rollbackSection();
    // No alternation with prose: "before upgrading" appears in the section's own explanation, so an assertion
    // that accepted either passed with the actual command deleted.
    assert.match(section, /config\.json\.pre-upgrade/,
      'the section must name the pre-upgrade copy of config.json — it is the mechanism, not a suggestion');
    assert.match(section, /docker compose cp \S*config\.json\.pre-upgrade ythril:/,
      'it must show the command that puts the old config BACK, which is the step that makes a rollback work');
    assert.match(section, /docker compose up -d/, 'it must show how to start the pinned previous version');
  });

  it('it covers brain data and vector indexes, not just config', () => {
    // The two questions an operator asks next. Leaving them out invites the assumption that a rollback loses data.
    const section = rollbackSection();
    assert.match(section, /MongoDB|brain data/i, 'it must say what happens to brain data');
    assert.match(section, /[Vv]ector index/, 'it must say what happens to the vector indexes');
  });
});

describe('the upgrade direction still says what it said', () => {
  it('backing up before an upgrade is still documented', () => {
    // The rollback procedure depends on it, so this is now load-bearing rather than advice.
    assert.match(DOC, /Backup before upgrading/i, 'the pre-upgrade backup instruction is gone, and the rollback '
      + 'procedure depends on it');
  });
});
