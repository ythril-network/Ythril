/**
 * NetworksComponent — CHARACTERIZATION tests.
 *
 * The networks page is the largest settings component (~1261 lines) and shipped with ZERO coverage.
 * Before it can be safely refactored (splitting the Create/Join/Enable modals into child components,
 * folding onto the design system), these tests PIN its current observable behavior — the create/join
 * validation rules, the confirm-guarded destructive actions, and the API-call shapes — so a later
 * refactor that changes behavior fails here instead of shipping silently. They assert what the code
 * does today, not what it "should" do; a bug faithfully reproduced is still pinned.
 *
 * Style: drive the public methods directly and assert state via the public accessors/signals — the
 * component is created but never `detectChanges()`d, so the huge template is never rendered (keeps the
 * characterization about behavior, not markup, and avoids coupling to a layout that is about to change).
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, throwError, Subject } from 'rxjs';
import type { Network, VoteRound } from '../../core/api.types';
import { NetworksApi } from '../../core/networks-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { NetworksComponent } from './networks.component';

const net = (over: Partial<Network> = {}): Network =>
  ({ id: 'n1', label: 'Braintree', type: 'closed', members: [], ...over } as Network);

const round = (over: Partial<VoteRound> = {}): VoteRound =>
  ({ id: 'r1', status: 'open', ...over } as VoteRound);

/** All NetworksApi methods the component touches, each a vi.fn() with a benign default. Override per test. */
function makeNetworksApi() {
  return {
    listNetworks: vi.fn(() => of({ networks: [] as Network[] })),
    listVotes: vi.fn(() => of({ rounds: [] as VoteRound[] })),
    createNetwork: vi.fn((body: unknown) => of(net({ id: 'new', label: (body as { label: string }).label }))),
    leaveNetwork: vi.fn(() => of({})),
    generateInvite: vi.fn(() => of({ handshakeId: 'h', inviteUrl: 'u', networkId: 'n1' })),
    updateNetworkSchedule: vi.fn(() => of({})),
    joinRemote: vi.fn(() => of({ status: 'joined', networkLabel: 'Braintree' })),
    removeMember: vi.fn(() => of({})),
    triggerSync: vi.fn(() => of({ ok: true })),
    getSyncHistory: vi.fn(() => of({ history: [] })),
    castVote: vi.fn(() => of({})),
    bootstrapLocalAgent: vi.fn(() => of({})),
    getLocalAgentStatus: vi.fn(() => of({ canExecute: false })),
    executeEnableNetworksViaLocalAgent: vi.fn(() => of({ message: 'done', publicUrl: 'https://x.example' })),
  } as any;
}

