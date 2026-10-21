/**
 * bundle-157 (Q-552, Q-553): the Data page shows a restore or a migrate as the act set it now is.
 *
 * The server answers a restore 202 and runs it as one act per space; the page said "Restore completed" on any success, typed the answer
 * `{ ok }`, and its confirm text promised things no longer true. These run the real AdminApi against HttpTestingController and flush the
 * server's bodies (`testing/data-act-bodies.ts`), so they hold whatever the service and the page do with the wire.
 *
 * Lessons from bundle-100/106's client slices, each its own case below: the progress poll runs only while the page is open; an answer
 * that lands after the page closed starts no poll; the outcome is HEARD (the live region is in the DOM before its text changes, and the
 * text is in it after the announcement's gap); nothing is said about progress before the report it depends on has loaded.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { DataComponent } from './data.component';
import { AdminApi } from '../../core/admin-api.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import type { WireAnswer } from '../../testing/space-act-bodies';
import {
  ABANDON_ANSWERS, BACKUP_ID, DATA_SERVER_SENTENCES, MAINTENANCE, MIGRATE_ANSWERS, RESTORE_ANSWERS, migrateReport, restoreReport, restoreSpace,
} from '../../testing/data-act-bodies';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const TEN_MINUTES = 600_000;

/** Plural and count sentences resolve to visible text (the harness echoes a missing key, and pluralText treats an echo as "no words"). */
const WORDS: Record<string, string> = {
  'data.restore.accepted.one': 'ACCEPTED-ONE {{count}}',
  'data.restore.accepted.other': 'ACCEPTED {{count}}',
  'data.progress.spacesDone.one': 'DONE {{done}} of {{count}}',
  'data.progress.spacesDone.other': 'DONE {{done}} of {{count}}',
  'data.restore.emptied.one': 'EMPTIED {{count}}: {{spaces}}',
  'data.restore.emptied.other': 'EMPTIED {{count}}: {{spaces}}',
  'data.restore.leftOut.one': 'LEFT-OUT {{count}}: {{spaces}}',
  'data.restore.leftOut.other': 'LEFT-OUT {{count}}: {{spaces}}',
  'data.migrate.accepted.one': 'MIGRATING {{count}}',
  'data.migrate.accepted.other': 'MIGRATING {{count}}',
  'data.maintenance.restoring': 'RESTORING {{done}} of {{total}}',
};

interface Page {
  fixture: ComponentFixture<DataComponent>;
  c: DataComponent;
  http: HttpTestingController;
  confirm: ReturnType<typeof vi.fn>;
}

interface Boot {
  migrationEnabled?: boolean;
  maintenance?: Record<string, unknown>;
  /** The restore report the page loads on open; `'pending'` leaves the request unanswered. */
  restore?: Record<string, unknown> | 'pending';
  migrate?: Record<string, unknown>;
}

function open(boot: Boot = {}): Page {
  const confirm = vi.fn((_data: unknown) => Promise.resolve(true));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [DataComponent, getTranslocoModule({ translation: { en: WORDS } })],
    providers: [AdminApi, provideHttpClient(), provideHttpClientTesting(), { provide: ConfirmDialogService, useValue: { confirm } }],
  });
  const fixture = TestBed.createComponent(DataComponent);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  http.expectOne(r => r.method === 'GET' && r.url === '/api/admin/data/config')
    .flush({ source: 'config', mongoUriRedacted: 'mongodb://***@db/ythril', migrationEnabled: boot.migrationEnabled ?? false });
  if (boot.migrationEnabled) http.match('/api/admin/data/backup-config').forEach(r => r.flush({ config: null, backupsPath: '' }));
  http.expectOne(r => r.method === 'GET' && r.url === '/api/admin/data/maintenance').flush(boot.maintenance ?? MAINTENANCE.off);
  http.expectOne('/api/admin/data/backups').flush({ backups: [{ id: BACKUP_ID, createdAt: '2026-10-18T10:00:00.000Z', collections: [] }] });
  const restore = http.expectOne(r => r.method === 'GET' && r.url === '/api/admin/data/restore');
  if (boot.restore !== 'pending') restore.flush(boot.restore ?? { restore: null });
  http.match(r => r.method === 'GET' && r.url === '/api/admin/data/migrate').forEach(r => r.flush(boot.migrate ?? { migrate: null }));
  fixture.detectChanges();
  return { fixture, c: fixture.componentInstance, http, confirm };
}

