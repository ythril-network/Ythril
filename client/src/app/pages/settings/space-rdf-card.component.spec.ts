/**
 * Q-942, the "RDF names" card of the space's Settings tab as layout D draws it: off (the switch, the base and vocabulary with what they
 * mean, the persistent-address advice), on (the held base, the vocabulary, "Change base…"), shared (one list: held, offered by a network
 * naming its members, a vote with each network's tally; the conflict said once; "Propose base change…" disabled while a vote runs, saying
 * why), the accept as an administrator (a confirmed PATCH carrying `rebase: true`, alone) and its refusal as a non-administrator, a door's
 * refusal worded from the dictionary and never in the server's English, and keyboard reach.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { SpacesStore } from './spaces-store.service';
import { AdminApi } from '../../core/admin-api.service';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SpaceRdfCardComponent } from './space-rdf-card.component';
import { SpaceSettingsState } from './space-settings-state.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import { AuthApi } from '../../core/auth-api.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import type { Space } from '../../core/api.types';
import type { VoteRound } from '../../core/vote-round-view';

const en = JSON.parse(readFileSync(join(process.cwd(), 'public', 'assets', 'i18n', 'en.json'), 'utf8')) as Record<string, string>;
const BASE = 'https://w3id.org/acme/platform/';
const KIEL = 'https://data.kiel-node.example/ld/platform/';
const NEW = 'https://w3id.org/acme/knowledge/';

const SHARED_NETS = [
  { id: 'acme', label: 'Acme partners', type: 'club', spaces: ['platform'], members: [{ instanceId: 'i-kiel', label: 'kiel-node', url: 'https://kiel' }, { instanceId: 'i-b', label: 'berlin-lab', url: 'https://b' }],
    rdfBaseConflicts: { platform: { held: { base: BASE, epoch: 0 }, offered: [{ networkId: 'acme', memberId: 'i-kiel', base: KIEL, vocab: `${KIEL}vocab/`, epoch: 0 }] } } },
  { id: 'berlin', label: 'Berlin lab', type: 'club', spaces: ['platform'], members: [{ instanceId: 'i-b', label: 'berlin-lab', url: 'https://b' }] },
];
const vote = (networkId: string, yes: number): VoteRound => ({
  id: `r-${networkId}`, networkId, type: 'space_rebase', subject: 'platform', openedAt: '2026-11-25T18:00:00Z', deadline: '2026-12-02T18:00:00Z',
  status: 'open', votes: Array.from({ length: yes }, (_, i) => ({ instanceId: `v${i}`, vote: 'yes' as const })), localSpaceId: 'platform',
  rebase: { base: NEW, vocab: `${NEW}vocab/`, epoch: 1 },
});

interface Opts { space?: Partial<Space>; networks?: unknown[]; networksFail?: boolean; rounds?: Record<string, VoteRound[]>; admin?: boolean; confirm?: boolean; update?: () => unknown; publicUrl?: string }

async function setup(o: Opts = {}) {
  const updateSpace = vi.fn(o.update ?? (() => of({ space: { id: 'platform', label: 'Platform', meta: { rdf: { enabled: true, base: KIEL, baseEpoch: 0 } } } })));
  const confirm = vi.fn().mockResolvedValue(o.confirm ?? true);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceRdfCardComponent, getTranslocoModule({ translation: { en } })],
    providers: [
      provideRouter([]),
      SpaceSettingsState, SpacesStore,
      { provide: SpacesApi, useValue: { updateSpace, getSpaceStats: () => of({ spaceId: 'platform' }) } },
      { provide: NetworksApi, useValue: { listNetworks: () => (o.networksFail ? throwError(() => ({ status: 403 })) : of({ networks: o.networks ?? [] })), listVotes: (id: string) => of({ rounds: o.rounds?.[id] ?? [] }) } },
      { provide: AdminApi, useValue: { getAbout: () => of({ ...(o.publicUrl ? { publicUrl: o.publicUrl } : {}) }) } },
      { provide: AuthApi, useValue: { verifyToken: () => of({ id: 't', name: 't', rights: { instanceAdmin: o.admin ?? true, createSpaces: false, floor: null, perSpace: {} } }) } },
      { provide: ConfirmDialogService, useValue: { confirm } },
    ],
  });
  const state = TestBed.inject(SpaceSettingsState);
  state.openSettings({ id: 'platform', label: 'Platform', ...o.space } as Space);
  const fixture = TestBed.createComponent(SpaceRdfCardComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return { fixture, state, el, q, updateSpace, confirm };
}

const ON = { meta: { rdf: { enabled: true, base: BASE, baseEpoch: 0 } } };

describe('RDF names card, off', () => {
  it('shows the switch with what it does, the pill Off, and no base field until switched on', async () => {
    const { q, el } = await setup();
    expect(q('rdf-pill')?.textContent).toContain(en['rdf.card.pill.off']);
    expect(el.textContent).toContain(en['rdf.card.switch']);
    expect(el.textContent).toContain(en['rdf.card.switchHint']);
    expect(q('rdf-base')).toBeNull();
  });

  it('switched on, it shows the base and the vocabulary with what each means and the advice to use a persistent address', async () => {
    const { fixture, q, state } = await setup({ publicUrl: 'https://ld.acme.example/' });
    (q('rdf-switch') as HTMLInputElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(state.rdfForm.enabled).toBe(true);
    expect(q('rdf-base')).not.toBeNull();
    expect(q('rdf-vocab')).not.toBeNull();
    expect(q('rdf-persistent')?.textContent).toContain('w3id.org');
    expect(q('rdf-persistent')?.textContent).toContain('https://ld.acme.example/ld/platform/');
    // The save sends the switch and the typed base (the dialog's own Save).
    state.rdfForm.base = BASE;
    expect(state.buildMeta().rdf).toEqual({ enabled: true, base: BASE });
  });
});

describe('RDF names card, on (a space in no network)', () => {
  it('shows the held base with what it means, the derived vocabulary, the pill On and "Change base…" with its consequence', async () => {
    const { q, el } = await setup({ space: ON });
    expect(q('rdf-pill')?.textContent).toContain(en['rdf.card.pill.on']);
    expect(q('rdf-row-held')?.textContent).toContain(BASE);
    expect(q('rdf-row-held')?.textContent).toContain(en['rdf.card.row.heldWhat']);
    expect(q('rdf-vocab-derived')?.textContent).toContain(`${BASE}vocab/`);
    expect(q('rdf-change')?.textContent).toContain(en['rdf.card.change']);
    expect((q('rdf-change') as HTMLButtonElement).disabled).toBe(false);
    expect(q('rdf-change-reason')?.textContent).toContain(en['rdf.card.changeWhat']);
    expect(el.textContent).toContain(en['rdf.card.switchOffKeeps']);
    expect(q('rdf-base')).toBeNull();
  });

  it('a base change is confirmed and sent alone with rebase: true', async () => {
    const { fixture, q, updateSpace, confirm } = await setup({ space: ON });
    (q('rdf-change') as HTMLButtonElement).click();
    fixture.detectChanges();
    const input = q('rdf-new-base') as HTMLInputElement;
    input.value = NEW;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (q('rdf-change-go') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(confirm).toHaveBeenCalled();
    expect(updateSpace).toHaveBeenCalledWith('platform', { meta: { rdf: { enabled: true, base: NEW, rebase: true } } });
  });
});

describe('RDF names card, shared with a vote and an offer', () => {
  const shared = { space: ON, networks: SHARED_NETS, rounds: { acme: [vote('acme', 2)], berlin: [vote('berlin', 1)] } };

  it('draws one list, held first, the offered row marked with its network and member, the vote row with each network\'s tally', async () => {
    const { q, el } = await setup(shared);
    expect(q('rdf-pill')?.textContent).toContain(en['rdf.card.pill.conflict']);
    const rows = [...el.querySelectorAll('[role="listitem"]')].map(r => r.getAttribute('data-testid'));
    expect(rows).toEqual(['rdf-row-held', 'rdf-row-offered', 'rdf-row-vote']);
    expect(q('rdf-row-offered')?.className).toContain('needs');
    expect(q('rdf-row-offered')?.textContent).toContain(KIEL);
    expect(q('rdf-row-offered')?.textContent).toContain('kiel-node in Acme partners');
    expect(q('rdf-row-vote')?.textContent).toContain(NEW);
    expect(q('rdf-row-vote')?.textContent).toContain('2 of 3 yes');
    expect(q('rdf-row-vote')?.textContent).toContain('1 of 2 yes');
    expect(q('rdf-vote-link')?.getAttribute('href')).toBe('/settings/networks');
  });

  it('says what a conflict blocks once, and disables "Propose base change…" while a vote runs, saying why', async () => {
    const { q, el } = await setup(shared);
    expect(el.textContent!.split(en['rdf.card.conflictBlocks']).length - 1).toBe(1);
    const propose = q('rdf-change') as HTMLButtonElement;
    expect(propose.textContent).toContain(en['rdf.card.propose']);
    expect(propose.disabled).toBe(true);
    expect(propose.getAttribute('aria-describedby')).toBe('rdf-change-r');
    expect(el.querySelector('#rdf-change-r')?.textContent).toContain(en['rdf.card.oneAtATime']);
  });

  it('an administrator accepts the offered base: confirmed, then sent alone with its vocabulary and rebase: true', async () => {
    const { fixture, q, updateSpace, confirm } = await setup(shared);
    const accept = q('rdf-accept') as HTMLButtonElement;
    expect(accept.disabled).toBe(false);
    expect(accept.getAttribute('aria-label')).toContain('kiel-node');
    accept.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(confirm).toHaveBeenCalled();
    expect(updateSpace).toHaveBeenCalledWith('platform', { meta: { rdf: { enabled: true, base: KIEL, vocab: `${KIEL}vocab/`, rebase: true } } });
    expect(q('rdf-notice')?.textContent).toContain(en['rdf.card.accepted']);
  });

  it('a non-administrator cannot accept: the button is disabled and points at why', async () => {
    const { q } = await setup({ ...shared, admin: false });
    const accept = q('rdf-accept') as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(accept.getAttribute('aria-describedby')).toBe('rdf-admin-r');
    expect(q('rdf-admin-only')?.textContent).toContain(en['rdf.card.adminOnly']);
  });

  it('a refused accept is worded from the dictionary, never in the server\'s English', async () => {
    const english = 'A space_rebase round for this space is held (base https://x/, deadline ...)';
    const { fixture, q } = await setup({ ...shared, update: () => throwError(() => ({ status: 409, error: { error: english, code: 'rdf_rebase_pending' } })) });
    (q('rdf-accept') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(q('rdf-refusal')?.textContent).toContain(en['rdf.refusal.rdf_rebase_pending']);
    expect(q('rdf-refusal')?.textContent).not.toContain(english);
  });

  it('an uncoded 403 is worded too', async () => {
    const { fixture, q } = await setup({ ...shared, update: () => throwError(() => ({ status: 403, error: { error: 'Forbidden: schema admin needed' } })) });
    (q('rdf-accept') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(q('rdf-refusal')?.textContent).toContain(en['rdf.refusal.forbidden']);
  });
});

describe('RDF names card, when the networks cannot be read (L2.1, L3.1)', () => {
  const VOTE_ANSWER = { status: 'vote_pending', rounds: [{ networkId: 'acme', networkLabel: 'Acme partners', roundId: 'r1' }], message: 'pending' };

  async function change(o: Opts) {
    const r = await setup({ space: ON, ...o });
    (r.q('rdf-change') as HTMLButtonElement).click();
    r.fixture.detectChanges();
    const input = r.q('rdf-new-base') as HTMLInputElement;
    input.value = NEW;
    input.dispatchEvent(new Event('input'));
    r.fixture.detectChanges();
    (r.q('rdf-change-go') as HTMLButtonElement).click();
    await r.fixture.whenStable();
    r.fixture.detectChanges();
    return r;
  }

  it('says the networks could not be read, instead of drawing a space in no network', async () => {
    const { q, el } = await setup({ space: ON, networksFail: true });
    expect(q('rdf-networks-unread')?.textContent).toContain(en['rdf.card.networksUnread']);
    expect(el.textContent).toContain(en['rdf.card.changeWhatUnknown']);
  });

  it('draws no such line when the networks were read', async () => {
    const { q } = await setup({ space: ON });
    expect(q('rdf-networks-unread')).toBeNull();
  });

  it('words the confirm of a base change neutrally: it does not say "at once" for a change the server may turn into a vote', async () => {
    const { confirm } = await change({ networksFail: true, update: () => of(VOTE_ANSWER) });
    const asked = confirm.mock.calls[0]![0] as { message: string };
    expect(asked.message).toBe(en['rdf.card.changeConfirmUnknown'].replace('{{base}}', NEW));
    expect(asked.message).not.toBe(en['rdf.card.changeConfirm'].replace('{{base}}', NEW));
  });

  it('takes the notice from the server\'s answer: a 202 vote_pending says the vote is open, whatever the card believed', async () => {
    const { q } = await change({ networksFail: true, update: () => of(VOTE_ANSWER) });
    expect(q('rdf-notice')?.textContent).toContain(en['rdf.card.voteOpened']);
    expect(q('rdf-notice')?.textContent).not.toContain(en['rdf.card.changed']);
  });

  it('a change the server applied says so, even on a space the card drew as shared', async () => {
    const { q } = await change({ networks: [{ ...SHARED_NETS[1], rdfBaseConflicts: undefined }], update: () => of({ space: { id: 'platform', label: 'Platform', meta: { rdf: { enabled: true, base: NEW, baseEpoch: 1 } } } }) });
    expect(q('rdf-notice')?.textContent).toContain(en['rdf.card.changed']);
  });
});

describe('RDF names card, the default base the server will store (D2)', () => {
  async function switchedOn(o: Opts) {
    const r = await setup(o);
    (r.q('rdf-switch') as HTMLInputElement).click();
    r.fixture.detectChanges();
    await r.fixture.whenStable();
    r.fixture.detectChanges();
    return r;
  }

  it('is the instance\'s public address, /ld/ and the space id, never the address of the browser tab', async () => {
    const { q } = await switchedOn({ publicUrl: 'https://ld.acme.example' });
    expect(q('rdf-persistent')?.textContent).toContain('https://ld.acme.example/ld/platform/');
    expect((q('rdf-base') as HTMLInputElement).placeholder).toBe('https://ld.acme.example/ld/platform/');
    expect(q('rdf-persistent')?.textContent).not.toContain(location.origin);
  });

  it('names no address when the instance says none: the server then refuses an empty base, and the card does not promise one', async () => {
    const { q } = await switchedOn({});
    expect(q('rdf-persistent')?.textContent).not.toContain(location.origin);
    expect(q('rdf-persistent')?.textContent).toContain(en['rdf.card.persistentNoDefault']);
    expect((q('rdf-base') as HTMLInputElement).placeholder).toBe('');
  });
});

describe('RDF names card, a link to it (L4.1, D1)', () => {
  it('takes focus once: a card built again after the signal was answered does not take it', async () => {
    const first = await setup({ space: ON });
    document.body.appendChild(first.el);
    first.state.rdfFocus.update(n => n + 1);
    first.fixture.detectChanges();
    await new Promise(r => setTimeout(r, 0));
    expect(document.activeElement?.id).toBe('rdf-card-focus');
    expect(first.state.rdfFocus()).toBe(0);
    (document.activeElement as HTMLElement).blur();
    first.fixture.destroy();
    first.el.remove();
    // The Settings tab is built again each time it is shown (`@if` in the dialog): the same state, a new card.
    const state = first.state;
    const fixture = TestBed.createComponent(SpaceRdfCardComponent);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise(r => setTimeout(r, 0));
    expect(state.rdfFocus()).toBe(0);
    expect(document.activeElement?.id).not.toBe('rdf-card-focus');
    fixture.nativeElement.remove();
  });

  it('a signal raised before the card exists still brings it into focus when it is built', async () => {
    TestBed.resetTestingModule();
    const r0 = await setup({ space: ON });
    r0.fixture.destroy();
    r0.state.showRdfNames();
    expect(r0.state.settingsTab()).toBe('settings');
    const fixture = TestBed.createComponent(SpaceRdfCardComponent);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    await new Promise(r => setTimeout(r, 0));
    expect(document.activeElement?.id).toBe('rdf-card-focus');
    fixture.nativeElement.remove();
  });

  it('scrolls the card into view inside the container that scrolls (the dialog\'s body), not only the page', async () => {
    const { fixture, el, state } = await setup({ space: ON });
    const box = document.createElement('div');
    box.style.overflowY = 'auto';
    box.appendChild(el);
    document.body.appendChild(box);
    const scrollTo = vi.fn();
    (box as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
    box.getBoundingClientRect = () => ({ top: 100, bottom: 1248, height: 1148, left: 0, right: 800, width: 800, x: 0, y: 100, toJSON: () => ({}) });
    el.getBoundingClientRect = () => ({ top: 1272, bottom: 1900, height: 628, left: 0, right: 800, width: 800, x: 0, y: 1272, toJSON: () => ({}) });
    state.rdfFocus.update(n => n + 1);
    fixture.detectChanges();
    await new Promise(r => setTimeout(r, 0));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    const top = (scrollTo.mock.calls[0]![0] as { top: number }).top;
    expect(top).toBeGreaterThan(1000);
    expect(top).toBeLessThanOrEqual(1172);
    box.remove();
  });
});

describe('RDF names card, keyboard', () => {
  it('every act is a native control in the tab order, and a link to the card focuses it', async () => {
    const { fixture, q, state, el } = await setup({ space: ON, networks: SHARED_NETS, rounds: {} });
    for (const id of ['rdf-switch', 'rdf-accept', 'rdf-change']) {
      const c = q(id)!;
      expect(['INPUT', 'BUTTON']).toContain(c.tagName);
      expect(c.getAttribute('tabindex')).not.toBe('-1');
    }
    document.body.appendChild(el);
    state.rdfFocus.update(n => n + 1);
    fixture.detectChanges();
    await new Promise(r => setTimeout(r, 0));
    expect(document.activeElement?.id).toBe('rdf-card-focus');
    el.remove();
  });
});
