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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  ABANDON_ANSWERS, BACKUP_ID, DATA_SERVER_SENTENCES, MAINTENANCE, MIGRATE_ABANDON_ANSWERS, MIGRATE_ANSWERS, RESTORE_ANSWERS,
  SET_FAILED_SENTENCE, migrateReport, restoreReport, restoreSpace,
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
  'data.maintenance.restoring.one': 'RESTORING {{done}} of {{count}}',
  'data.maintenance.restoring.other': 'RESTORING {{done}} of {{count}}',
  // A code's sentence must resolve to text for refusalText to take it (an echoed key reads as "no words", and the server's English
  // would be shown instead); each carries its own key so a case can see which one was chosen.
  ...Object.fromEntries([
    'backup_names_unserved_spaces', 'backup_not_whole', 'space_being_restored', 'space_being_migrated', 'restore_act_running',
    'no_restore_standing', 'migrate_act_running', 'no_migrate_standing',
  ].map(code => [`data.refusal.${code}`, `data.refusal.${code} (words)`])),
};

interface Page {
  fixture: ComponentFixture<DataComponent>;
  c: DataComponent;
  http: HttpTestingController;
  confirm: ReturnType<typeof vi.fn>;
}

/** The real en.json, for the cases that pin the sentence an operator reads rather than a key (Q-561). */
const EN: Record<string, string> = JSON.parse(readFileSync(resolve(__dirname, '../../../../public/assets/i18n/en.json'), 'utf8'));

