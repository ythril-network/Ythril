import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { RightsMatrixComponent } from './rights-matrix.component';
import { RightsCatalogService, impliedFrom, type RightsCatalog } from './rights-catalog.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { RIGHT_AREAS, type Rung, type TokenRights } from './rights-glyph.component';

const rights = (over: Partial<TokenRights> = {}): TokenRights =>
  ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, ...over });

/** A stub catalog, so the grid's own tests never depend on the endpoint that explains it. */
const CATALOG_ROUTES = [
  { area: 'knowledge', method: 'POST', route: '/api/x/recall', needs: 'read' as const },
  { area: 'knowledge', method: 'DELETE', route: '/api/x/facts/:id', needs: 'write' as const },
  { area: 'files', method: 'GET', route: '/api/x/files', needs: 'read' as const },
];
/** The server's own `RUNG_IMPLICATIONS`, as the catalog publishes them. */
const CATALOG_IMPLICATIONS = [
  { when: 'knowledge', atLeast: 'write' as const, grants: 'schema', rung: 'read' as const },
];
function stubCatalog(loaded = true) {
  const catalog = signal(loaded
    ? {
      areas: ['knowledge', 'files', 'schema', 'dataQuality'],
      rungs: ['none', 'read', 'write', 'admin'] as const,
      implications: CATALOG_IMPLICATIONS,
      routes: CATALOG_ROUTES,
    }
    : null);
  return {
    catalog, failed: signal(!loaded), load: () => {},
    routesFor: (area: string, rung: string) => {
      const order = ['none', 'read', 'write', 'admin'].indexOf(rung);
      return CATALOG_ROUTES.filter(r => r.area === area && ['none', 'read', 'write', 'admin'].indexOf(r.needs) <= order);
    },
    countFor: (area: string) => CATALOG_ROUTES.filter(r => r.area === area).length,
    // The REAL rule, not a second copy of it. A stub that re-implemented the implication would let these
    // tests pass against a rule the product does not have.
    impliedFor: (area: string, of: (a: string) => Rung) => impliedFrom(catalog() as RightsCatalog | null, area, of),
  };
}

