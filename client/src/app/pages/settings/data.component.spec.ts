/**
 * DataComponent — CHARACTERIZATION tests.
 *
 * The Settings → Data page (backups, schedule, destination, maintenance, DB migration) is 775 lines and
 * shipped with NO coverage. It is next in line for the PR-U11 design-system redesign (SettingsCards,
 * StatusPills, a SummaryStrip, a quarantined Danger Zone, and routing its hardcoded error strings +
 * schedule summary through transloco). Per characterization-tests-before-refactor these are written and
 * proven green against the ORIGINAL code first, so the redesign has a safety net — a test written after
 * the change just proves the new code agrees with itself.
 *
 * They pin what the redesign MUST preserve (the cron round-trip, the config builder, the API call flows
 * and their error fallbacks, the confirm-gating on the two irreversible actions). The PR-U11 redesign has
 * now landed, so the display-helper tests below track the CHANGED behaviour: `scheduleSummary()` and the
 * error fallbacks resolve transloco keys (was hardcoded English), and `sourceBadgeClass()` became
 * `sourcePillVariant()` returning a StatusPill variant (was a raw badge class).
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { DataComponent } from './data.component';
import { AdminApi } from '../../core/admin-api.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';

/** A fully-stubbed AdminApi; each test overrides the methods it exercises. */
function makeAdmin(over: Partial<Record<string, unknown>> = {}) {
  return {
    getDataConfig:       () => of({ source: 'config', mongoUriRedacted: 'mongodb://***@db/ythril', migrationEnabled: false }),
    getMaintenanceStatus:() => of({ active: false, manual: false, heldBy: null }),
    getBackupConfig:     () => of({ config: null, backupsPath: '' }),
    listBackups:         () => of({ backups: [] }),
    triggerBackup:       () => of({ backup: { id: 'b1', dir: '/x', manifest: {} } }),
    // bundle-157: a restore and a migrate answer 202 with the set they registered (`testing/data-act-bodies.ts` has the real bodies).
    restoreBackup:       () => of({ restoreId: 's1', backupId: 'bkp-9', spaces: ['general'], emptied: [], leftOut: [] }),
    getRestoreReport:    () => of({ restore: null }),
    getMigrateReport:    () => of({ migrate: null }),
    abandonRestore:      () => of({ restoreId: 's1', halfRestored: [], completed: [] }),
    saveBackupConfig:    (config: unknown) => of({ ok: true, config }),
    testMongoConnection: () => of({ ok: true }),
    setMaintenance:      (active: boolean) => of({ active, manual: active, heldBy: null }),
    startMigration:      () => of({ migrateId: 'm1', spaces: ['general'] }),
    ...over,
  } as unknown as AdminApi;
}

function make(admin: AdminApi = makeAdmin(), confirmResult: unknown = true) {
  TestBed.resetTestingModule();
  const confirm = vi.fn().mockResolvedValue(confirmResult);
  TestBed.configureTestingModule({
    imports: [DataComponent, getTranslocoModule()],
    providers: [
      { provide: AdminApi, useValue: admin },
      { provide: ConfirmDialogService, useValue: { confirm } },
    ],
  });
  const fixture = TestBed.createComponent(DataComponent);
  const c = fixture.componentInstance;
  return { c, confirm, fixture };
}

/** Reach a private method/field for characterization without changing visibility. */
const priv = (c: unknown) => c as Record<string, (...a: unknown[]) => unknown> & Record<string, unknown>;

