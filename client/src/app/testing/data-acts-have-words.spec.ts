/**
 * Every act kind and every restore or migrate refusal the server can send has its words in en, de and pl (bundle-157, R4.5, A1).
 *
 * `actKindKey(kind)` builds `spaces.dangerZone.act.kind.<kind>` at runtime, so `i18n-key-coverage.spec.ts` (static keys only) cannot see
 * it: the server gained `restore` and the danger tab showed the raw key `spaces.dangerZone.act.kind.restore`, with every test green. The
 * same holds for the per-kind repeat hint and for `refusalText(..., 'data.refusal')`, which looks a code up by name.
 *
 * Derived, never listed: the kinds are the keys of the server's `SPACE_ACT_KINDS` (`server/src/config/types-space-acts.ts`) and the codes
 * are the `code: '...'` literals the data doors answer with, plus each instance-wide kind's `writeRefusalCode` and the backup's refusal
 * during a restore. Each read asserts a floor, so a moved file or a changed spelling cannot pass by finding nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readRepoSource } from './server-source';

const I18N = resolve(__dirname, '../../../public/assets/i18n');
const LOCALES = ['en', 'de', 'pl'] as const;
const dict = (loc: string): Record<string, string> => JSON.parse(readFileSync(resolve(I18N, `${loc}.json`), 'utf8'));

/** The kinds the server's runtime list declares, in its order. */
function serverActKinds(): { kinds: string[]; instanceWideKinds: string[]; instanceWideCodes: string[] } {
  const src = readRepoSource('server/src/config/types-space-acts.ts');
  const start = src.indexOf('SPACE_ACT_KINDS = {');
  const end = src.indexOf('} as const', start);
  if (start < 0 || end < 0) throw new Error('SPACE_ACT_KINDS not found in types-space-acts.ts: the record moved or was renamed');
  const body = src.slice(start, end);
  const entries = [...body.matchAll(/\n {2}([a-z][A-Za-z]*): \{([\s\S]*?)\n {2}\}/g)];
  const kinds = entries.map(m => m[1]!);
  const instanceWide = entries.filter(m => /instanceWide:\s*true/.test(m[2]!));
  const instanceWideKinds = instanceWide.map(m => m[1]!);
  const instanceWideCodes = instanceWide
    .map(m => /writeRefusalCode:\s*'([a-z_]+)'/.exec(m[2]!)?.[1])
    .filter((c): c is string => !!c);
  // The kind count when this gate was written: delete, wipe, rename, restore, migrate.
  if (kinds.length < 5) throw new Error(`found ${kinds.length} act kinds - fewer than 5, so the record's spelling changed and a check over each kind would report clean about nothing`);
  if (instanceWideCodes.length < 2) throw new Error(`found ${instanceWideCodes.length} instance-wide refusal codes - fewer than 2`);
  return { kinds, instanceWideKinds, instanceWideCodes };
}

/**
 * The codes the abandon doors answer with (`server/src/spaces/act-set-abandon.ts`, Q-564): spelled per kind as a template
 * (`no_${kind}_standing`), so each template is expanded over every instance-wide kind - a literal match would find none of them.
 */
function abandonCodes(): string[] {
  const src = readRepoSource('server/src/spaces/act-set-abandon.ts');
  const templates = [...src.matchAll(/code: `([a-z_]*)\$\{kind\}([a-z_]*)`/g)].map(m => [m[1]!, m[2]!] as const);
  if (templates.length < 2) throw new Error(`found ${templates.length} abandon code templates - fewer than 2, so act-set-abandon.ts moved or its spelling changed`);
  return serverActKinds().instanceWideKinds.flatMap(k => templates.map(([pre, post]) => `${pre}${k}${post}`));
}

/** Every code the restore, migrate and backup doors answer with. */
function dataRefusalCodes(): string[] {
  const routes = [...readRepoSource('server/src/api/data.ts').matchAll(/code: '([A-Za-z_]+)'/g)].map(m => m[1]!);
  const backup = [...readRepoSource('server/src/db/backup-scheduler.ts').matchAll(/readonly code = '([A-Za-z_]+)'/g)].map(m => m[1]!);
  const codes = [...new Set([...routes, ...backup, ...abandonCodes(), ...serverActKinds().instanceWideCodes])];
  if (codes.length < 9) throw new Error(`found ${codes.length} data refusal codes - fewer than 9, so a source moved or its spelling changed`);
  return codes;
}

describe('every act kind has its words in every locale (bundle-157)', () => {
  const { kinds } = serverActKinds();

  for (const loc of LOCALES) {
    it(`${loc}: spaces.dangerZone.act.kind.<kind> and .repeatHint.<kind> for each of the server's kinds`, () => {
      const d = dict(loc);
      const missing = kinds.flatMap(k => [`spaces.dangerZone.act.kind.${k}`, `spaces.dangerZone.act.repeatHint.${k}`]).filter(key => !d[key]);
      expect(missing, `${loc}.json lacks words for act kinds the server sends`).toEqual([]);
    });
  }

  it('the states a restore or migrate report row can carry have their pill words (done, <kind>_abandoned for each instance-wide kind)', () => {
    const abandoned = serverActKinds().instanceWideKinds.map(k => `${k}_abandoned`);
    for (const loc of LOCALES) {
      const d = dict(loc);
      for (const s of ['owed', 'running', 'done', ...abandoned]) expect(d[`spaces.dangerZone.act.state.${s}`], `${loc}: state ${s}`).toBeTruthy();
    }
  });
});

describe('every restore, migrate and backup refusal code has its sentence (bundle-157)', () => {
  const codes = dataRefusalCodes();
  for (const loc of LOCALES) {
    it(`${loc}: data.refusal.<code> for each code the data doors answer with`, () => {
      const d = dict(loc);
      expect(codes.filter(c => !d[`data.refusal.${c}`]), `${loc}.json lacks data.refusal sentences`).toEqual([]);
    });
  }
});

describe('counts on the Data page go through pluralText, with every form a locale uses (bundle-157, A2)', () => {
  /** The plural bases the restore and migrate surfaces count with. */
  const BASES = ['data.restore.accepted', 'data.progress.spacesDone', 'data.restore.emptied', 'data.restore.leftOut', 'data.migrate.accepted'];
  // Every locale carries all four forms, as the existing plural families do: English and German use two of them, Polish all four, and
  // `i18n-key-coverage.spec.ts` holds the three files to one key set.
  const ALL = ['one', 'few', 'many', 'other'];
  const FORMS: Record<(typeof LOCALES)[number], string[]> = { en: ALL, de: ALL, pl: ALL };

  for (const loc of LOCALES) {
    it(`${loc}: every base has ${FORMS[loc].join(', ')}, each with {{count}}`, () => {
      const d = dict(loc);
      for (const base of BASES) {
        for (const form of FORMS[loc]) {
          const text = d[`${base}.${form}`];
          expect(text, `${loc}: ${base}.${form}`).toBeTruthy();
          expect(text, `${loc}: ${base}.${form} carries the count`).toContain('{{count}}');
        }
      }
    });
  }

  it('the backup id placeholder has no spaces ({{id}}), like every other key', () => {
    for (const loc of LOCALES) expect(dict(loc)['data.restore.typeIdToConfirm'], loc).toContain('{{id}}');
  });

  it('the migrate copy no longer says the server restarts automatically: the process exits when the copy completes', () => {
    for (const key of ['data.migrate.description', 'data.migrate.confirm', 'data.migrate.confirmMessage', 'data.migrate.success']) {
      expect(dict('en')[key] ?? '', key).not.toMatch(/restart/i);
    }
  });
});