describe('RightsMatrixComponent', () => {
  let fixture: ComponentFixture<RightsMatrixComponent>;
  let emitted: TokenRights[];

  const render = (r: TokenRights, spaces = ['qa', 'research']) => {
    fixture = TestBed.createComponent(RightsMatrixComponent);
    fixture.componentRef.setInput('rights', r);
    fixture.componentRef.setInput('spaces', spaces);
    emitted = [];
    fixture.componentInstance.changed.subscribe(v => emitted.push(v));
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RightsMatrixComponent, getTranslocoModule()],
      providers: [{ provide: RightsCatalogService, useValue: stubCatalog() }],
    }).compileComponents();
  });

  it('puts the floor row FIRST, then one row per space', () => {
    const el = render(rights());
    const rows = [...el.querySelectorAll('tbody tr')];
    expect(rows.length).toBe(3);
    expect(rows[0]!.className).toContain('floor');
    expect(rows[0]!.querySelector('td.l')!.textContent).toContain('tokens.rights.allSpaces');
    expect(rows[1]!.querySelector('td.l')!.textContent).toContain('qa');
  });

  it('a cell shows the FLOOR when the floor is higher than its own row', () => {
    // Showing the stored row alone would display `none` for a space the token reaches through the floor —
    // the cell saying one thing while enforcement does another, in the direction that under-states access.
    const el = render(rights({ floor: { knowledge: 'read', files: 'none', schema: 'none', dataQuality: 'none' } }));
    const firstCell = el.querySelectorAll('tbody tr')[1]!.querySelectorAll('app-rung-picker')[0]!;
    const filled = [...firstCell.querySelectorAll('button')].filter(b => b.className.includes('on'));
    expect(filled.length).toBe(2);   // none + read
  });

  it('a row above the floor keeps its own higher level', () => {
    const el = render(rights({
      floor: { knowledge: 'read', files: 'none', schema: 'none', dataQuality: 'none' },
      perSpace: { qa: { knowledge: 'admin', files: 'none', schema: 'none', dataQuality: 'none' } },
    }));
    const cell = el.querySelectorAll('tbody tr')[1]!.querySelectorAll('app-rung-picker')[0]!;
    expect([...cell.querySelectorAll('button')].filter(b => b.className.includes('on')).length).toBe(4);
  });

  it('emits a WHOLE matrix, not a patch', () => {
    // The parent holds one draft and saves it as one thing. Emitting deltas would mean the parent
    // reassembles the object — a second place the shape is known, and the shape is what the server caps.
    const el = render(rights());
    el.querySelectorAll('tbody tr')[1]!.querySelectorAll('button')[1]!.click();
    expect(emitted.length).toBe(1);
    expect(emitted[0]).toHaveProperty('instanceAdmin');
    expect(emitted[0]).toHaveProperty('floor');
    expect(emitted[0]!.perSpace['qa']!['knowledge']).toBe('read');
  });

  it('editing one space leaves the others untouched', () => {
    const el = render(rights({ perSpace: { research: { knowledge: 'write', files: 'none', schema: 'none', dataQuality: 'none' } } }));
    el.querySelectorAll('tbody tr')[1]!.querySelectorAll('button')[1]!.click();
    expect(emitted[0]!.perSpace['research']!['knowledge']).toBe('write');
  });

  it('the floor row edits the floor, not a space', () => {
    const el = render(rights());
    el.querySelectorAll('tbody tr')[0]!.querySelectorAll('button')[1]!.click();
    expect(emitted[0]!.floor!['knowledge']).toBe('read');
    expect(Object.keys(emitted[0]!.perSpace)).toEqual([]);
  });

  it('clamps space cells beneath the floor rather than hiding the rung', () => {
    const el = render(rights({ floor: { knowledge: 'write', files: 'none', schema: 'none', dataQuality: 'none' } }));
    const cell = el.querySelectorAll('tbody tr')[1]!.querySelectorAll('app-rung-picker')[0]!;
    const bs = [...cell.querySelectorAll('button')];
    expect(bs[0]!.disabled).toBe(true);
    expect(bs[1]!.disabled).toBe(true);
    expect(bs[2]!.disabled).toBe(false);
  });

  it('renders with no spaces without collapsing the floor row', () => {
    const el = render(rights(), []);
    expect(el.querySelectorAll('tbody tr').length).toBe(1);
    expect(el.querySelector('tbody tr')!.className).toContain('floor');
  });
});

/**
 * `knowledge: write` entails `schema: read` (owner ruling, 2026-08-15). The server resolves it in
 * `effectiveRung`; the grid must SHOW it, or the screen says `none` while the API grants read — the direction
 * that understates access, on the one screen somebody audits access from.
 *
 * The rule reaches these tests through the stub's real `impliedFrom`, so a change to the rule breaks them.
 */
