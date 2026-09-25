import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { provideTransloco } from '@jsverse/transloco';
import { SpaceSchemaLayersComponent } from './space-schema-layers.component';
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

let api: { getSchemaLayers: ReturnType<typeof vi.fn>; setNetworkPrecedence: ReturnType<typeof vi.fn> };

function mount(v: SchemaLayersView) {
  api = { getSchemaLayers: vi.fn(() => of(v)), setNetworkPrecedence: vi.fn((_id: string, n: string[]) => of(view({ precedence: n }))) };
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
});