const flushWire = (req: TestRequest, a: WireAnswer) => req.flush(a.body, { status: a.status, statusText: String(a.status) });
const el = (p: Page) => p.fixture.nativeElement as HTMLElement;
const textOf = (p: Page, selector: string) => Array.from(el(p).querySelectorAll(selector)).map(e => e.textContent ?? '').join(' | ');
const statusText = (p: Page) => textOf(p, '[role="status"]');
const pageText = (p: Page) => el(p).textContent ?? '';
const reportPolls = (p: Page) => p.http.match(r => r.method === 'GET' && r.url === '/api/admin/data/restore');
const buttonWith = (p: Page, key: string) => Array.from(el(p).querySelectorAll('button')).find(b => b.textContent?.includes(key));

async function restoreAnswered(p: Page, a: WireAnswer): Promise<void> {
  await p.c.confirmRestore(BACKUP_ID);
  flushWire(p.http.expectOne(r => r.method === 'POST' && r.url === '/api/admin/data/restore'), a);
  p.fixture.detectChanges();
}

describe('a restore is accepted, then shown as it runs (bundle-157)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a 202 says accepted, with the space count through pluralText, and never "completed"', async () => {
    const p = open();
    await restoreAnswered(p, RESTORE_ANSWERS.accepted);
    expect(statusText(p)).toContain('ACCEPTED 3');
    expect(pageText(p)).not.toContain('data.backup.restoreSuccess');
    const one = open();
    await restoreAnswered(one, RESTORE_ANSWERS.acceptedOne);
    expect(statusText(one)).toContain('ACCEPTED-ONE 1');
  });

  it('after the 202 the report is asked for at once and the progress card shows k of n, a progressbar and a row per space', async () => {
    const p = open();
    await restoreAnswered(p, RESTORE_ANSWERS.accepted);
    reportPolls(p).forEach(r => r.flush(restoreReport()));
    vi.advanceTimersByTime(10);
    p.fixture.detectChanges();
    expect(pageText(p)).toContain('DONE 1 of 3');
    expect(el(p).querySelector('[role="progressbar"]'), 'the step progress bar').not.toBeNull();
    for (const id of ['general', 'notes', 'proj']) expect(pageText(p)).toContain(id);
    expect(pageText(p), 'the owed member says why').toContain('unique indexes refuses');
    expect(pageText(p)).not.toContain('data.backup.restoreSuccess');
  });

  it('the emptied and left-out spaces are named, counted through pluralText', () => {
    const p = open({ restore: restoreReport({ emptied: ['proj'], leftOut: ['old-notes', 'retired'] }) });
    expect(pageText(p)).toContain('EMPTIED 1: proj');
    expect(pageText(p)).toContain('LEFT-OUT 2: old-notes, retired');
  });

  it('the restore button carries its busy state while the request is out', async () => {
    const p = open();
    const pending = p.c.confirmRestore(BACKUP_ID);
    await pending;
    p.fixture.detectChanges();
    const btn = buttonWith(p, 'data.backup.restoreButton');
    expect(btn?.getAttribute('aria-busy')).toBe('true');
    flushWire(p.http.expectOne(r => r.method === 'POST' && r.url === '/api/admin/data/restore'), RESTORE_ANSWERS.accepted);
  });

  it('the confirm text names what is replaced and what is not, that peers re-send, and that erased records come back', async () => {
    const p = open();
    await p.c.confirmRestore(BACKUP_ID);
    const asked = JSON.stringify(p.confirm.mock.calls[0]?.[0] ?? null);
    for (const key of ['data.restore.confirmMessage', 'data.restore.confirmNotReplaced', 'data.restore.confirmPeers', 'data.restore.confirmErasures']) {
      expect(asked, key).toContain(key);
    }
    p.http.match(r => r.method === 'POST').forEach(r => flushWire(r, RESTORE_ANSWERS.accepted));
  });

  it('a running restore is polled while the page is open, and the poll stops when it closes', () => {
    const p = open({ restore: restoreReport() });
    vi.advanceTimersByTime(TEN_MINUTES);
    const first = reportPolls(p);
    expect(first.length, 'a GET /restore while the set runs').toBeGreaterThan(0);
    first[0]!.flush(restoreReport());
    p.fixture.destroy();
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(reportPolls(p)).toHaveLength(0);
  });

  it('no restore running on open: nothing is polled', () => {
    const p = open();
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(reportPolls(p)).toHaveLength(0);
  });

  it('a 202 that lands after the page closed starts no poll', async () => {
    const p = open();
    await p.c.confirmRestore(BACKUP_ID);
    const req = p.http.expectOne(r => r.method === 'POST' && r.url === '/api/admin/data/restore');
    p.fixture.destroy();
    flushWire(req, RESTORE_ANSWERS.accepted);
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(reportPolls(p)).toHaveLength(0);
  });

  it('the end of the restore is heard: the role=status region exists before, and carries the sentence after the gap', () => {
    const p = open({ restore: restoreReport() });
    const region = el(p).querySelector('[role="status"][aria-live="polite"]');
    expect(region, 'the live region is in the DOM before anything is announced').not.toBeNull();
    vi.advanceTimersByTime(TEN_MINUTES);
    reportPolls(p)[0]!.flush(restoreReport({
      state: 'completed', endedAt: '2026-10-18T12:01:00.000Z',
      spaces: [restoreSpace('general', 'done'), restoreSpace('notes', 'done'), restoreSpace('proj', 'done')],
    }));
    p.http.match(r => r.method === 'GET' && r.url === '/api/admin/data/maintenance').forEach(r => r.flush(MAINTENANCE.off));
    vi.advanceTimersByTime(1_000);
    p.fixture.detectChanges();
    expect(el(p).querySelector('[role="status"][aria-live="polite"]'), 'the same region, never re-created').toBe(region);
    expect(statusText(p)).toContain('data.restore.completed');
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(reportPolls(p), 'an ended set is polled no more').toHaveLength(0);
  });

  it('an abandoned set is announced as abandoned, naming the spaces it left half restored', () => {
    const p = open({ restore: restoreReport() });
    vi.advanceTimersByTime(TEN_MINUTES);
    reportPolls(p)[0]!.flush(restoreReport({
      state: 'abandoned', endedAt: '2026-10-18T12:01:00.000Z',
      spaces: [restoreSpace('general', 'done'), restoreSpace('notes', 'restore_abandoned'), restoreSpace('proj', 'restore_abandoned')],
    }));
    vi.advanceTimersByTime(1_000);
    p.fixture.detectChanges();
    expect(statusText(p)).toContain('data.restore.abandonedOutcome');
  });
});