describe('RightsMatrixComponent — an implied rung', () => {
  let fixture: ComponentFixture<RightsMatrixComponent>;

  const render = (r: TokenRights, spaces = ['qa']) => {
    fixture = TestBed.createComponent(RightsMatrixComponent);
    fixture.componentRef.setInput('rights', r);
    fixture.componentRef.setInput('spaces', spaces);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };
  /** Column order is the area order: knowledge, files, schema, dataQuality. */
  const pickerIn = (el: HTMLElement, row: number, col: number) =>
    el.querySelectorAll('tbody tr')[row]!.querySelectorAll('app-rung-picker')[col]!;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      // The two REAL English strings, so the interpolation is exercised rather than the key echoed. Asserting
      // on a bare key would pass with the parameters wired to nothing, which is the half most likely to break.
      imports: [RightsMatrixComponent, getTranslocoModule({
        translation: {
          en: {
            'tokens.rights.clamp.implied': 'Held at {{rung}} because {{area}} is {{cause}}, which cannot work without it',
            'tokens.rights.area.knowledge': 'Knowledge',
          },
        },
      })],
      providers: [{ provide: RightsCatalogService, useValue: stubCatalog() }],
    }).compileComponents();
  });

  it('SHOWS the schema cell at read when knowledge is write, though none is stored', () => {
    const el = render(rights({ perSpace: { qa: { knowledge: 'write', files: 'none', schema: 'none', dataQuality: 'none' } } }));
    const bs = [...pickerIn(el, 1, 2).querySelectorAll('button')];
    // Filled up to `read`, not `none`: the segments say what the token can do, and the token can read schemas.
    expect(bs.map(b => b.className.includes('on'))).toEqual([true, true, false, false]);
  });

  it('clamps below the implied rung and says which area holds it there', () => {
    const el = render(rights({ perSpace: { qa: { knowledge: 'write', files: 'none', schema: 'none', dataQuality: 'none' } } }));
    const bs = [...pickerIn(el, 1, 2).querySelectorAll('button')];
    expect(bs[0]!.disabled).toBe(true);
    expect(bs[1]!.disabled).toBe(false);
    // The title must name the CAUSE and the rung that caused it. "Held at read" alone sends the reader to the
    // floor row, which is not what is holding it.
    expect(bs[0]!.getAttribute('title')).toBe('Held at read because Knowledge is write, which cannot work without it');
  });

  it('leaves schema alone when knowledge is only read', () => {
    const el = render(rights({ perSpace: { qa: { knowledge: 'read', files: 'none', schema: 'none', dataQuality: 'none' } } }));
    const bs = [...pickerIn(el, 1, 2).querySelectorAll('button')];
    expect(bs.map(b => b.disabled)).toEqual([false, false, false, false]);
    expect(bs.map(b => b.className.includes('on'))).toEqual([true, false, false, false]);
  });

  it('applies to the FLOOR row too, from the floor own knowledge rung', () => {
    const el = render(rights({ floor: { knowledge: 'write', files: 'none', schema: 'none', dataQuality: 'none' } }));
    const bs = [...pickerIn(el, 0, 2).querySelectorAll('button')];
    expect(bs.map(b => b.className.includes('on'))).toEqual([true, true, false, false]);
    expect(bs[0]!.disabled).toBe(true);
  });

  it('gives each COLUMN its own capability tooltip', () => {
    // The failure this pins: a tooltip identical across areas means [area] was never wired and the picker
    // fell back to the action-only string. Per-rung difference is not enough to catch that — the old control
    // already differed per rung, which is why the gap survived so long.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [RightsMatrixComponent, getTranslocoModule({
        translation: {
          en: {
            'tokens.rights.plain.knowledge.read': 'Search and read records.',
            'tokens.rights.plain.files.read': 'List and download files.',
          },
        },
      })],
      providers: [{ provide: RightsCatalogService, useValue: stubCatalog() }],
    });
    const f = TestBed.createComponent(RightsMatrixComponent);
    f.componentRef.setInput('rights', rights());
    f.componentRef.setInput('spaces', ['qa']);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const titleAt = (col: number) => el.querySelectorAll('tbody tr')[1]!
      .querySelectorAll('app-rung-picker')[col]!.querySelectorAll('button')[1]!.getAttribute('title');
    expect(titleAt(0)).toContain('Search and read records.');
    expect(titleAt(1)).toContain('List and download files.');
    expect(titleAt(0)).not.toBe(titleAt(1));
  });

  it('does not write the implied rung into the emitted matrix', () => {
    // The stored matrix keeps saying what the operator set. Persisting an inference would make a rung that
    // exists only while knowledge is write outlive knowledge dropping back to read.
    const el = render(rights({ perSpace: { qa: { knowledge: 'write', files: 'none', schema: 'none', dataQuality: 'none' } } }));
    const emitted: TokenRights[] = [];
    fixture.componentInstance.changed.subscribe(v => emitted.push(v));
    pickerIn(el, 1, 1)!.querySelectorAll('button')[1]!.click();   // touch `files`, an unrelated column
    expect(emitted[0]!.perSpace['qa']!['schema']).toBe('none');
  });
});

/**
 * The owner's ask: a right must say what it grants, in plain language AND as the endpoints it reaches.
 * Before this the grid was 4×4 bare words, and the column headers printed the code identifiers.
 */
