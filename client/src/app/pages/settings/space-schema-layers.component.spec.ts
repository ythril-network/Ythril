import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { provideTransloco } from '@jsverse/transloco';
import { SpaceSchemaLayersComponent, proposalFor } from './space-schema-layers.component';
import { SchemaApi, type SchemaLayersView } from '../../core/schema-api.service';
import { ToastService } from '../../core/toast.service';

/**
 * The Schema tab's network layers panel (F-39.3): nothing for a space no network sends schema to, and the order it
 * saves is the order shown after the arrows.
 */
const view = (over: Partial<SchemaLayersView> = {}): SchemaLayersView => ({
  spaceId: 's', own: {}, precedence: ['a', 'b'], clashes: [],
  layers: [{ networkId: 'a', networkLabel: 'Alpha', meta: {} }, { networkId: 'b', networkLabel: 'Beta', meta: {} }],
  ...over,
});

let api: { getSchemaLayers: ReturnType<typeof vi.fn>; setNetworkPrecedence: ReturnType<typeof vi.fn>; proposeToNetwork: ReturnType<typeof vi.fn> };

function mount(v: SchemaLayersView) {
  api = { getSchemaLayers: vi.fn(() => of(v)), setNetworkPrecedence: vi.fn((_id: string, n: string[]) => of(view({ precedence: n }))), proposeToNetwork: vi.fn(() => of({})) };
  TestBed.configureTestingModule({
    imports: [SpaceSchemaLayersComponent],
    providers: [
      provideTransloco({ config: { availableLangs: ['en'], defaultLang: 'en' } }),
      { provide: SchemaApi, useValue: api },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
    ],
  });
  const f = TestBed.createComponent(SpaceSchemaLayersComponent);
  f.componentRef.setInput('spaceId', 's');
  f.detectChanges();
  return f;
}

describe('SpaceSchemaLayersComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders nothing for a space with no network layer', () => {
    const f = mount(view({ layers: [], precedence: [] }));
    expect((f.nativeElement as HTMLElement).textContent?.trim()).toBe('');
  });

  it('moving a network down and saving sends the new order', () => {
    const f = mount(view());
    f.componentInstance.move(0, 1);
    expect(f.componentInstance.order()).toEqual(['b', 'a']);
    f.componentInstance.save();
    expect(api.setNetworkPrecedence).toHaveBeenCalledWith('s', ['b', 'a']);
  });

  it('names a clash by where it is', () => {
    const f = mount(view());
    expect(f.componentInstance.where({ kind: 'entity', type: 'person', property: 'tier', values: [] })).toBe('entity person.tier');
    expect(f.componentInstance.where({ field: 'purpose', values: [] })).toBe('purpose');
  });

  // F-39.5: a clash is settled by proposing what applies here to the network holding the other definition.
  it('a proposal carries the target network\'s whole type with only the clashing property swapped in', () => {
    const target = { typeSchemas: { entity: { person: { namingPattern: '^P', propertySchemas: { tier: { type: 'string' }, age: { type: 'number' } } } } } };
    const c = { kind: 'entity', type: 'person', property: 'tier', values: [{ networkId: 'a', value: { type: 'number' } }, { networkId: 'b', value: { type: 'string' } }] };
    expect(proposalFor(c, target)).toEqual({ typeSchemas: { entity: { person: {
      namingPattern: '^P', propertySchemas: { tier: { type: 'number' }, age: { type: 'number' } } } } } });
  });

  it('a type-field or top-level clash proposes just that value', () => {
    const tf = { kind: 'entity', type: 'person', typeField: 'namingPattern', values: [{ networkId: 'a', value: '^A' }, { networkId: 'b', value: '^B' }] };
    expect(proposalFor(tf, {})).toEqual({ typeSchemas: { entity: { person: { namingPattern: '^A' } } } });
    expect(proposalFor({ field: 'purpose', values: [{ networkId: 'a', value: 'x' }, { networkId: 'b', value: 'y' }] }, {})).toEqual({ purpose: 'x' });
  });

  it('propose sends it to the losing network only', () => {
    const c = { kind: 'entity', type: 'person', property: 'tier', values: [{ networkId: 'a', value: { type: 'number' } }, { networkId: 'b', value: { type: 'string' } }] };
    const f = mount(view({ clashes: [c] }));
    f.componentInstance.propose(c, 'b');
    expect(api.proposeToNetwork).toHaveBeenCalledWith('s', 'b', { typeSchemas: { entity: { person: { propertySchemas: { tier: { type: 'number' } } } } } });
  });
});