describe('NetworksComponent (characterization)', () => {
  let api: ReturnType<typeof makeNetworksApi>;
  let confirmResult: boolean;
  let confirm: ReturnType<typeof vi.fn>;
  let toastError: ReturnType<typeof vi.fn>;

  function make() {
    api = makeNetworksApi();
    confirmResult = true;
    confirm = vi.fn(() => Promise.resolve(confirmResult));
    toastError = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [NetworksComponent, getTranslocoModule()],
      providers: [
        { provide: NetworksApi, useValue: api },
        { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
        { provide: AdminApi, useValue: { getAbout: () => of({ publicUrl: '' }) } },
        { provide: ToastService, useValue: { error: toastError, success: vi.fn() } },
        { provide: ConfirmDialogService, useValue: { confirm } },
      ],
    });
    // Created but NOT detectChanges()'d — ngOnInit is driven explicitly per test.
    return TestBed.createComponent(NetworksComponent).componentInstance;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('load() populates networks and fetches only OPEN vote rounds per network', () => {
    const c = make();
    api.listNetworks.mockReturnValue(of({ networks: [net({ id: 'n1' }), net({ id: 'n2' })] }));
    api.listVotes.mockReturnValue(of({ rounds: [round({ id: 'open1', status: 'open' }), round({ id: 'passed1', status: 'passed' })] }));
    c.load();
    expect(c.networks().map(n => n.id)).toEqual(['n1', 'n2']);
    expect(api.listVotes).toHaveBeenCalledTimes(2); // one per network
        // `'passed'`, not `'closed'`. A round's status is `open | passed | failed` — there is no `closed`, so the
    // fixture was proving the filter rejects a value the API cannot send. It keeps `=== 'open'` honest.
    expect(c.openVotes('n1').map(r => r.id)).toEqual(['open1']);
  });

  // Create-dialog behavior (blank-label guard, space payload, CSV fallback, error) moved to
  // network-create-dialog.component.spec.ts when the Create dialog became its own child component.
  // The parent only appends the emitted network and closes — pinned by the onNetworkCreated test below.

  it('onNetworkCreated() appends the created network and closes the dialog', () => {
    const c = make();
    c.networks.set([net({ id: 'n1' })]);
    c.showCreateDialog.set(true);
    c.onNetworkCreated(net({ id: 'new', label: 'Fresh' }));
    expect(c.networks().map(n => n.id)).toEqual(['n1', 'new']);
    expect(c.showCreateDialog()).toBe(false);
  });

  it('leaveNetwork() removes the network only after the confirm dialog is accepted', async () => {
    const c = make();
    c.networks.set([net({ id: 'n1' }), net({ id: 'n2' })]);
    confirmResult = false;
    await c.leaveNetwork(net({ id: 'n1' }));
    expect(api.leaveNetwork).not.toHaveBeenCalled();
    expect(c.networks().length).toBe(2);

    confirmResult = true;
    await c.leaveNetwork(net({ id: 'n1' }));
    expect(api.leaveNetwork).toHaveBeenCalledWith('n1');
    expect(c.networks().map(n => n.id)).toEqual(['n2']);
  });

  it('saveSchedule() sends the per-network override and reflects it on success', () => {
    const c = make();
    c.networks.set([net({ id: 'n1' })]);
    c.netSchedule = { n1: '0 * * * *' };
    c.saveSchedule(net({ id: 'n1' }));
    expect(api.updateNetworkSchedule).toHaveBeenCalledWith('n1', '0 * * * *');
    expect(c.networks()[0].syncSchedule).toBe('0 * * * *');
  });

  // Join-dialog behavior (bundle validation, collision detection, immediate join) moved to
  // network-join-dialog.component.spec.ts when the Join dialog became its own child component. The
  // parent only reloads on the child's `joined` output — pinned here.
  it('onJoined() reloads the network list', () => {
    const c = make();
    c.onJoined();
    expect(api.listNetworks).toHaveBeenCalled(); // load()
  });

  it('sync() records the result on success and an {ok:false} result on error', () => {
    const c = make();
    api.triggerSync.mockReturnValue(of({ ok: true }));
    c.sync('n1');
    expect(c.syncResult('n1')).toEqual({ ok: true });

    api.triggerSync.mockReturnValue(throwError(() => ({})));
    c.sync('n2');
    expect(c.syncResult('n2')).toEqual({ ok: false });
  });

  it('castVote() reloads votes on success and toasts on error', () => {
    const c = make();
    c.castVote('n1', 'r1', 'yes');
    expect(api.castVote).toHaveBeenCalledWith('n1', 'r1', 'yes');
    expect(api.listVotes).toHaveBeenCalledWith('n1'); // reload

    api.castVote.mockReturnValue(throwError(() => ({ error: { error: 'boom' } })));
    c.castVote('n1', 'r1', 'yes');
    expect(toastError).toHaveBeenCalled();
  });

  it('castVote "veto" confirms first and only proceeds when accepted', async () => {
    const c = make();
    confirmResult = false;
    await c.castVote('n1', 'r1', 'veto');
    expect(confirm).toHaveBeenCalled();
    expect(api.castVote).not.toHaveBeenCalled();

    confirmResult = true;
    await c.castVote('n1', 'r1', 'veto');
    expect(api.castVote).toHaveBeenCalledWith('n1', 'r1', 'veto');
  });

  it('castVote "yes" does NOT ask for confirmation', () => {
    const c = make();
    c.castVote('n1', 'r1', 'yes');
    expect(confirm).not.toHaveBeenCalled();
    expect(api.castVote).toHaveBeenCalledWith('n1', 'r1', 'yes');
  });

  it('removeMember() is confirm-guarded and reloads on success', async () => {
    const c = make();
    confirmResult = false;
    await c.removeMember(net({ id: 'n1' }), 'inst-2', 'Peer');
    expect(api.removeMember).not.toHaveBeenCalled();

    confirmResult = true;
    await c.removeMember(net({ id: 'n1' }), 'inst-2', 'Peer');
    expect(api.removeMember).toHaveBeenCalledWith('n1', 'inst-2');
    expect(api.listNetworks).toHaveBeenCalled(); // load() re-run
  });

  it('typeBadge() maps known network types and defaults to gray', () => {
    const c = make();
    expect(c.typeBadge('democratic')).toBe('badge-green');
    expect(c.typeBadge('braintree')).toBe('badge-purple');
    expect(c.typeBadge('unknown-type')).toBe('badge-gray');
  });

  it('toggleNetwork() expands then collapses a network by id', () => {
    const c = make();
    expect(c.expanded()).toBe('');
    c.toggleNetwork('n1');
    expect(c.expanded()).toBe('n1');
    c.toggleNetwork('n1');
    expect(c.expanded()).toBe('');
  });

  it('each async action flags in-flight while pending and clears it on completion', () => {
    const c = make();
    // `generateInvite` moved to `network-invite-panel.component.spec.ts` with the panel itself.
    const ss = new Subject<any>(), sy = new Subject<any>(), cv = new Subject<any>();
    api.updateNetworkSchedule.mockReturnValue(ss);
    api.triggerSync.mockReturnValue(sy);
    api.castVote.mockReturnValue(cv);
    c.networks.set([net({ id: 'n1' })]);

    c.saveSchedule(net({ id: 'n1' }));
    expect(c.savingSchedule['n1']).toBe(true);
    ss.next({}); ss.complete();
    expect(c.savingSchedule['n1']).toBeUndefined();

    c.sync('n1');
    expect(c.syncingNet['n1']).toBe(true);
    sy.next({ ok: true }); sy.complete();
    expect(c.syncingNet['n1']).toBeUndefined();

    c.castVote('n1', 'r1', 'yes');
    expect(c.votingRound['r1']).toBe(true);
    cv.next({}); cv.complete();
    expect(c.votingRound['r1']).toBeUndefined();
  });

  it('an async action clears its in-flight flag on error too', () => {
    const c = make();
    const sy = new Subject<any>();
    api.triggerSync.mockReturnValue(sy);
    c.sync('n1');
    expect(c.syncingNet['n1']).toBe(true);
    sy.error({});
    expect(c.syncingNet['n1']).toBeUndefined();
  });

  it('summaryItems() counts networks and total members', () => {
    const c = make();
    c.networks.set([
      net({ id: 'n1', members: [{}, {}, {}] as never }),
      net({ id: 'n2', members: [{}] as never }),
    ]);
    const items = c.summaryItems();
    const val = (frag: string) => items.find(i => i.label.includes(frag))?.value;
    expect(val('networks')).toBe(2);
    expect(val('members')).toBe(4);
    expect(val('needVote')).toBe(0);
  });

  it('summaryItems() needs-vote count reflects networks with open rounds after load', () => {
    const c = make();
    api.listNetworks.mockReturnValue(of({ networks: [net({ id: 'n1' }), net({ id: 'n2' })] }));
    api.listVotes.mockImplementation((id: string) => of({ rounds: id === 'n1' ? [round({ status: 'open' })] : [] }));
    c.load();
    expect(c.summaryItems().find(i => i.label.includes('needVote'))?.value).toBe(1);
  });

  it('voteTally() counts yes and veto votes', () => {
    const c = make();
    const t = c.voteTally(round({ votes: [
      { instanceId: 'a', vote: 'yes' }, { instanceId: 'b', vote: 'veto' }, { instanceId: 'c', vote: 'yes' },
    ] }));
    expect(t).toEqual({ yes: 2, veto: 1 });
  });

  // Enable-Networks wizard behavior moved to network-enable-wizard.component.spec.ts when the wizard
  // became its own child component. The parent only adopts the URL the wizard reports:
  it('onEnabled() adopts the reported URL and clears the enable prompt', () => {
    const c = make();
    c.needsNetworkEnable.set(true);
    c.onEnabled('https://brain.example.com');
    expect(c.joinMyUrl).toBe('https://brain.example.com');
    expect(c.needsNetworkEnable()).toBe(false);
  });

  // Per-peer sync health on the member rows (#431) is TEMPLATE-ONLY (no method to drive), so unlike the
  // logic-only characterization above this one render test expands a network and asserts the markup:
  // a member with a failing streak shows the "Failing(N)" badge and a member never synced shows the
  // never-synced label rather than a date.
  it('member rows show per-peer sync health: a failing badge on a streak, never-synced when unsynced', () => {
    make(); // configures the TestBed (providers) and resets it; we build our own fixture below
    const members = [
      { instanceId: 'aaaaaaaa1111', label: 'Peer A', url: 'https://a.example', consecutiveFailures: 3, lastSyncAt: '2026-07-20T10:00:00Z' },
      { instanceId: 'bbbbbbbb2222', label: 'Peer B', url: 'https://b.example', consecutiveFailures: 0, lastSyncAt: null },
    ];
    api.listNetworks.mockReturnValue(of({ networks: [net({ id: 'n1', members: members as never })] }));
    const fixture = TestBed.createComponent(NetworksComponent);
    const inst = fixture.componentInstance;
    inst.load();          // populate networks from the mocked API
    inst.expanded.set('n1'); // expand so the member rows render
    fixture.detectChanges();
    /*
     * `app-network-member-row`, not `.member-row`. `N-2` made the row its own component and the HOST is
     * the row — `:host { display: flex }` rather than a wrapping div, because a custom element is inline
     * by default and the border and gap would shrink-wrap.
     *
     * The assertions below are UNCHANGED, which is the point of a characterization test: the markup moved
     * and the behaviour did not, so only the selector follows it.
     */
    const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll('app-network-member-row')];
    expect(rows.length).toBe(2);
    // Peer A (3 failures) shows the failing badge; Peer B (0) does not.
    expect(rows[0].querySelector('.member-failing')).toBeTruthy();
    expect(rows[1].querySelector('.member-failing')).toBeNull();
    // Peer B never synced → the never-synced label (test transloco emits the raw key), not a date.
    expect(rows[1].querySelector('.member-sync')?.textContent).toContain('networks.member.neverSynced');
  });

  /*
   * F-38.1 — the card shows this instance's ROLE and the members that role acts on, not a flat member count.
   * Owner, 2026-09-25: "subscribers if im pub and nothing if im sub, on club i want to see peers, on braintree i
   * want to see the path to root and my sub-path".
   */
  describe('the role this instance has in each network (F-38.1)', () => {
    const m = (instanceId: string) => ({ instanceId, label: instanceId, url: `https://${instanceId}` });
    const titles = (groups: { titleKey: string }[]) => groups.map(g => g.titleKey);
    const ids = (groups: { members: { instanceId: string }[] }[]) => groups.map(g => g.members.map(x => x.instanceId));

    it('a publisher lists its subscribers and counts them', () => {
      const c = make();
      const n = net({ type: 'pubsub', members: [m('s1'), m('s2')], myRole: { role: 'publisher', members: ['s1', 's2'] } } as Partial<Network>);
      expect(titles(c.memberGroups(n))).toEqual(['networks.network.members.subscribers']);
      expect(ids(c.memberGroups(n))).toEqual([['s1', 's2']]);
      expect(c.roleCountKey(n.myRole!)).toBe('networks.role.count.subscribers');
    });
    it('a subscriber shows only its publisher and no count', () => {
      const c = make();
      const n = net({ type: 'pubsub', members: [m('pub')], myRole: { role: 'subscriber', members: [], publisher: 'pub' } } as Partial<Network>);
      expect(titles(c.memberGroups(n))).toEqual(['networks.network.members.publisher']);
      expect(ids(c.memberGroups(n))).toEqual([['pub']]);
      expect(c.roleCountKey(n.myRole!)).toBeNull();
    });
    it('a club organiser sees its peers', () => {
      const c = make();
      const n = net({ type: 'club', members: [m('a')], myRole: { role: 'organiser', members: ['a'] } } as Partial<Network>);
      expect(titles(c.memberGroups(n))).toEqual(['networks.network.members.peers']);
      // Q-54: one member is counted in the singular, two in the plural.
      expect(c.roleCountKey(n.myRole!)).toBe('networks.role.count.peersOne');
      expect(c.roleCountKey({ role: 'organiser', members: ['a', 'b'] })).toBe('networks.role.count.peers');
    });
    it('a tree node sees the path to the root and what is below it', () => {
      const c = make();
      const n = net({ type: 'braintree', members: [m('root'), m('mid'), m('kid')],
        myRole: { role: 'node', members: ['kid'], pathToRoot: ['mid', 'root'], subtree: ['kid'] } } as Partial<Network>);
      expect(titles(c.memberGroups(n))).toEqual(['networks.network.members.pathToRoot', 'networks.network.members.subtree']);
      expect(ids(c.memberGroups(n))).toEqual([['mid', 'root'], ['kid']]);
    });
    it('without a role from the server, every member is listed as before', () => {
      const c = make();
      const n = net({ members: [m('a'), m('b')] });
      expect(titles(c.memberGroups(n))).toEqual(['networks.network.members.title']);
    });
    it('a space mapped from a differently named network space says where it came from', () => {
      const c = make();
      const n = net({ spaces: ['team-flows'], spaceMap: { flows: 'team-flows' } } as Partial<Network>);
      expect(c.remoteOf(n, 'team-flows')).toBe('flows');
      expect(c.remoteOf(net({ spaces: ['x'] } as Partial<Network>), 'x')).toBeNull();
    });
  });
});
