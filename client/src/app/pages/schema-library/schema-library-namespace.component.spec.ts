/**
 * The schema groups' RDF namespaces on the library page (Q-748, design r4 §4.2): every act's in-flight, failed and empty state; the two RDF
 * refusals worded with what they name; the rename offered as a choice the operator makes, never retried on its own; a removal that asks first.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { of, throwError, Subject } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SchemaApi } from '../../core/schema-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { SchemaLibraryNamespaceComponent } from './schema-library-namespace.component';

const WORDS = {
  'schemaLib.namespace.refusal.rdf_term_rename': 'RENAME {{spaces}}',
  'schemaLib.namespace.refusal.rdf_term_clash': 'CLASH {{space}} {{terms}} {{iri}}',
  'schemaLib.namespace.entries.one': '{{count}} schema',
  'schemaLib.namespace.entries.other': '{{count}} schemas',
};
const GROUPS = [
  { name: 'acme', count: 2, namespace: { prefix: 'acme', iri: 'https://acme.example/ns/' } },
  { name: 'beta', count: 1 },
];
const refused = (body: Record<string, unknown>) => throwError(() => new HttpErrorResponse({ status: 409, error: body }));

function mount(api: Record<string, unknown>, confirm = vi.fn(async () => true)) {
  TestBed.resetTestingModule();
  const toast = { show: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() };
  TestBed.configureTestingModule({
    imports: [SchemaLibraryNamespaceComponent, getTranslocoModule({ translation: { en: WORDS } })],
    providers: [
      { provide: SchemaApi, useValue: { getSchemaLibraryGroups: () => of({ groups: structuredClone(GROUPS) }), ...api } },
      { provide: ToastService, useValue: toast },
      { provide: ConfirmDialogService, useValue: { confirm } },
    ],
  });
  const fixture = TestBed.createComponent(SchemaLibraryNamespaceComponent);
  fixture.detectChanges();
  return { fixture, c: fixture.componentInstance, el: fixture.nativeElement as HTMLElement, toast, confirm };
}

describe('the schema groups\' RDF namespaces', () => {
  it('shows a loading state, then each group with its namespace or none', () => {
    const answer = new Subject<{ groups: typeof GROUPS }>();
    const { fixture, el } = mount({ getSchemaLibraryGroups: () => answer });
    expect(el.querySelector('[role=status]')).not.toBeNull();
    answer.next({ groups: structuredClone(GROUPS) });
    answer.complete();
    fixture.detectChanges();
    expect(el.textContent).toContain('acme: https://acme.example/ns/');
    expect(el.textContent).toContain('schemaLib.namespace.none');
  });

  it('a failed load says so and retries', () => {
    let calls = 0;
    const { fixture, el } = mount({ getSchemaLibraryGroups: () => (++calls === 1 ? throwError(() => new HttpErrorResponse({ status: 500 })) : of({ groups: GROUPS })) });
    expect(el.querySelector('app-error-state')).not.toBeNull();
    (el.querySelector('app-error-state button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(calls).toBe(2);
    expect(el.querySelector('app-error-state')).toBeNull();
  });

  it('no group is an empty state', () => {
    const { el } = mount({ getSchemaLibraryGroups: () => of({ groups: [] }) });
    expect(el.textContent).toContain('schemaLib.namespace.empty');
  });

  it('saves a namespace and shows it', () => {
    const setGroupNamespace = vi.fn(() => of({ group: 'beta', namespace: { prefix: 'beta', iri: 'https://beta.example/ns/' } }));
    const { fixture, c, el, toast } = mount({ setGroupNamespace });
    c.open(GROUPS[1]!);
    c.draft()!.prefix = 'beta';
    c.draft()!.iri = 'https://beta.example/ns/';
    c.save();
    fixture.detectChanges();
    expect(setGroupNamespace).toHaveBeenCalledWith('beta', { prefix: 'beta', iri: 'https://beta.example/ns/' });
    expect(el.textContent).toContain('beta: https://beta.example/ns/');
    expect(toast.success).toHaveBeenCalled();
  });

  it('a refused rename names the spaces and is offered as a choice; it is sent with rebase only once chosen', () => {
    const setGroupNamespace = vi.fn()
      .mockReturnValueOnce(refused({ code: 'rdf_term_rename', spaces: ['research', 'notes'], error: 'renames' }))
      .mockReturnValueOnce(of({ group: 'acme', namespace: { prefix: 'acme', iri: 'https://acme.example/v2/' } }));
    const { fixture, c, el } = mount({ setGroupNamespace });
    c.open(GROUPS[0]!);
    c.draft()!.iri = 'https://acme.example/v2/';
    c.save();
    fixture.detectChanges();
    expect(setGroupNamespace).toHaveBeenCalledTimes(1);
    expect(c.draft()!.error).toContain('RENAME');
    expect(c.draft()!.error).toContain('research');
    expect(c.draft()!.error).toContain('notes');
    const submit = el.querySelector('button[type=submit]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(el.querySelector('input[type=checkbox]')).not.toBeNull();
    c.draft()!.rebase = true;
    fixture.detectChanges();
    c.save();
    expect(setGroupNamespace).toHaveBeenLastCalledWith('acme', { prefix: 'acme', iri: 'https://acme.example/v2/', rebase: true });
  });

  it('a clash names the space, both terms and the address', () => {
    const setGroupNamespace = vi.fn(() => refused({ code: 'rdf_term_clash', space: 'linked', terms: ['entity:person', 'entity:human'], iri: 'https://acme.example/ns/entity/person', error: 'clash' }));
    const { c } = mount({ setGroupNamespace });
    c.open(GROUPS[1]!);
    c.draft()!.prefix = 'beta';
    c.draft()!.iri = 'https://acme.example/ns/';
    c.save();
    const said = c.draft()!.error;
    expect(said).toContain('CLASH linked');
    expect(said).toContain('entity:person');
    expect(said).toContain('entity:human');
    expect(said).toContain('https://acme.example/ns/entity/person');
    expect(c.draft()!.renameRefused).toBe(false);
  });

  it('a removal asks first; a refused rename asks again to make it on purpose', async () => {
    const removeGroupNamespace = vi.fn()
      .mockReturnValueOnce(refused({ code: 'rdf_term_rename', spaces: ['research'], error: 'renames' }))
      .mockReturnValueOnce(of({ group: 'acme', removed: true }));
    const confirm = vi.fn(async () => true);
    const { fixture, c, el } = mount({ removeGroupNamespace }, confirm);
    await c.remove(GROUPS[0]!);
    await new Promise(r => setTimeout(r, 0));
    fixture.detectChanges();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(removeGroupNamespace).toHaveBeenNthCalledWith(1, 'acme', false);
    expect(removeGroupNamespace).toHaveBeenNthCalledWith(2, 'acme', true);
    expect(el.textContent).not.toContain('acme: https://acme.example/ns/');
  });

  it('a removal declined sends nothing', async () => {
    const removeGroupNamespace = vi.fn();
    const { c } = mount({ removeGroupNamespace }, vi.fn(async () => false));
    await c.remove(GROUPS[0]!);
    expect(removeGroupNamespace).not.toHaveBeenCalled();
  });

  it('every field has a label, and every button says what it is', () => {
    const { fixture, c, el } = mount({});
    c.open(GROUPS[1]!);
    fixture.detectChanges();
    for (const input of Array.from(el.querySelectorAll('input[type=text]'))) {
      expect(el.querySelector(`label[for="${input.id}"]`), `no label for ${input.id}`).not.toBeNull();
    }
    for (const b of Array.from(el.querySelectorAll('button'))) expect(['button', 'submit']).toContain(b.getAttribute('type'));
  });
});
