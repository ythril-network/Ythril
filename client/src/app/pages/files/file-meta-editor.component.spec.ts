/**
 * FileMetaEditorComponent — the model is passed through, not copied.
 *
 * ## Why this is the one behaviour worth its own spec
 *
 * `app-entity-ref-field` and its two siblings take a `[target]` object and write their results **straight into
 * it**. So the editor has to hand them the very object it was given. Copying it defensively is the instinct an
 * extraction usually rewards, and here it would make every reference edit vanish on save: the page would still
 * be holding the original, and the request it builds reads from that.
 *
 * Nothing else would notice. The form renders identically, the save fires, the request goes out, and the tags
 * and description — bound through `ngModel` — arrive correctly. Only the three reference fields would be
 * silently empty, and only for a user who edited them.
 */
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import { EntityRefPicker } from '../brain/entity-ref-picker.service';
import { EntityRefFieldComponent } from '../brain/entity-ref-field.component';
import { FactRefFieldComponent } from '../brain/fact-ref-field.component';
import { ChronoRefFieldComponent } from '../brain/chrono-ref-field.component';
import { BrainStore } from '../brain/brain-store.service';
import { FileMetaEditorComponent, type FileMetaModel } from './file-meta-editor.component';

function model(): FileMetaModel {
  return { description: 'd', tags: ['t'], entityIds: 'e1', memoryIds: ['m1'], chronoIds: ['c1'] };
}

function mount(m: FileMetaModel | null) {
  /*
   * The reference widgets inject `EntityRefPicker` NON-optionally, which is why this form is embedded-only:
   * it renders inside the Brain shell, where the picker is provided. The page injects it optionally, because
   * the file manager also runs standalone — so providing it here is not spec scaffolding, it is the runtime
   * condition under which this component is ever shown.
   */
  TestBed.configureTestingModule({
    imports: [FileMetaEditorComponent, getTranslocoModule()],
    providers: [
      EntityRefPicker, BrainStore,
      { provide: BrainApi, useValue: {
        listEntities: () => of({ entities: [] }), getEntitiesByIds: () => of({ entities: [] }),
        listFacts: () => of({ facts: [] }), getMemoriesByIds: () => of({ facts: [] }),
        listChrono: () => of({ chrono: [] }), getChrono: () => of({}),
      } },
    ],
  });
  const fixture = TestBed.createComponent(FileMetaEditorComponent);
  fixture.componentRef.setInput('model', m);
  fixture.detectChanges();
  return fixture;
}

beforeEach(() => TestBed.resetTestingModule());

describe('FileMetaEditorComponent', () => {
  it('renders the three reference fields at all', () => {
    // They are the reason the identity below matters; if the form stopped rendering them, that assertion
    // would go on passing while nothing could write to the model.
    const fixture = mount(model());
    for (const tag of ['app-entity-ref-field', 'app-fact-ref-field', 'app-chrono-ref-field']) {
      expect(fixture.nativeElement.querySelector(tag), `${tag} did not render`).toBeTruthy();
    }
  });

  it('renders nothing at all when there is no model', () => {
    const fixture = mount(null);
    expect(fixture.nativeElement.querySelector('form')).toBeNull();
  });

  it('the reference widgets RECEIVE the object the page passed in, not a copy of it', () => {
    /*
     * Asserted on what the TEMPLATE BINDS, not on the input signal — and that distinction is the whole test.
     *
     * The first version read `componentInstance.model()` and compared it to the object passed in. That is the
     * input, which a copy introduced anywhere downstream leaves untouched: a `computed(() => ({ ...model() }))`
     * bound to `[target]` passed all 84 tests, including this one. The CHANGELOG for #1100 claimed "a spec now
     * fails on exactly that mutation" and the code did not support it.
     *
     * Reaching the widget is what closes it: `[target]` is the only path a reference edit can travel, so the
     * object the widget holds is the only object whose identity matters.
     */
    const m = model();
    const fixture = mount(m);
    for (const cls of [EntityRefFieldComponent, FactRefFieldComponent, ChronoRefFieldComponent]) {
      const widget = fixture.debugElement.query(By.directive(cls));
      expect(widget, `${cls.name} did not render`).toBeTruthy();
      expect(widget.componentInstance.target(), `${cls.name} was handed a COPY, so its edits never reach the page`)
        .toBe(m);
    }
    // And the consequence, stated as a consequence: whatever a widget writes, the page sees.
    (fixture.debugElement.query(By.directive(EntityRefFieldComponent)).componentInstance.target() as FileMetaModel)
      .entityIds = 'e1, e2';
    expect(m.entityIds).toBe('e1, e2');
  });

  it('offers the re-embed button only when the page says the file needs it', () => {
    // A question about the FILE's embedding status, which this component deliberately does not answer itself.
    const fixture = mount(model());
    expect(fixture.nativeElement.textContent).not.toContain('brain.fileMeta.retryEmbedding');
    fixture.componentRef.setInput('canRetryEmbedding', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('brain.fileMeta.retryEmbedding');
  });

  it('disables Save while a save is in flight', () => {
    const fixture = mount(model());
    fixture.componentRef.setInput('saving', true);
    fixture.detectChanges();
    const submit = fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('shows the page\'s error rather than one of its own', () => {
    const fixture = mount(model());
    fixture.componentRef.setInput('error', 'the server said no');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.alert-error')?.textContent).toContain('the server said no');
  });
});