describe('abandon is offered for an owed member, and confirms (bundle-157)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a running set with an owed member offers abandon; a confirmed abandon posts and says which spaces may be half restored', async () => {
    const p = open({ restore: restoreReport() });
    expect(buttonWith(p, 'data.progress.abandon'), 'the abandon button').toBeTruthy();
    await p.c.confirmAbandon();
    expect(p.confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(JSON.stringify(p.confirm.mock.calls[0]?.[0])).toContain('data.progress.abandonConfirm');
    flushWire(p.http.expectOne(r => r.method === 'POST' && r.url === '/api/admin/data/restore/abandon'), ABANDON_ANSWERS.abandoned);
    p.fixture.detectChanges();
    expect(statusText(p)).toContain('data.progress.abandoned');
  });

  it('a cancelled confirm abandons nothing', async () => {
    const p = open({ restore: restoreReport() });
    p.confirm.mockResolvedValueOnce(false);
    await p.c.confirmAbandon();
    expect(p.http.match(r => r.url === '/api/admin/data/restore/abandon')).toHaveLength(0);
  });

  it('no owed member (every space running or done): no abandon is offered', () => {
    const p = open({ restore: restoreReport({ spaces: [restoreSpace('general', 'done'), restoreSpace('proj', 'running')] }) });
    expect(buttonWith(p, 'data.progress.abandon')).toBeUndefined();
  });

  it('an abandon refused because a body runs says so in our words, never the server\'s', async () => {
    const p = open({ restore: restoreReport() });
    await p.c.confirmAbandon();
    flushWire(p.http.expectOne(r => r.url === '/api/admin/data/restore/abandon'), ABANDON_ANSWERS.running);
    p.fixture.detectChanges();
    expect(pageText(p)).toContain('data.refusal.restore_act_running');
    for (const s of DATA_SERVER_SENTENCES) expect(pageText(p)).not.toContain(s);
  });
});

describe('a backup naming spaces this instance does not serve offers the leaveOut retry (bundle-157)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the 400 names the spaces in our words and offers to restore without them; the retry sends leaveOut', async () => {
    const p = open();
    await restoreAnswered(p, RESTORE_ANSWERS.unserved);
    expect(pageText(p)).toContain('data.refusal.backup_names_unserved_spaces');
    expect(pageText(p)).toContain('old-notes');
    for (const s of DATA_SERVER_SENTENCES) expect(pageText(p)).not.toContain(s);
    expect(buttonWith(p, 'data.restore.leaveOutRetry'), 'the retry button').toBeTruthy();
    await p.c.retryLeavingOut();
    const req = p.http.expectOne(r => r.method === 'POST' && r.url === '/api/admin/data/restore');
    expect(req.request.body).toEqual({ backupId: BACKUP_ID, leaveOut: ['old-notes', 'retired'] });
    flushWire(req, RESTORE_ANSWERS.acceptedLeavingOut);
  });

  it('any other refusal offers no leaveOut retry, and says it in our words', async () => {
    for (const a of [RESTORE_ANSWERS.notWhole, RESTORE_ANSWERS.restoring]) {
      const p = open();
      await restoreAnswered(p, a);
      expect(buttonWith(p, 'data.restore.leaveOutRetry')).toBeUndefined();
      expect(pageText(p)).toContain(`data.refusal.${String(a.body['code'])}`);
      for (const s of DATA_SERVER_SENTENCES) expect(pageText(p)).not.toContain(s);
    }
  });
});