describe('RightsMatrixComponent — what a right grants', () => {
  const render = (r: TokenRights, spaces = ['qa']) => {
    const fixture = TestBed.createComponent(RightsMatrixComponent);
    fixture.componentRef.setInput('rights', r);
    fixture.componentRef.setInput('spaces', spaces);
    fixture.detectChanges();
    return fixture;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RightsMatrixComponent, getTranslocoModule()],
      providers: [{ provide: RightsCatalogService, useValue: stubCatalog() }],
    }).compileComponents();
  });

  it('every column header carries the plain-language description as a tooltip', () => {
    /*
     * REWRITTEN BY HAND when the Space Admin column landed, not renumbered from 4 to 5.
     *
     * The subject is "every column header explains itself", and that must hold for five columns as it did for
     * four. What changed is that the fifth is NOT an area, so its key cannot be `tokens.rights.area.*.desc` — a
     * space administrator is a derived rung across all four areas. Asserting the shape per column keeps the
     * original claim and adds the distinction, where bumping the number would have quietly allowed a fifth
     * header with no tooltip at all.
     *
     * This assertion is why the column was reverted once before. It needed twenty minutes of reading; the
     * feature waited five releases.
     */
    const el = render(rights()).nativeElement as HTMLElement;
    const buttons = [...el.querySelectorAll('thead .area-info')];
    expect(buttons.length).toBe(RIGHT_AREAS.length + 1);
    const titles = buttons.map(b => b.getAttribute('title'));
    // The four areas, each with its own key.
    expect(titles.filter(t => /^tokens\.rights\.area\.\w+\.desc$/.test(t ?? ''))).toHaveLength(RIGHT_AREAS.length);
    // And the derived one, which is a different key because it is a different kind of thing.
    expect(titles).toContain('tokens.rights.spaceAdmin.desc');
    // No header may be silent, whichever kind it is.
    for (const t of titles) expect(t, 'a column header has no tooltip').toBeTruthy();
  });

  it('no panel is open until asked, and it opens for the area clicked', () => {
    const fixture = render(rights());
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.explain')).toBeNull();

    (el.querySelectorAll('thead .area-info')[0] as HTMLButtonElement).click();
    fixture.detectChanges();
    const panel = el.querySelector('.explain')!;
    expect(panel).toBeTruthy();
    expect(panel.querySelector('h4')!.textContent).toContain('tokens.rights.area.knowledge');
  });

  it('the panel lists the endpoints CUMULATIVELY, with the rung each comes from', () => {
    const fixture = render(rights());
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelectorAll('thead .area-info')[0] as HTMLButtonElement).click();
    fixture.detectChanges();

    const rows = [...el.querySelectorAll('.explain tbody tr')];
    // knowledge has a read route AND a write route in the stub; both must appear, because admin contains both.
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.textContent).join(' ')).toContain('/api/x/recall');
    expect(rows.map(r => r.textContent).join(' ')).toContain('/api/x/facts/:id');
    // And each says which rung first reaches it, or the list cannot answer "what does write grant".
    expect(rows[0]!.querySelector('.needs')!.textContent).toContain('read');
  });

  it('clicking the same header again closes it', () => {
    const fixture = render(rights());
    const el = fixture.nativeElement as HTMLElement;
    const btn = el.querySelectorAll('thead .area-info')[1] as HTMLButtonElement;
    btn.click(); fixture.detectChanges();
    expect(el.querySelector('.explain')).toBeTruthy();
    btn.click(); fixture.detectChanges();
    expect(el.querySelector('.explain')).toBeNull();
  });

  it('a rung explanation is shown once per rung, not once per area', () => {
    const fixture = render(rights());
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelectorAll('thead .area-info')[0] as HTMLButtonElement).click();
    fixture.detectChanges();
    const items = [...el.querySelectorAll('.explain .rungs li')];
    // read / write / admin. `none` is excluded: the word is its own explanation.
    expect(items.length).toBe(3);
    expect(items.map(i => i.textContent).join(' ')).not.toContain('rung.none');
  });
});

describe('RightsMatrixComponent — the grid survives its explanation failing', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RightsMatrixComponent, getTranslocoModule()],
      providers: [{ provide: RightsCatalogService, useValue: stubCatalog(false) }],
    }).compileComponents();
  });

  it('renders the grid and says the endpoint list is unavailable', () => {
    // A tooltip that cannot load must not take the editor with it.
    const fixture = TestBed.createComponent(RightsMatrixComponent);
    fixture.componentRef.setInput('rights', rights());
    fixture.componentRef.setInput('spaces', ['qa']);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('app-rung-picker').length).toBeGreaterThan(0);

    (el.querySelectorAll('thead .area-info')[0] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('.explain tbody')).toBeNull();
    expect(el.querySelector('.explain .miss')!.textContent).toContain('tokens.rights.endpointsUnavailable');
  });
});

