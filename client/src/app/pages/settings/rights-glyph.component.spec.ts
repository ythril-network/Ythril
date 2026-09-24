import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RightsGlyphComponent, RIGHT_AREAS, type TokenRights, type AreaRungs, type Rung } from './rights-glyph.component';

/**
 * The glyph has to be right about two different things at once — how high a token goes, and how much of that
 * it holds everywhere — and both are easy to get subtly wrong in the direction that flatters a token.
 */
const R = (r: Rung): AreaRungs => ({ knowledge: r, files: r, schema: r, dataQuality: r, networks: r });
const rights = (over: Partial<TokenRights> = {}): TokenRights =>
  ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, ...over });

describe('RightsGlyphComponent', () => {
  let fixture: ComponentFixture<RightsGlyphComponent>;

  const render = (r: TokenRights) => {
    fixture = TestBed.createComponent(RightsGlyphComponent);
    fixture.componentRef.setInput('rights', r);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [RightsGlyphComponent] }).compileComponents();
  });

  it('draws one bar per area, in the matrix order', () => {
    const el = render(rights());
    expect(el.querySelectorAll('.bar').length).toBe(RIGHT_AREAS.length);
  });

  it('the ceiling is the highest rung in ANY space, not just the floor', () => {
    // Reading only the floor would show this token as `none` while it administers one space.
    const el = render(rights({ perSpace: { qa: R('admin') } }));
    expect(el.querySelector('.bar')!.className).toContain('h3');
  });

  it('the ceiling counts the floor too, not just the rows', () => {
    // The mirror mistake: reading only `perSpace` would show nothing for a token whose reach is its floor.
    const el = render(rights({ floor: R('write') }));
    expect(el.querySelector('.bar')!.className).toContain('h2');
  });

  it('marks the floor, and only when there IS one', () => {
    // A line at the baseline would read as "a floor of zero" rather than "no floor", and those are
    // different facts: one reaches every future space at `none`, the other reaches none of them at all.
    expect(render(rights({ perSpace: { qa: R('admin') } })).querySelector('.floor')).toBeNull();
    expect(render(rights({ floor: R('read'), perSpace: { qa: R('admin') } })).querySelector('.floor')).not.toBeNull();
  });

  it('puts the floor mark at the floor level, not the ceiling', () => {
    const el = render(rights({ floor: R('read'), perSpace: { qa: R('admin') } }));
    expect(el.querySelector('.floor')!.className).toContain('f1');
    expect(el.querySelector('.bar')!.className).toContain('h3');
  });

  it('shows a full-height mark when ceiling and floor are equal', () => {
    // The state worth spotting from across a list: that level everywhere, forever, nothing space-specific
    // left to review.
    const el = render(rights({ floor: R('admin') }));
    expect(el.querySelector('.bar')!.className).toContain('h3');
    expect(el.querySelector('.floor')!.className).toContain('f3');
  });

  it('renders instance administrator as its own state, not as a rung', () => {
    // It is not "admin everywhere" — it also reaches routes no space can grant, so it must not be
    // indistinguishable from a token that happens to hold area-admin in every space.
    const boss = render(rights({ instanceAdmin: true }));
    const areaAdmin = render(rights({ floor: R('admin') }));
    expect(boss.querySelector('.bar')!.className).toContain('hx');
    expect(areaAdmin.querySelector('.bar')!.className).not.toContain('hx');
  });

  it('every bar carries a readable title, since a bar alone is not self-describing', () => {
    const el = render(rights({ floor: R('read'), perSpace: { qa: R('admin') } }));
    expect(el.querySelector('.bar')!.getAttribute('title')).toBe('knowledge: up to admin, read everywhere');
  });

  it('does not crash on a token with no rights at all', () => {
    const el = render(rights());
    expect(el.querySelectorAll('.bar').length).toBe(RIGHT_AREAS.length);
    expect(el.querySelector('.floor')).toBeNull();
  });
});