describe('the migrate card maps its refusals to keys and says what a migrate does now (bundle-157)', () => {
  afterEach(() => vi.restoreAllMocks());

  async function migrateAnswered(p: Page, a: WireAnswer): Promise<void> {
    p.c.migrateUri = 'mongodb://new-host:27017/ythril';
    await p.c.confirmMigrate();
    flushWire(p.http.expectOne(r => r.method === 'POST' && r.url === '/api/admin/data/migrate'), a);
    p.fixture.detectChanges();
  }

  it('INFRA_MANAGED (the flag, and a URI from the environment) is one key; target_not_empty its own', async () => {
    for (const a of [MIGRATE_ANSWERS.infraFlag, MIGRATE_ANSWERS.infraEnv]) {
      const p = open({ migrationEnabled: true });
      await migrateAnswered(p, a);
      expect(p.c.migrateError()).toBe('data.migrate.errorInfraManaged');
    }
    const t = open({ migrationEnabled: true });
    await migrateAnswered(t, MIGRATE_ANSWERS.targetNotEmpty);
    expect(t.c.migrateError()).toBe('data.migrate.errorTargetNotEmpty');
    for (const s of DATA_SERVER_SENTENCES) expect(pageText(t)).not.toContain(s);
  });

  it('a migrate refused because a restore stands says so in our words', async () => {
    const p = open({ migrationEnabled: true });
    await migrateAnswered(p, MIGRATE_ANSWERS.duringRestore);
    expect(p.c.migrateError()).toBe('data.refusal.space_being_restored');
  });

  it('a 202 says the migrate was accepted, counted through pluralText, and its progress is asked for', async () => {
    const p = open({ migrationEnabled: true });
    await migrateAnswered(p, MIGRATE_ANSWERS.accepted);
    expect(statusText(p)).toContain('MIGRATING 2');
    p.http.match(r => r.method === 'GET' && r.url === '/api/admin/data/migrate').forEach(r => r.flush(migrateReport()));
    p.fixture.detectChanges();
    expect(pageText(p)).toContain('DONE 1 of 2');
  });
});

describe('while a set stands, maintenance says so and the toggle and migrate wait (bundle-157, R5.3)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the maintenance pill reads "restoring k of n" once the report has loaded', () => {
    const p = open({ maintenance: MAINTENANCE.heldByRestore, restore: restoreReport(), migrationEnabled: true });
    expect(pageText(p)).toContain('RESTORING 1 of 3');
  });

  it('nothing is counted before the report has loaded: no "restoring k of n" from an absent report', () => {
    const p = open({ maintenance: MAINTENANCE.heldByRestore, restore: 'pending' });
    expect(pageText(p)).not.toContain('RESTORING');
    expect(pageText(p)).not.toContain('DONE ');
  });

  it('the toggle is disabled with an explaining line while a set holds maintenance', () => {
    const p = open({ maintenance: MAINTENANCE.heldByRestore, restore: restoreReport() });
    const toggle = buttonWith(p, 'data.maintenance.deactivate') ?? buttonWith(p, 'data.maintenance.activate');
    expect(toggle?.disabled).toBe(true);
    expect(pageText(p)).toContain('data.maintenance.heldHint');
  });

  it('the migrate card is disabled with an explaining line while a set stands', () => {
    const p = open({ maintenance: MAINTENANCE.heldByRestore, restore: restoreReport(), migrationEnabled: true });
    p.c.migrateUri = 'mongodb://new-host:27017/ythril';
    p.c.testResult.set({ ok: true });
    p.fixture.detectChanges();
    expect(buttonWith(p, 'data.migrate.migrateButton')?.disabled).toBe(true);
    expect(pageText(p)).toContain('data.migrate.blockedBySet');
  });

  it('a manual maintenance leaves the toggle enabled and says nothing about a set', () => {
    const p = open({ maintenance: MAINTENANCE.manual });
    expect(buttonWith(p, 'data.maintenance.deactivate')?.disabled).toBe(false);
    expect(pageText(p)).not.toContain('data.maintenance.heldHint');
  });
});