/**
 * The Space Admin column.
 *
 * ## Why it exists, and why it took five releases
 *
 * A space administrator is a token holding **admin on all four areas of that space**. The server has enforced that
 * since #937 and publishes it as a derived rung on `GET /api/tokens/rights-shape`. The matrix showed four
 * independent rungs and nothing said that all four at `admin` IS administering the space — so the commonest grant
 * meant setting four cells and hoping none was missed.
 *
 * Owner, five times: *"i miss space admin"*. It had been built once and **reverted** because a header-count
 * assertion in this file broke. That assertion needed rewriting by hand, which is the twenty-minute job done above.
 * Reverting working UI over a test count is the wrong trade, and these tests are what make the trade unnecessary
 * next time: they pin the behaviour that matters rather than the number of elements on a row.
 */
describe('RightsMatrixComponent — the Space Admin column', () => {
  let fixture: ComponentFixture<RightsMatrixComponent>;
  let emitted: TokenRights[];

  const render = (r: TokenRights, spaces = ['qa', 'research']) => {
    fixture = TestBed.createComponent(RightsMatrixComponent);
    fixture.componentRef.setInput('rights', r);
    fixture.componentRef.setInput('spaces', spaces);
    emitted = [];
    fixture.componentInstance.changed.subscribe(v => emitted.push(v));
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RightsMatrixComponent, getTranslocoModule()],
      providers: [{ provide: RightsCatalogService, useValue: stubCatalog() }],
    }).compileComponents();
  });

  const ALL_ADMIN = { knowledge: 'admin', files: 'admin', schema: 'admin', dataQuality: 'admin' } as const;
  const toggleIn = (el: HTMLElement, row: number) =>
    el.querySelectorAll('tbody tr')[row]!.querySelector('app-space-admin-toggle')!;

  it('there is one toggle per row, INCLUDING the floor row, and a visible header', () => {
    // The floor is "every space, including ones created later" — the case where a uniform grant is most often
    // what somebody means, so leaving it out would miss the commonest use.
    const el = render(rights());
    expect(el.querySelectorAll('app-space-admin-toggle').length).toBe(3);
    expect(toggleIn(el, 0)).toBeTruthy();

    /*
     * And the header must be REACHABLE, not merely present. jsdom does no layout, so this cannot assert what a
     * person sees — but it can refuse the one way an element is present and unseen without any styling: `hidden`.
     * Mutation testing found this gap by adding that attribute and watching the count assertion still pass.
     */
    const header = el.querySelector('thead th.admincol') as HTMLElement | null;
    expect(header, 'the Space Admin header is missing').toBeTruthy();
    expect(header!.hasAttribute('hidden')).toBe(false);
    expect(header!.textContent).toContain('tokens.rights.spaceAdmin');
  });

  it('reads as ON for the GRANT, and OFF for four admin rungs', () => {
    /*
     * The 5.0 change, on the screen somebody audits access from. Administering a space is its own grant;
     * four admin rungs are everything you can do to the DATA and are not administration. A column that
     * still read them as ON would overstate access in exactly the place it must not.
     */
    const on = (el: HTMLElement, row: number) =>
      [...toggleIn(el, row).querySelectorAll('button')][1]!.className.includes('on');

    expect(on(render(rights({ spaceAdmin: { floor: false, spaces: ['qa'] } })), 1)).toBe(true);
    expect(on(render(rights({ perSpace: { qa: ALL_ADMIN } })), 1)).toBe(false);
    // Three of four is not a space administrator, and showing it as one would overstate access on the screen
    // somebody audits access from.
    expect(on(render(rights({
      perSpace: { qa: { knowledge: 'admin', files: 'admin', schema: 'admin', dataQuality: 'write' } },
    })), 1)).toBe(false);
    expect(on(render(rights()), 1)).toBe(false);
  });

  it('reads as ON for the FLOOR form — every space, including ones created later', () => {
    /*
     * The canary operator's shape (`Q-12`), now expressed as the grant's own floor rather than four admin
     * area floors. Every row reads as administered, because it is.
     */
    const el = render(rights({ spaceAdmin: { floor: true, spaces: [] } }));
    expect([...toggleIn(el, 1).querySelectorAll('button')][1]!.className.includes('on')).toBe(true);
  });

  it('and four admin FLOORS read as OFF, for the same reason four rungs do', () => {
    const el = render(rights({ floor: { ...ALL_ADMIN } }));
    expect([...toggleIn(el, 1).querySelectorAll('button')][1]!.className.includes('on')).toBe(false);
  });

  it('granting writes the GRANT, in ONE emit', () => {
    /*
     * Since 5.0 this writes `spaceAdmin` rather than four `admin` cells. The four cells looked the same to
     * an operator and were not the same thing: what got stored was four rungs, so the INTENT was gone on
     * save and editing one cell afterwards withdrew the rung with nothing saying so.
     *
     * Still one emit. The parent persists on change, so two would let it observe an intermediate state.
     */
    const el = render(rights());
    [...toggleIn(el, 1).querySelectorAll('button')][1]!.click();
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.spaceAdmin).toEqual({ floor: false, spaces: ['qa'] });
  });

  it('withdrawing removes the grant', () => {
    const el = render(rights({ spaceAdmin: { floor: false, spaces: ['qa'] } }));
    [...toggleIn(el, 1).querySelectorAll('button')][0]!.click();
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.spaceAdmin?.spaces ?? []).not.toContain('qa');
  });

  it('a token granted the old way is migrated on the SERVER, not read as administered here', () => {
    // `config/migrate-space-admin-grant.ts` writes the grant on boot for every token that held all four.
    // The editor must not second-guess it, or the screen and the server would disagree for anything the
    // migration deliberately left alone — a floor, or three rungs and a write.
    const el = render(rights({ perSpace: { qa: ALL_ADMIN } }));
    const on = [...toggleIn(el, 1).querySelectorAll('button')][1]!;
    expect(on.getAttribute('aria-pressed')).toBe('false');
  });

  it('granting on the floor row writes the grant FLOOR, not four area floors', () => {
    // The area floors grant maximal rights over every space's DATA and administration of none. Writing
    // them here would have silently stopped the canary operator's token administering anything.
    const el = render(rights());
    [...toggleIn(el, 0).querySelectorAll('button')][1]!.click();
    expect(emitted[0]!.spaceAdmin).toEqual({ floor: true, spaces: [] });
    expect(emitted[0]!.floor).toBeNull();
    expect(Object.keys(emitted[0]!.perSpace)).toEqual([]);
  });

  it('leaves other spaces alone', () => {
    const el = render(rights({ perSpace: { research: { knowledge: 'write', files: 'none', schema: 'none', dataQuality: 'none' } } }));
    [...toggleIn(el, 1).querySelectorAll('button')][1]!.click();
    expect(emitted[0]!.perSpace['research']!['knowledge']).toBe('write');
  });

  it('THE FOUR AREAS ARE STILL INDEPENDENTLY SETTABLE — the model this is only a shortcut for', () => {
    /*
     * The reason the earlier attempt's specs "needed reading rather than renumbering". This column must not become
     * the way rights are expressed: anything other than all-or-nothing is said with the four pickers, and if this
     * shortcut ever replaced them the matrix would have lost the per-area model it exists to provide.
     */
    const el = render(rights());
    const row = el.querySelectorAll('tbody tr')[1]!;
    expect(row.querySelectorAll('app-rung-picker').length).toBe(RIGHT_AREAS.length);
    // Setting one area alone still emits exactly that.
    row.querySelectorAll('app-rung-picker')[2]!.querySelectorAll('button')[1]!.click();
    expect(emitted[0]!.perSpace['qa']).toEqual(
      { knowledge: 'none', files: 'none', schema: 'read', dataQuality: 'none' });
  });

  it('is disabled in a read-only view, like every other control in the grid', () => {
    fixture = TestBed.createComponent(RightsMatrixComponent);
    fixture.componentRef.setInput('rights', rights());
    fixture.componentRef.setInput('spaces', ['qa']);
    fixture.componentRef.setInput('readonlyView', true);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    for (const b of el.querySelectorAll('app-space-admin-toggle button')) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
