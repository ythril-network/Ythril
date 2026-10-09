/**
 * The vote slice of the Networks page — what a vote row says, what happens after a cast, and "Recent decisions".
 *
 * ## What this holds, and why it runs through the REAL `NetworksApi`
 *
 * `networks.component.spec.ts` mocks the API object, which is right for pinning method calls and wrong here: the
 * three things this file protects all happen BETWEEN the wire and the screen. The server's round gains fields the
 * client type never declared (`voteRoundFromServer` drops what it does not copy), a cast answers `{ concluded,
 * round }` that `castVote` once typed as `void`, and a 409 carries a deadline the page has to format in the
 * viewer's own date preference. A mocked API would let every one of those pass while the page showed nothing.
 * So the spec answers HTTP requests by URL (`HttpTestingController`), which also keeps it independent of what the
 * API method for the outcome log is called: the door is `GET /api/networks/:id/vote-outcomes`, whatever calls it.
 *
 * ## Where the strings come from
 *
 * The translations are the REAL `en.json` with the labels this slice introduces overridden by marker strings
 * (`OUTCOME-PASSED`), so a spec can say "the toast names THIS outcome and not the other two" without depending on
 * the English wording, and an aria-label or sentence the implementation forgot to add shows up as a raw key.
 *
 * Markup is addressed by what already exists on the page (`.vote-row`, `button.btn-primary` / `.btn-danger`, the
 * `app-network-decisions` selector the plan names, `app-error-state`, `app-status-pill`) and never by a class the
 * implementation has yet to invent.
 */
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { By } from '@angular/platform-browser';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SpacesApi } from '../../core/spaces-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { DateFormatService } from '../../core/date-format.service';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { CLIENT_ROOT } from '../../testing/tracked-sources';
import { elementHolding, truncationAround, declaredNearest } from '../../testing/declared-style';
import { NetworksComponent } from './networks.component';

const EN: Record<string, string> = JSON.parse(
  readFileSync(resolve(CLIENT_ROOT, 'public/assets/i18n/en.json'), 'utf8'),
);

/** The wording a spec may rely on: markers, so no assertion depends on an English sentence. */
const LABEL = {
  passed: 'OUTCOME-PASSED', vetoed: 'OUTCOME-VETOED', expired: 'OUTCOME-EXPIRED', ended: 'OUTCOME-ENDED',
} as const;
const TRANSLATION: Record<string, string> = {
  ...EN,
  'networks.decisions.outcome.passed': LABEL.passed,
  'networks.decisions.outcome.vetoed': LABEL.vetoed,
  'networks.decisions.outcome.expired': LABEL.expired,
  'networks.decisions.outcome.ended': LABEL.ended,
  'networks.roundType.space_addition': 'ROUNDTYPE-ADD-SPACE',
  'networks.roundType.join': 'ROUNDTYPE-JOIN',
};

const NET = { id: 'n1', label: 'Braintree', type: 'closed', members: [], spaces: [] };

/** A round as `GET /api/networks/:id/votes` sends it. `subject` on the page becomes "notes (member-b)". */
const SERVER_ROUND = {
  roundId: 'r1', type: 'space_addition', subjectInstanceId: 'i-2', subjectLabel: 'member-b', spaceId: 'notes',
  openedAt: '2026-10-08T10:00:00.000Z', deadline: '2026-10-09T10:00:00.000Z',
  votes: [{ instanceId: 'i-1', vote: 'yes' }],
  summary: '<b>Adds</b> the space notes\nto the network',
};
const SUBJECT = 'notes (member-b)';

const OUTCOMES_URL = '/api/networks/n1/vote-outcomes';

