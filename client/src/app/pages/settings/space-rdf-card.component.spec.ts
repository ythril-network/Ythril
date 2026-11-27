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

interface Opts { space?: Partial<Space>; networks?: unknown[]; rounds?: Record<string, VoteRound[]>; admin?: boolean; confirm?: boolean; update?: () => unknown }

async function setup(o: Opts = {}) {
  const updateSpace = vi.fn(o.update ?? (() => of({ space: { id: 'platform', label: 'Platform', meta: { rdf: { enabled: true, base: KIEL, baseEpoch: 0 } } } })));
  const confirm = vi.fn().mockResolvedValue(o.confirm ?? true);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceRdfCardComponent, getTranslocoModule({ translation: { en } })],
    providers: [
      provideRouter([]),
      SpaceSettingsState,
      { provide: SpacesApi, useValue: { updateSpace, getSpaceStats: () => of({ spaceId: 'platform' }) } },
      { provide: NetworksApi, useValue: { listNetworks: () => of({ networks: o.networks ?? [] }), listVotes: (id: string) => of({ rounds: o.rounds?.[id] ?? [] }) } },
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
    const { fixture, q, state } = await setup();
    (q('rdf-switch') as HTMLInputElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(state.rdfForm.enabled).toBe(true);
    expect(q('rdf-base')).not.toBeNull();
    expect(q('rdf-vocab')).not.toBeNull();
    expect(q('rdf-persistent')?.textContent).toContain('w3id.org');
    expect(q('rdf-persistent')?.textContent).toContain('/ld/platform/');
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