interface Boot {
  /** The English dictionary the page renders with: the harness's `WORDS` unless a case wants the real en.json. */
  words?: Record<string, string>;
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
    imports: [DataComponent, getTranslocoModule({ translation: { en: boot.words ?? WORDS } })],
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

async function migrateAnswered(p: Page, a: WireAnswer): Promise<void> {
  p.c.migrateUri = 'mongodb://new-host:27017/ythril';
  await p.c.confirmMigrate();
  flushWire(p.http.expectOne(r => r.method === 'POST' && r.url === '/api/admin/data/migrate'), a);
  p.fixture.detectChanges();
}
const migratePolls = (p: Page) => p.http.match(r => r.method === 'GET' && r.url === '/api/admin/data/migrate');

/** A running migrate whose set is owed: its copy failed and is retried, as a target that keeps timing out leaves it. */
const owedMigrate = () => migrateReport({
  done: 0, spaces: [restoreSpace('general', 'owed', { attempts: 3, retryAt: '2026-10-18T12:05:00.000Z' }), restoreSpace('notes', 'owed', { attempts: 3 })],
});
const migrateAbandonButton = (p: Page) => Array.from(el(p).querySelectorAll('app-act-set-progress[kind="migrate"] button'))
  .find(b => /abandon/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
/** Click the migrate card's abandon and let the confirm's promise settle. */
async function clickAbandon(p: Page): Promise<void> {
  migrateAbandonButton(p)!.click();
  for (let i = 0; i < 5; i++) await Promise.resolve();
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

  it('the confirm text names what is replaced and what is not, that peers re-send, that erased records come back, and what a restore cannot repair', async () => {
    const p = open();
    await p.c.confirmRestore(BACKUP_ID);
    const asked = JSON.stringify(p.confirm.mock.calls[0]?.[0] ?? null);
    for (const key of [
      'data.restore.confirmMessage', 'data.restore.confirmNotReplaced', 'data.restore.confirmPeers', 'data.restore.confirmErasures',
      'data.restore.confirmLimits',
    ]) {
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

  it('a restore this page started is shown even when its first report says it already ended', async () => {
    const p = open();
    await restoreAnswered(p, RESTORE_ANSWERS.acceptedOne);
    p.http.match(r => r.method === 'GET' && r.url === '/api/admin/data/restore').forEach(r => r.flush(restoreReport({
      state: 'completed', endedAt: '2026-10-18T11:56:00.000Z', emptied: [],
      spaces: [restoreSpace('general', 'done', { completedAt: '2026-10-18T11:56:00.000Z' })],
    })));
    p.fixture.detectChanges();
    expect(pageText(p)).toContain('data.progress.restoreTitle');
    expect(pageText(p)).toContain('DONE 1 of 1');
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
    expect(p.c.migrateError()).toContain('data.refusal.space_being_restored');
  });

  it('a 202 says the migrate was accepted, counted through pluralText, and its progress is asked for', async () => {
    const p = open({ migrationEnabled: true });
    await migrateAnswered(p, MIGRATE_ANSWERS.accepted);
    expect(statusText(p)).toContain('MIGRATING 2');
    p.http.match(r => r.method === 'GET' && r.url === '/api/admin/data/migrate').forEach(r => r.flush(migrateReport()));
    p.fixture.detectChanges();
    expect(pageText(p)).toContain('DONE 1 of 2');
  });

  it('a migrate that failed whole shows the sentence it ended with, which names the backup (the set-level lastError)', async () => {
    const p = open({ migrationEnabled: true });
    await migrateAnswered(p, MIGRATE_ANSWERS.accepted);
    p.http.match(r => r.method === 'GET' && r.url === '/api/admin/data/migrate')
      .forEach(r => r.flush(migrateReport({ state: 'abandoned', lastError: SET_FAILED_SENTENCE, endedAt: '2026-10-18T11:58:00.000Z' })));
    p.fixture.detectChanges();
    expect(pageText(p)).toContain(SET_FAILED_SENTENCE);
    expect(pageText(p)).toContain(BACKUP_ID);
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

/*
 * bundle-157 (Q-561, finding 5), with the REAL en.json: after a restore ends the visible notice is the end sentence (it said "Restore
 * accepted: 54 spaces are being restored" for ever, and the completion sentence was only in the sr-only live region); and a migrate, which
 * ends by exiting the process, says the instance has stopped when its report poll stops answering instead of freezing at "0 of n / Running".
 */
describe('the end of a restore is shown, and a migrate that stops the instance says so (Q-561)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** What a sighted operator reads in the live region's alerts: the sr-only span is not it. */
  const visibleNotice = (p: Page) =>
    Array.from(el(p).querySelectorAll('[role="status"] .alert')).map(e => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).join(' | ');
  const cardText = (p: Page, kind: string) => (el(p).querySelector(`app-act-set-progress[kind="${kind}"]`)?.textContent ?? '').replace(/\s+/g, ' ');

  /** A restore this page started, followed to the report that ends it. */
  async function restoreEnded(ended: Record<string, unknown>): Promise<Page> {
    const p = open({ words: EN });
    await restoreAnswered(p, RESTORE_ANSWERS.accepted);
    expect(visibleNotice(p), 'accepted is said while it runs').toContain('Restore accepted: 3 spaces are being restored');
    reportPolls(p).forEach(r => r.flush(restoreReport()));
    vi.advanceTimersByTime(TEN_MINUTES);
    reportPolls(p)[0]!.flush(restoreReport(ended));
    p.http.match(r => r.method === 'GET' && r.url === '/api/admin/data/maintenance').forEach(r => r.flush(MAINTENANCE.off));
    vi.advanceTimersByTime(1_000);
    p.fixture.detectChanges();
    return p;
  }

  it('a completed restore replaces the accepted notice with the completion sentence, visibly', async () => {
    const p = await restoreEnded({
      state: 'completed', endedAt: '2026-10-18T12:01:00.000Z',
      spaces: [restoreSpace('general', 'done'), restoreSpace('notes', 'done'), restoreSpace('proj', 'done')],
    });
    expect(visibleNotice(p)).toContain(EN['data.restore.completed']);
    expect(visibleNotice(p)).not.toContain('Restore accepted');
    expect(visibleNotice(p)).not.toContain('being restored');
  });

  it('an abandoned restore replaces it with the abandoned sentence naming the spaces left half restored', async () => {
    const p = await restoreEnded({
      state: 'abandoned', endedAt: '2026-10-18T12:01:00.000Z',
      spaces: [restoreSpace('general', 'done'), restoreSpace('notes', 'restore_abandoned'), restoreSpace('proj', 'restore_abandoned')],
    });
    expect(visibleNotice(p)).toContain('The restore was abandoned. These spaces may be half restored: notes, proj');
    expect(visibleNotice(p)).not.toContain('Restore accepted');
  });

  it('a restore this page found already running ends in the same visible sentence', () => {
    const p = open({ words: EN, restore: restoreReport() });
    vi.advanceTimersByTime(TEN_MINUTES);
    reportPolls(p)[0]!.flush(restoreReport({
      state: 'completed', endedAt: '2026-10-18T12:01:00.000Z',
      spaces: [restoreSpace('general', 'done'), restoreSpace('notes', 'done'), restoreSpace('proj', 'done')],
    }));
    vi.advanceTimersByTime(1_000);
    p.fixture.detectChanges();
    expect(visibleNotice(p)).toContain(EN['data.restore.completed']);
  });

  it('a migrate whose report poll is refused at the connection says the instance has stopped and must be started again', () => {
    const p = open({ words: EN, migrate: migrateReport() });
    expect(cardText(p, 'migrate')).not.toMatch(/has stopped/i);
    vi.advanceTimersByTime(TEN_MINUTES);
    const polls = p.http.match(r => r.method === 'GET' && r.url === '/api/admin/data/migrate');
    expect(polls.length, 'the migrate report is polled while it stands').toBeGreaterThan(0);
    polls[0]!.error(new ProgressEvent('error'));
    p.fixture.detectChanges();
    expect(cardText(p, 'migrate')).toMatch(/instance has stopped/i);
    expect(cardText(p, 'migrate')).toMatch(/started again/i);
    expect(cardText(p, 'migrate')).toContain('connects to the new database');
  });

  it('an answer from the server (a 503) is not "the instance has stopped"', () => {
    const p = open({ words: EN, migrate: migrateReport() });
    vi.advanceTimersByTime(TEN_MINUTES);
    p.http.match(r => r.method === 'GET' && r.url === '/api/admin/data/migrate')[0]!
      .flush({ error: 'unavailable' }, { status: 503, statusText: 'Service Unavailable' });
    p.fixture.detectChanges();
    expect(cardText(p, 'migrate')).not.toMatch(/has stopped/i);
  });

  it('a restore poll that cannot connect says nothing about a stopped instance (a restore does not exit the process)', () => {
    const p = open({ words: EN, restore: restoreReport() });
    vi.advanceTimersByTime(TEN_MINUTES);
    reportPolls(p)[0]!.error(new ProgressEvent('error'));
    p.fixture.detectChanges();
    expect(cardText(p, 'restore')).not.toMatch(/has stopped/i);
  });
});

describe('a migrate that cannot finish can be abandoned from its card, as a restore can (Q-564 F5)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a running migrate with an owed space offers abandon on its own card; a confirmed abandon posts to the migrate door', async () => {
    const p = open({ migrate: owedMigrate(), migrationEnabled: true });
    expect(migrateAbandonButton(p), 'the migrate card offers no abandon').toBeTruthy();
    await clickAbandon(p);
    expect(p.confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(JSON.stringify(p.confirm.mock.calls[0]?.[0])).toContain('data.migrate.abandonConfirm');
    flushWire(p.http.expectOne(r => r.method === 'POST' && r.url === '/api/admin/data/migrate/abandon'), MIGRATE_ABANDON_ANSWERS.abandoned);
    expect(p.http.match(r => r.url === '/api/admin/data/restore/abandon'), 'a migrate abandon went to the restore door').toHaveLength(0);
    p.fixture.detectChanges();
    expect(statusText(p)).toContain('data.migrate.abandoned');
  });

  it('a cancelled confirm abandons nothing', async () => {
    const p = open({ migrate: owedMigrate() });
    p.confirm.mockResolvedValueOnce(false);
    await clickAbandon(p);
    expect(p.http.match(r => r.url === '/api/admin/data/migrate/abandon')).toHaveLength(0);
  });

  it('a migrate with no owed space (running) offers no abandon', () => {
    const p = open({ migrate: migrateReport() });
    expect(migrateAbandonButton(p)).toBeUndefined();
  });

  it('an abandon refused because the copy runs says so in our words, never the server\'s', async () => {
    const p = open({ migrate: owedMigrate() });
    await clickAbandon(p);
    flushWire(p.http.expectOne(r => r.url === '/api/admin/data/migrate/abandon'), MIGRATE_ABANDON_ANSWERS.running);
    p.fixture.detectChanges();
    expect(pageText(p)).toContain('data.refusal.migrate_act_running');
    for (const s of DATA_SERVER_SENTENCES) expect(pageText(p)).not.toContain(s);
  });

  it('the confirm says the old database stays in use and the new one must be emptied before another migrate, in every language', () => {
    for (const lang of ['en', 'de', 'pl']) {
      const d: Record<string, string> = JSON.parse(readFileSync(resolve(__dirname, `../../../../public/assets/i18n/${lang}.json`), 'utf8'));
      for (const key of ['data.migrate.abandonConfirm', 'data.migrate.abandoned', 'data.refusal.migrate_act_running', 'data.refusal.no_migrate_standing']) {
        expect(d[key]?.trim(), `${lang} has no words for ${key}`).toBeTruthy();
      }
    }
    expect(EN['data.migrate.abandonConfirm']).toMatch(/old database/i);
    expect(EN['data.migrate.abandonConfirm']).toMatch(/empt/i);
  });
});

/*
 * bundle-160 (Q-568, Q-562), with the REAL en.json: the migrate block and the maintenance pill tell how a migrate ended, or that the
 * instance stopped to switch database. The block kept "Migration accepted: N spaces are being copied" for ever, and the pill kept the last
 * copy count, so the page said two different things.
 */
describe('the migrate block and the maintenance pill say how a migrate ended (Q-568, Q-562)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const block = (p: Page, title: string) =>
    Array.from(el(p).querySelectorAll('.dz-block')).find(b => b.querySelector('h4')?.textContent?.includes(title));
  /** What a sighted operator reads in the migrate block's own live region. */
  const migrateNotice = (p: Page) =>
    Array.from(block(p, EN['data.migrate.title']!)?.querySelectorAll('[role="status"] .alert') ?? [])
      .map(e => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).join(' | ');
  const pillText = (p: Page) =>
    (block(p, EN['data.maintenance.title']!)?.querySelector('app-status-pill')?.textContent ?? '').replace(/\s+/g, ' ').trim();

  /** A migrate this page started and is following, then the next report poll answered as `answer` after the poll interval. */
  async function migrateFollowed(answer: (poll: TestRequest) => void): Promise<Page> {
    const p = open({ words: EN, migrationEnabled: true });
    await migrateAnswered(p, MIGRATE_ANSWERS.accepted);
    expect(migrateNotice(p), 'accepted is said while it runs').toContain('Migration accepted: 2 spaces are being copied');
    migratePolls(p).forEach(r => r.flush(migrateReport()));
    vi.advanceTimersByTime(TEN_MINUTES);
    answer(migratePolls(p)[0]!);
    p.http.match(r => r.method === 'GET' && r.url === '/api/admin/data/maintenance').forEach(r => r.flush(MAINTENANCE.off));
    vi.advanceTimersByTime(1_000);
    p.fixture.detectChanges();
    return p;
  }

  it('an abandon from the card replaces the accepted line in the migrate block', async () => {
    const p = open({ words: EN, migrationEnabled: true });
    await migrateAnswered(p, MIGRATE_ANSWERS.accepted);
    migratePolls(p).forEach(r => r.flush(owedMigrate()));
    p.fixture.detectChanges();
    await clickAbandon(p);
    flushWire(p.http.expectOne(r => r.method === 'POST' && r.url === '/api/admin/data/migrate/abandon'), MIGRATE_ABANDON_ANSWERS.abandoned);
    p.fixture.detectChanges();
    expect(migrateNotice(p)).toContain(EN['data.migrate.abandoned']);
    expect(migrateNotice(p)).not.toContain('Migration accepted');
    expect(migrateNotice(p)).not.toContain('being copied');
  });

  it('an abandoned migrate seen by the poll replaces the accepted line with the abandoned sentence', async () => {
    const p = await migrateFollowed(r => r.flush(migrateReport({ state: 'abandoned', endedAt: '2026-10-18T12:01:00.000Z' })));
    expect(migrateNotice(p)).toContain(EN['data.migrate.abandonedOutcome']);
    expect(migrateNotice(p)).not.toContain('Migration accepted');
    expect(migrateNotice(p)).not.toContain('being copied');
  });

  it('a completed migrate replaces the accepted line with the completion sentence', async () => {
    const p = await migrateFollowed(r => r.flush(migrateReport({ state: 'completed', done: 2, endedAt: '2026-10-18T12:01:00.000Z' })));
    expect(migrateNotice(p)).toContain(EN['data.migrate.completed']);
    expect(migrateNotice(p)).not.toContain('Migration accepted');
    expect(migrateNotice(p)).not.toContain('being copied');
  });

  it('a migrate whose poll is refused at the connection replaces the accepted line with the stopped sentence', async () => {
    const p = await migrateFollowed(r => r.error(new ProgressEvent('error')));
    expect(migrateNotice(p)).toContain(EN['data.progress.migrateStopped']);
    expect(migrateNotice(p)).not.toContain('being copied');
  });

  it('an answer from the server (a 503) leaves the accepted line', async () => {
    const p = await migrateFollowed(r => r.flush({ error: 'unavailable' }, { status: 503, statusText: 'Service Unavailable' }));
    expect(migrateNotice(p)).toContain('Migration accepted: 2 spaces are being copied');
    expect(migrateNotice(p)).not.toContain(EN['data.progress.migrateStopped']);
  });

  it('the maintenance pill stops counting copied spaces when the migrate poll is refused at the connection', () => {
    const p = open({ words: EN, maintenance: MAINTENANCE.heldByMigrate, migrate: migrateReport() });
    expect(pillText(p)).toContain('Copying to the new database: 1 of 2');
    vi.advanceTimersByTime(TEN_MINUTES);
    migratePolls(p)[0]!.error(new ProgressEvent('error'));
    p.fixture.detectChanges();
    expect(pillText(p)).not.toContain('Copying to the new database');
    expect(pillText(p)).toContain(EN['data.maintenance.migrateStopped']);
  });

  it('a 503 from the migrate report leaves the pill counting', () => {
    const p = open({ words: EN, maintenance: MAINTENANCE.heldByMigrate, migrate: migrateReport() });
    vi.advanceTimersByTime(TEN_MINUTES);
    migratePolls(p)[0]!.flush({ error: 'unavailable' }, { status: 503, statusText: 'Service Unavailable' });
    p.fixture.detectChanges();
    expect(pillText(p)).toContain('Copying to the new database: 1 of 2');
  });

  it('every language has words for the stopped pill', () => {
    for (const lang of ['en', 'de', 'pl']) {
      const d: Record<string, string> = JSON.parse(readFileSync(resolve(__dirname, `../../../../public/assets/i18n/${lang}.json`), 'utf8'));
      expect(d['data.maintenance.migrateStopped']?.trim(), `${lang} has no words for data.maintenance.migrateStopped`).toBeTruthy();
    }
  });
});