describe('DataComponent — cron build/parse (schedule round-trip)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('buildCron maps each frequency to the expected cron expression', () => {
    const { c } = make();
    const build = (f: string, extra: Record<string, number> = {}) => {
      c.scheduleForm = { ...c.scheduleForm, frequency: f as never, hour: 2, minute: 0, weekday: 1, monthDay: 1, ...extra };
      return priv(c)['buildCron']();
    };
    expect(build('never')).toBeUndefined();
    expect(build('hourly')).toBe('0 * * * *');
    expect(build('daily', { hour: 3, minute: 15 })).toBe('15 3 * * *');
    expect(build('weekly', { hour: 4, minute: 0, weekday: 5 })).toBe('0 4 * * 5');
    expect(build('monthly', { hour: 6, minute: 30, monthDay: 12 })).toBe('30 6 12 * *');
  });

  it('parseCron is the inverse of buildCron and clamps out-of-range fields', () => {
    const { c } = make();
    const parse = (cron: string | undefined) => { priv(c)['parseCron'](cron); return { ...c.scheduleForm }; };
    expect(parse(undefined).frequency).toBe('never');
    expect(parse('nonsense').frequency).toBe('never');            // wrong field count → never
    expect(parse('0 * * * *').frequency).toBe('hourly');
    expect(parse('15 3 * * *')).toMatchObject({ frequency: 'daily', hour: 3, minute: 15 });
    expect(parse('0 4 * * 5')).toMatchObject({ frequency: 'weekly', weekday: 5 });
    expect(parse('30 6 12 * *')).toMatchObject({ frequency: 'monthly', monthDay: 12 });
    // clamping: hour 99 → 23, minute 88 → 59, monthDay 40 → 28, weekday 9 → 6
    expect(parse('88 99 * * *')).toMatchObject({ hour: 23, minute: 59 });
    expect(parse('0 2 40 * *').monthDay).toBe(28);
    expect(parse('0 2 * * 9').weekday).toBe(6);
  });

  it('build→parse→build is stable for a weekly schedule', () => {
    const { c } = make();
    c.scheduleForm = { frequency: 'weekly', hour: 9, minute: 45, weekday: 3, monthDay: 1 };
    const cron = priv(c)['buildCron']() as string;
    priv(c)['parseCron'](cron);
    expect(priv(c)['buildCron']()).toBe(cron);
  });
});

describe('DataComponent — buildConfig assembly', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('emits `encrypt` only when it is ON, so turning it off REMOVES the key', () => {
    /*
     * A branch nothing covered, and the type checker is what found it: six fixtures omitted `encrypt`
     * entirely, so it was `undefined` on every one and neither side of `if (this.destForm.encrypt)` was ever
     * taken. Completing the fixtures made the omission visible.
     *
     * The asymmetry is the behaviour: ON writes `encrypt: true`, OFF writes NOTHING rather than
     * `encrypt: false`. That keeps an untouched `backup.json` byte-identical and keeps
     * "absent means plaintext" the single source of truth — a written `false` would make two spellings of
     * the same state, which is what the component's own comment says it is avoiding.
     */
    const { c } = make();
    c.scheduleForm = { frequency: 'daily', hour: 2, minute: 0, weekday: 1, monthDay: 1 };

    // `priv` hands back `unknown` on purpose — it is a window into a private method, not a typed API. The
    // shape is stated here rather than by widening `priv`, which every other case in this file relies on
    // being deliberately opaque.
    const built = () => priv(c)['buildConfig']() as Record<string, unknown>;

    c.destForm = { ythrilInternal: true, customPath: '', keepLocal: 7, encrypt: true };
    expect(built()['encrypt']).toBe(true);

    c.destForm = { ythrilInternal: true, customPath: '', keepLocal: 7, encrypt: false };
    expect('encrypt' in built(), 'OFF must remove the key, not write false').toBe(false);
  });

  it('assembles schedule + keepLocal retention, and only adds offsite for a custom path', () => {
    const { c } = make();
    c.scheduleForm = { frequency: 'daily', hour: 2, minute: 0, weekday: 1, monthDay: 1 };
    c.destForm = { ythrilInternal: true, customPath: '', keepLocal: 7 , encrypt: false };
    expect(priv(c)['buildConfig']()).toEqual({ schedule: '0 2 * * *', retention: { keepLocal: 7 } });

    // custom offsite path → offsite block carries destPath + keepCount
    c.destForm = { ythrilInternal: false, customPath: '  /mnt/backups  ', keepLocal: 3 , encrypt: false };
    expect(priv(c)['buildConfig']()).toEqual({
      schedule: '0 2 * * *',
      retention: { keepLocal: 3 },
      offsite: { destPath: '/mnt/backups', retention: { keepCount: 3 } },
    });
  });

  it('omits schedule when never and retention when keepLocal is null/0', () => {
    const { c } = make();
    c.scheduleForm = { frequency: 'never', hour: 2, minute: 0, weekday: 1, monthDay: 1 };
    c.destForm = { ythrilInternal: true, customPath: '', keepLocal: null , encrypt: false };
    expect(priv(c)['buildConfig']()).toEqual({});
    c.destForm = { ythrilInternal: true, customPath: '', keepLocal: 0 , encrypt: false };
    expect(priv(c)['buildConfig']()).toEqual({});
  });
});