describe('the vote slice of the Networks page', () => {
  let http: HttpTestingController;
  let confirm: ReturnType<typeof vi.fn>;
  let toasts: ToastService;
  let dates: DateFormatService;

  beforeEach(() => {
    confirm = vi.fn(() => Promise.resolve(true));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [NetworksComponent, getTranslocoModule({ translation: { en: TRANSLATION } })],
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
        { provide: AdminApi, useValue: { getAbout: () => of({ publicUrl: '' }) } },
        { provide: ConfirmDialogService, useValue: { confirm } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    toasts = TestBed.inject(ToastService);
    dates = TestBed.inject(DateFormatService);
  });

  /** Requests for the outcome log that arrived since the last call. */
  const outcomeRequests = (): TestRequest[] => {
    return http.match(r => r.method === 'GET' && r.url.startsWith(OUTCOMES_URL));
  };
  const voteRequests = (): TestRequest[] => {
    return http.match(r => r.method === 'GET' && r.url === '/api/networks/n1/votes');
  };

  function boot(rounds: unknown[] = [SERVER_ROUND], opts: { expand?: boolean } = {}): ComponentFixture<NetworksComponent> {
    const fixture = TestBed.createComponent(NetworksComponent);
    fixture.detectChanges();
    http.expectOne('/api/networks').flush({ networks: [NET] });
    http.expectOne('/api/networks/n1/votes').flush({ rounds });
    if (opts.expand !== false) fixture.componentInstance.toggleNetwork('n1');
    fixture.detectChanges();
    return fixture;
  }

  const rowOf = (f: ComponentFixture<NetworksComponent>): HTMLElement =>
    f.nativeElement.querySelector('.vote-row') as HTMLElement;
  const yesOf = (row: HTMLElement) => row.querySelector('button.btn-primary') as HTMLButtonElement;
  const vetoOf = (row: HTMLElement) => row.querySelector('button.btn-danger') as HTMLButtonElement;
  const toastText = (): string => toasts.toasts().map(t => t.message).join(' | ');

  describe('the vote row', () => {
    it('says when the round opened and when it closes, both as machine-readable times in ONE style', () => {
      const row = rowOf(boot());
      const opened = row.querySelector(`time[datetime="${SERVER_ROUND.openedAt}"]`);
      const deadline = row.querySelector(`time[datetime="${SERVER_ROUND.deadline}"]`);
      expect(opened, 'no <time> for openedAt in the row').not.toBeNull();
      expect(deadline, 'no <time> for the deadline in the row').not.toBeNull();
      // One style per surface: both inside the same kind of host element (both relative, or both instants).
      expect(opened!.parentElement!.tagName).toBe(deadline!.parentElement!.tagName);
      expect(opened!.parentElement!.tagName.startsWith('APP-'), 'a time written inline, outside the shared formatters')
        .toBe(true);
    });

    it('names the type by its translated label and never prints the wire value', () => {
      const row = rowOf(boot());
      expect(row.textContent).toContain('ROUNDTYPE-ADD-SPACE');
      expect(row.textContent, 'the raw round type leaked into the row').not.toContain('space_addition');
      expect(row.textContent).toContain(SUBJECT);
    });

    it('shows the summary as plain text — markup in it is shown, never parsed — and does not cut it off', () => {
      const row = rowOf(boot());
      expect(row.textContent).toContain('<b>Adds</b> the space notes');
      expect(row.querySelector('b'), 'a peer-authored summary was parsed as HTML').toBeNull();

      const holder = elementHolding(row, '<b>Adds</b>');
      expect(holder, 'the summary is not in the row').not.toBeNull();
      expect(truncationAround(holder!, row), 'the summary is truncated by a box around it').toEqual([]);
      expect(declaredNearest(holder!, 'white-space', row), 'line breaks in the summary are not kept').toBe('pre-line');
      expect(declaredNearest(holder!, 'overflow-wrap', row) ?? declaredNearest(holder!, 'word-break', row),
        'a long unbroken word in the summary cannot wrap').toMatch(/anywhere|break-word|break-all/);
    });

    it('gives Yes and Veto an accessible name that says WHICH round, and reports busy while the cast is in flight', () => {
      const f = boot();
      const row = rowOf(f);
      const yes = yesOf(row);
      const veto = vetoOf(row);
      expect(yes.getAttribute('aria-label') ?? '', 'Yes has no accessible name naming the round').toContain(SUBJECT);
      expect(veto.getAttribute('aria-label') ?? '', 'Veto has no accessible name naming the round').toContain(SUBJECT);
      expect(yes.getAttribute('aria-label')).not.toBe(veto.getAttribute('aria-label'));
      expect(yes.getAttribute('aria-busy')).not.toBe('true');

      yes.click();
      f.detectChanges();
      expect(yesOf(rowOf(f)).getAttribute('aria-busy'), 'no aria-busy while the request is open').toBe('true');

      http.expectOne(r => r.method === 'POST' && r.url === '/api/networks/n1/votes/r1')
        .flush({ concluded: false, round: { ...SERVER_ROUND, concluded: false } });
      voteRequests()[0]?.flush({ rounds: [SERVER_ROUND] });
      f.detectChanges();
      expect(yesOf(rowOf(f)).getAttribute('aria-busy')).not.toBe('true');
    });

    it('asks the veto confirmation about THIS round, not about "this round" in general', async () => {
      const f = boot();
      vetoOf(rowOf(f)).click();
      await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
      expect(JSON.stringify(confirm.mock.calls[0][0]), 'the veto confirmation does not name the round').toContain(SUBJECT);
    });
  });

  describe('after a cast', () => {
    function castYes(f: ComponentFixture<NetworksComponent>): void {
      yesOf(rowOf(f)).click();
      f.detectChanges();
    }
    const post = () => http.expectOne(r => r.method === 'POST' && r.url === '/api/networks/n1/votes/r1');
    /**
     * What the page asked for after the cast, answered as the server would, then drawn. The answers come BEFORE the
     * redraw on purpose: this app is zoneless, so a view is refreshed when something it reads is marked dirty — the
     * reloaded vote list is what does that on the real page — and drawing first would test a page the user never sees.
     */
    function settle(f: ComponentFixture<NetworksComponent>, rounds: unknown[] = [SERVER_ROUND]): { votes: number; decisions: number } {
      const votes = voteRequests();
      votes.forEach(r => r.flush({ rounds }));
      const decisions = outcomeRequests();
      decisions.forEach(r => r.flush({ outcomes: [], total: 0 }));
      f.detectChanges();
      return { votes: votes.length, decisions: decisions.length };
    }

    for (const outcome of ['passed', 'vetoed', 'expired'] as const) {
      it(`a cast that concluded the round (${outcome}) says how it ended, and reloads the votes and the decisions`, () => {
        const f = boot();
        outcomeRequests().forEach(r => r.flush({ outcomes: [], total: 0 }));
        castYes(f);
        post().flush({ concluded: true, round: { ...SERVER_ROUND, concluded: true, passed: outcome === 'passed', outcome } });

        const said = toastText();
        expect(said, `no toast names the outcome "${outcome}"`).toContain(LABEL[outcome]);
        for (const other of (['passed', 'vetoed', 'expired'] as const).filter(o => o !== outcome)) {
          expect(said, `the toast also names "${other}"`).not.toContain(LABEL[other]);
        }
        expect(toasts.toasts().some(t => t.kind === 'error'), 'a concluded cast was reported as an error').toBe(false);

        const asked = settle(f, []);
        expect(asked.votes, 'the votes were not reloaded after the round concluded').toBeGreaterThan(0);
        expect(asked.decisions, 'the decisions were not reloaded after the round concluded').toBeGreaterThan(0);
      });
    }

    it('a cast that did not conclude the round says the vote is recorded, and names no outcome', () => {
      const f = boot();
      castYes(f);
      post().flush({ concluded: false, round: { ...SERVER_ROUND, concluded: false } });
      expect(toasts.toasts().length, 'a recorded vote said nothing').toBeGreaterThan(0);
      expect(toasts.toasts().some(t => t.kind === 'error')).toBe(false);
      for (const label of Object.values(LABEL)) expect(toastText()).not.toContain(label);
      settle(f);
    });

    it("a 409 round_expired is said with the deadline in the VIEWER's date format, then the lists reload", () => {
      dates.setPreference({ style: 'dmy24', zone: 'utc' });
      const f = boot();
      outcomeRequests().forEach(r => r.flush({ outcomes: [], total: 0 }));
      castYes(f);
      post().flush(
        { error: 'Voting on this round closed at 2026-10-09T10:00:00.000Z', code: 'round_expired', deadline: '2026-10-09T10:00:00.000Z' },
        { status: 409, statusText: 'Conflict' },
      );

      const err = toasts.toasts().filter(t => t.kind === 'error').map(t => t.message).join(' | ');
      expect(err, 'no error toast for the refused cast').not.toBe('');
      expect(err, "the deadline is not shown in the viewer's date preference").toContain('09.10.2026');
      expect(err, "the server's ISO text was shown as it came").not.toContain('2026-10-09');

      const asked = settle(f, []);
      expect(asked.votes, 'the votes were not reloaded after the refusal').toBeGreaterThan(0);
      expect(asked.decisions, 'the decisions were not reloaded after the refusal').toBeGreaterThan(0);
    });

    it('when the reload removes the row, focus lands inside the network card and not on the page body', async () => {
      const f = boot();
      castYes(f);
      post().flush({ concluded: true, round: { ...SERVER_ROUND, concluded: true, passed: true, outcome: 'passed' } });
      voteRequests().forEach(r => r.flush({ rounds: [] }));
      outcomeRequests().forEach(r => r.flush({ outcomes: [], total: 0 }));
      f.detectChanges();
      await vi.waitFor(() => {
        f.detectChanges();
        expect(f.nativeElement.querySelector('.vote-row'), 'the row is still there').toBeNull();
        const active = document.activeElement;
        expect(active, 'focus fell back to the body').not.toBe(document.body);
        expect(f.nativeElement.contains(active), 'focus left the page section').toBe(true);
      });
    });
  });

  describe('Recent decisions', () => {
    const host = (f: ComponentFixture<NetworksComponent>): HTMLElement | null =>
      f.nativeElement.querySelector('app-network-decisions');

    /** The one request the card's first look makes — said plainly when the page never made it. */
    const firstOutcomeRequest = (): TestRequest => {
      const reqs = outcomeRequests();
      expect(reqs.length, 'the decisions were never requested').toBe(1);
      return reqs[0];
    };

    it('is not asked for until the card is opened, then once', () => {
      const f = boot([SERVER_ROUND], { expand: false });
      expect(outcomeRequests().length, 'the log was fetched for a collapsed card').toBe(0);
      f.componentInstance.toggleNetwork('n1');
      f.detectChanges();
      const reqs = outcomeRequests();
      expect(reqs.length).toBe(1);
      expect(reqs[0].request.method).toBe('GET');
    });

    it('is on the card even when no round is open — it is not inside the open-votes block', () => {
      const f = boot([]);
      expect(f.nativeElement.querySelector('.vote-row')).toBeNull();
      expect(host(f), 'Recent decisions vanished with the last open vote').not.toBeNull();
    });

    it('tells loading, empty and failed apart, and a failure offers a retry', () => {
      const f = boot([]);
      const first = firstOutcomeRequest();
      expect(host(f), 'no Recent decisions on the card').not.toBeNull();
      expect(host(f)!.querySelector('app-error-state')).toBeNull();
      const loadingText = (host(f)!.textContent ?? '').trim();
      expect(loadingText, 'nothing says the decisions are loading').not.toBe('');

      first.flush({ outcomes: [], total: 0 });
      f.detectChanges();
      const emptyText = (host(f)!.textContent ?? '').trim();
      expect(host(f)!.querySelector('app-error-state'), 'an empty log was drawn as a failure').toBeNull();
      expect(emptyText, 'empty reads as nothing at all').not.toBe('');
      expect(emptyText, 'empty reads the same as loading').not.toBe(loadingText);
    });

    // A failure is its own state — never the friendly empty one (a failed read must not say "no decisions").
    it('a failed read shows the error state in place of the empty one, and Retry asks again', () => {
      const f = boot([]);
      firstOutcomeRequest().flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });
      f.detectChanges();
      const err = host(f)!.querySelector('app-error-state');
      expect(err, 'a failed read did not show app-error-state').not.toBeNull();

      (err!.querySelector('button') as HTMLButtonElement).click();
      f.detectChanges();
      const again = outcomeRequests();
      expect(again.length, 'Retry did not ask again').toBe(1);
      again[0].flush({ outcomes: [], total: 0 });
      f.detectChanges();
      expect(host(f)!.querySelector('app-error-state')).toBeNull();
    });

    it('lists the newest decision first, labels each by text AND a status colour, and ends a legacy entry last', () => {
      const f = boot([]);
      const entry = (roundId: string, subjectLabel: string, outcome: string, concludedAt?: string, summary?: string) => ({
        roundId, type: 'space_addition', space: 'notes', subjectLabel, openedAt: '2026-10-01T00:00:00.000Z',
        deadline: '2026-10-02T00:00:00.000Z', outcome, yes: 2, veto: 0, eligible: 3,
        ...(concludedAt ? { concludedAt } : {}), ...(summary ? { summary } : {}),
      });
      // Deliberately NOT in display order: the page, not the wire, decides what "newest first" means.
      firstOutcomeRequest().flush({
        outcomes: [
          entry('c', 'subj-C', 'expired', '2026-10-02T00:00:00.000Z'),
          entry('d', 'subj-D', 'ended'),
          entry('a', 'subj-A', 'passed', '2026-10-05T00:00:00.000Z', '<i>x</i> became y'),
          entry('b', 'subj-B', 'vetoed', '2026-10-03T00:00:00.000Z'),
        ],
        total: 4,
      });
      f.detectChanges();

      const el = host(f)!;
      const text = el.textContent ?? '';
      const at = (s: string) => text.indexOf(s);
      expect([at('subj-A'), at('subj-B'), at('subj-C'), at('subj-D')].every(i => i >= 0), 'an entry is not shown').toBe(true);
      expect(at('subj-A')).toBeLessThan(at('subj-B'));
      expect(at('subj-B')).toBeLessThan(at('subj-C'));
      expect(at('subj-C'), 'a legacy entry with no concludedAt sorted among the dated ones').toBeLessThan(at('subj-D'));

      // The outcome is TEXT, in the same order…
      expect([LABEL.passed, LABEL.vetoed, LABEL.expired, LABEL.ended].map(at)).toEqual(
        [LABEL.passed, LABEL.vetoed, LABEL.expired, LABEL.ended].map(at).slice().sort((a, b) => a - b));
      for (const label of Object.values(LABEL)) expect(text, `${label} is not shown as text`).toContain(label);
      // …and carries a status variant on top of it: passed ok, vetoed error, expired and ended inert.
      const variants = f.debugElement.query(By.css('app-network-decisions'))
        .queryAll(By.directive(StatusPillComponent)).map(d => (d.componentInstance as StatusPillComponent).variant());
      expect(variants).toEqual(['ok', 'error', 'off', 'off']);

      expect(text).toContain('<i>x</i> became y');
      expect(el.querySelector('i'), 'a stored summary was parsed as HTML').toBeNull();
    });

    it('is reloaded after a cast that concluded a round', () => {
      const f = boot();
      outcomeRequests().forEach(r => r.flush({ outcomes: [], total: 0 }));
      yesOf(rowOf(f)).click();
      f.detectChanges();
      http.expectOne(r => r.method === 'POST' && r.url === '/api/networks/n1/votes/r1')
        .flush({ concluded: true, round: { ...SERVER_ROUND, concluded: true, passed: true, outcome: 'passed' } });
      voteRequests().forEach(r => r.flush({ rounds: [] })); // the reload marks the view dirty, as on the page
      f.detectChanges();
      expect(outcomeRequests().length, 'the decisions were not asked for again after the round concluded')
        .toBeGreaterThan(0);
    });
  });
});
