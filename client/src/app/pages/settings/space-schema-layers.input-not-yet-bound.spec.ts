import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { SpaceSchemaLayersComponent } from './space-schema-layers.component';
import { SchemaApi } from '../../core/schema-api.service';
import { ToastService } from '../../core/toast.service';
import { getTranslocoModule } from '../../testing/transloco-testing';

/**
 * Q-508: the panel's effect reads its required `spaceId`, and an effect is scheduled the moment the component is created.
 * Whether the scheduler's next pass comes before the template has bound `spaceId` is a matter of timing: under load the
 * client suite failed at random with Angular's NG0950 (a required input read before it is set). Here the order is fixed:
 * the panel is created, ONE effects pass runs, and only then is `spaceId` bound.
 */
describe('the schema-layers panel when an effects pass runs before its spaceId is bound (Q-508)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads nothing until spaceId is bound, then loads the layers for it once', () => {
    const getSchemaLayers = vi.fn(() => of({ spaceId: 's', own: {}, precedence: [], clashes: [], layers: [] }));
    TestBed.configureTestingModule({
      imports: [SpaceSchemaLayersComponent, getTranslocoModule()],
      providers: [
        { provide: SchemaApi, useValue: { getSchemaLayers, setNetworkPrecedence: vi.fn(), proposeToNetwork: vi.fn() } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(SpaceSchemaLayersComponent);
    expect(() => TestBed.tick(), 'an effects pass before the input is bound threw').not.toThrow();
    expect(getSchemaLayers).not.toHaveBeenCalled();
    fixture.componentRef.setInput('spaceId', 's');
    fixture.detectChanges();
    expect(getSchemaLayers.mock.calls).toEqual([['s']]);
  });
});