describe('DataComponent — display helpers (U11: now routed through transloco)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  // The testing TranslocoModule echoes the key back (no translations loaded), so we assert on the
  // stable key each branch resolves — pinning that the phrasing is now a translation, not a literal.
  it('scheduleSummary resolves a per-frequency translation key', () => {
    const { c } = make();
    const sum = (f: string, extra: Record<string, number> = {}) => {
      c.scheduleForm = { ...c.scheduleForm, frequency: f as never, hour: 14, minute: 0, weekday: 1, monthDay: 1, ...extra };
      return c.scheduleSummary();
    };
    expect(sum('never')).toBe('');
    expect(sum('hourly')).toBe('data.schedule.summary.hourly');
    expect(sum('daily')).toBe('data.schedule.summary.daily');
    expect(sum('weekly')).toBe('data.schedule.summary.weekly');
    expect(sum('monthly', { monthDay: 3 })).toBe('data.schedule.summary.monthly');
  });

  it('formatHour resolves clock labels through transloco (midnight / noon / am / pm keys)', () => {
    const { c } = make();
    expect(c.formatHour(0)).toBe('data.time.midnight');
    expect(c.formatHour(12)).toBe('data.time.noon');
    expect(c.formatHour(2)).toBe('2:00 data.time.am');   // am key echoed
    expect(c.formatHour(15)).toBe('3:00 data.time.pm');  // pm key echoed, 12h conversion
  });

  it('sourcePillVariant maps the URI source to a StatusPill variant', () => {
    const { c } = make();
    c.uriSource.set('env');    expect(c.sourcePillVariant()).toBe('warn');
    c.uriSource.set('config'); expect(c.sourcePillVariant()).toBe('active');
    c.uriSource.set('default');expect(c.sourcePillVariant()).toBe('off');
  });

  it('destConfigured / scheduleConfigured reflect the forms', () => {
    const { c } = make();
    c.destForm = { ythrilInternal: true, customPath: '/x', keepLocal: null , encrypt: false };
    expect(c.destConfigured()).toBe(false);                         // internal → not "configured" offsite
    c.destForm = { ythrilInternal: false, customPath: '/x', keepLocal: null , encrypt: false };
    expect(c.destConfigured()).toBe(true);
    c.scheduleForm = { ...c.scheduleForm, frequency: 'never' };
    expect(c.scheduleConfigured()).toBe(false);
    c.scheduleForm = { ...c.scheduleForm, frequency: 'daily' };
    expect(c.scheduleConfigured()).toBe(true);
  });
});

describe('DataComponent — API flows and error fallbacks', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('takeBackup sets backupTaken on success; falls back to the data.backup.error key on error', () => {
    const okc = make().c;
    okc.takeBackup();
    expect(okc.backupTaken()).toBe(true);
    expect(okc.backingUp()).toBe(false);

    const errc = make(makeAdmin({ triggerBackup: () => throwError(() => ({ error: {} })) })).c;
    errc.takeBackup();
    expect(errc.backupError()).toBe('data.backup.error');
  });

  it('confirmRestore does NOT call restoreBackup when the confirm is cancelled', async () => {
    const restoreBackup = vi.fn().mockReturnValue(of({ ok: true }));
    const { c } = make(makeAdmin({ restoreBackup }), false); // confirm resolves false
    await c.confirmRestore('bkp-9');
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it('confirmRestore requires typing the backup id, then restores on confirm', async () => {
    const restoreBackup = vi.fn().mockReturnValue(of({ restoreId: 's1', backupId: 'bkp-9', spaces: ['general'], emptied: [], leftOut: [] }));
    const { c, confirm } = make(makeAdmin({ restoreBackup }), true);
    await c.confirmRestore('bkp-9');
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true, requireText: 'bkp-9' }));
    expect(restoreBackup).toHaveBeenCalledWith('bkp-9', undefined);
    // bundle-157: a 202 is ACCEPTED, never "completed" (`data.component.acts.spec.ts` holds the words).
    expect(c.restoreError()).toBeNull();
  });

  it('saveSchedule / saveDest post buildConfig() and surface a "Save failed" fallback on error', () => {
    const saveOk = vi.fn().mockReturnValue(of({ ok: true, config: {} }));
    const okc = make(makeAdmin({ saveBackupConfig: saveOk })).c;
    okc.saveSchedule();
    expect(saveOk).toHaveBeenCalledTimes(1);
    expect(okc.scheduleSaveSuccess()).toBe(true);

    const errc = make(makeAdmin({ saveBackupConfig: () => throwError(() => ({ error: {} })) })).c;
    errc.saveDest();
    expect(errc.destSaveError()).toBe('data.dest.saveError');
  });

  it('toggleMaintenance flips the active flag through setMaintenance', () => {
    const setMaintenance = vi.fn().mockImplementation((active: boolean) => of({ active }));
    const { c } = make(makeAdmin({ setMaintenance }));
    c.maintenanceActive.set(false);
    c.toggleMaintenance();
    expect(setMaintenance).toHaveBeenCalledWith(true);
    expect(c.maintenanceActive()).toBe(true);
  });

  it('testMigrateConnection ignores an empty URI and records the result otherwise', () => {
    const testMongoConnection = vi.fn().mockReturnValue(of({ ok: true }));
    const { c } = make(makeAdmin({ testMongoConnection }));
    c.migrateUri = '   ';
    c.testMigrateConnection();
    expect(testMongoConnection).not.toHaveBeenCalled();
    c.migrateUri = 'mongodb://other/db';
    c.testMigrateConnection();
    expect(testMongoConnection).toHaveBeenCalledWith('mongodb://other/db');
    expect(c.testResult()).toEqual({ ok: true });
  });

  it('confirmMigrate maps FEATURE_DISABLED / INFRA_MANAGED / generic errors to distinct messages', async () => {
    const mk = (code?: string) => make(makeAdmin({ startMigration: () => throwError(() => ({ error: { code } })) }), true).c;
    const disabled = mk('FEATURE_DISABLED');
    disabled.migrateUri = 'mongodb://x/y';
    await disabled.confirmMigrate();
    expect(disabled.migrateError()).toBe('data.migrate.errorFeatureDisabled');

    const infra = mk('INFRA_MANAGED');
    infra.migrateUri = 'mongodb://x/y';
    await infra.confirmMigrate();
    expect(infra.migrateError()).toBe('data.migrate.errorInfraManaged');

    const generic = mk(undefined);
    generic.migrateUri = 'mongodb://x/y';
    await generic.confirmMigrate();
    expect(generic.migrateError()).toBe('data.migrate.error');
  });

  it('confirmMigrate does NOT start a migration when the confirm is cancelled', async () => {
    const startMigration = vi.fn().mockReturnValue(of({ ok: true }));
    const { c } = make(makeAdmin({ startMigration }), false);
    c.migrateUri = 'mongodb://x/y';
    await c.confirmMigrate();
    expect(startMigration).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Summary strip vs translation loading
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('DataComponent — the summary strip waits for translations', () => {
  /**
   * `summaryItems` is a computed that translates IMPERATIVELY. A computed memoises on its signal
   * dependencies, and `transloco.translate()` is not one — so without care it evaluates during the
   * first render, before the language file resolves, logs "Missing translation key" and bakes the raw
   * key into the label, then never re-runs to correct it.
   *
   * On the real page that was invisible: `backups()` and `backupConfig()` land after their HTTP calls,
   * which happens to be after translations load, so the strip re-evaluated and looked right. It was
   * correct by luck, and three console errors said so.
   *
   * ── What these tests do and do NOT cover ──────────────────────────────────────────────────────
   *
   * They do NOT reproduce the timing defect. `TranslocoTestingModule` preloads synchronously
   * (`preloadLangs: true`), so `translate()` works on the first evaluation and the bug cannot occur
   * here. Mutation confirms it: deleting the readiness guard entirely leaves every test below green.
   *
   * The fix is verified in a BROWSER — three `Missing translation key` console errors before, zero
   * after, on both a direct navigation and a re-navigation.
   *
   * What these tests DO guard is the regression the fix could introduce: gating on readiness must not
   * blank the strip. The first attempt required a non-empty dictionary and did exactly that, and the
   * mutation for it is caught below. That is worth having — it is just not coverage of the defect.
   */
  it('produces items at all — the loop below is worthless on an empty array', () => {
    // Asserted separately and FIRST because the original version of the next test iterated the labels
    // and passed vacuously while the strip was empty. A per-item assertion over zero items proves
    // nothing, which is the same shape as a green test over deleted code.
    const { c, fixture } = make();
    fixture.detectChanges();
    expect(c.summaryItems().length).toBeGreaterThan(0);
  });

  it('renders resolved labels when a dictionary is present', () => {
    // The default harness deliberately ships an EMPTY `en` and echoes unknown keys, so a raw key there
    // is correct behaviour rather than the defect — asserting against it would fail for the wrong
    // reason. Give it a real dictionary and the assertion becomes meaningful.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [DataComponent, getTranslocoModule({
        translation: { en: { 'data.summary.database': 'Database', 'data.summary.backups': 'Backups' } },
      })],
      providers: [
        { provide: AdminApi, useValue: makeAdmin() },
        { provide: ConfirmDialogService, useValue: { confirm: vi.fn().mockResolvedValue(true) } },
      ],
    });
    const fixture = TestBed.createComponent(DataComponent);
    fixture.detectChanges();

    const labels = fixture.componentInstance.summaryItems().map(i => String(i.label));
    expect(labels.length).toBeGreaterThan(0);
    // Only the keys supplied above can resolve — the harness echoes the rest, correctly. Asserting
    // "no raw keys at all" would mean mirroring the whole dictionary here, which rots on every copy
    // edit and would fail for a reason that has nothing to do with this defect.
    expect(labels).toContain('Backups');
    expect(labels).toContain('Database');
  });

  it('still renders when translations were ALREADY loaded before the component mounted', () => {
    // The regression the first attempt at this fix would have caused. `events$` does not replay, so a
    // check that waited only for the load EVENT would leave a component mounted after that event with
    // an empty strip forever — worse than the bug being fixed. The synchronous `getTranslation()` half
    // is what covers it, and in TestBed translations are already present, which is exactly this case.
    const { c, fixture } = make();
    fixture.detectChanges();
    expect(c.summaryItems().length, 'the strip must not be empty when translations pre-exist').toBeGreaterThan(0);
  });

  it('reports the backup count from the loaded backups', () => {
    // Guards that gating on translations did not also gate away the data.
    const { c, fixture } = make();
    fixture.detectChanges();
    const backupItem = c.summaryItems().find(i => String(i.label).toLowerCase().includes('backup'));
    expect(backupItem, 'a backups item should be present').toBeTruthy();
  });
});
