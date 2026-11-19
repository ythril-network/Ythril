/**
 * The RDF namespaces of the schema library's groups (Q-748, design r4 §4.2): each group with its namespace, and the controls to set, change
 * and remove it.
 *
 * ## What it prevents
 *
 * A namespace names the RDF terms of every space that links a group's schemas, so changing it is a rename those spaces' exports carry from then
 * on. The server refuses that without `rebase` (`rdf_term_rename`, naming the spaces) and refuses a namespace that would give two terms one
 * address (`rdf_term_clash`, naming both terms). This view says each in the reader's language and offers the one choice the first allows:
 * make the rename on purpose. It never retries with `rebase` on its own.
 *
 * Its own component because the library page (`schema-library.component.ts`) is at its size ceiling; the page hosts it on the library tab.
 * Every act has its in-flight, failed and empty state; a draft is held as unsaved edits; a removal asks first.
 */
import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { finalize } from 'rxjs';
import { SchemaApi, type SchemaLibraryGroup } from '../../core/schema-api.service';
import { answerCode, httpErrorReason, refusalText } from '../../core/refusal-text';
import { holdUnsavedEdits } from '../../core/unsaved-edits';
import { PluralText } from '../../core/plural-text.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { PhIconComponent } from '../../shared/ph-icon.component';

/** Where this view's words live: `schemaLib.namespace.<name>`, the refusals of a namespace write under `refusal.<code>`. */
const WORDS = 'schemaLib.namespace.';
/** The family `refusalText` words a refusal of a namespace write from, by its code. */
const NAMESPACE_REFUSAL_PREFIX = 'schemaLib.namespace.refusal';

/** The editor's draft: the group it edits, what the form holds, and whether a rename was refused and may be made on purpose. */
interface NamespaceDraft {
  group: string;
  prefix: string;
  iri: string;
  openedWith: { prefix: string; iri: string };
  saving: boolean;
  error: string;
  /** The server refused the write as a rename of linked terms: the operator may make it on purpose. */
  renameRefused: boolean;
  rebase: boolean;
}

@Component({
  selector: 'app-schema-library-namespace',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, ErrorStateComponent, PhIconComponent],
  styles: [`
    .ns-card { background:var(--bg-surface); border:1px solid var(--border); border-radius:var(--radius-md); padding:14px 16px; margin-bottom:16px; }
    .ns-head { display:flex; align-items:center; gap:8px; margin:0 0 4px; font-size:14px; font-weight:600; color:var(--text-primary); }
    .ns-purpose { font-size:12px; color:var(--text-secondary); margin:0 0 12px; }
    .ns-row { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding:8px 0; border-top:1px solid var(--border); }
    .ns-group { font-weight:600; font-size:13px; color:var(--text-primary); }
    .ns-count { font-size:11px; color:var(--text-muted); margin-left:6px; font-variant-numeric:tabular-nums; }
    .ns-value { font-family:var(--font-mono); font-size:12px; color:var(--text-secondary); word-break:break-all; }
    .ns-none { font-size:12px; color:var(--text-muted); }
    .ns-actions { display:flex; gap:6px; }
    .ns-form { display:grid; gap:10px; padding:10px 0 4px; width:100%; }
    .ns-form label { display:block; font-size:12px; margin-bottom:4px; color:var(--text-secondary); }
    .ns-form input[type=text] { width:100%; }
    .ns-hint { font-size:11px; color:var(--text-muted); margin:4px 0 0; }
    .ns-error { font-size:12px; color:var(--danger); margin:0; }
    .ns-rebase { display:flex; gap:8px; align-items:flex-start; font-size:12px; color:var(--text-primary); }
    .ns-buttons { display:flex; gap:8px; justify-content:flex-end; }
    .ns-empty { font-size:12px; color:var(--text-muted); margin:0; }
  `],
  template: `
    <section class="ns-card" [attr.aria-label]="'schemaLib.namespace.heading' | transloco">
      <h3 class="ns-head"><ph-icon name="globe" [size]="15"/>{{ 'schemaLib.namespace.heading' | transloco }}</h3>
      <p class="ns-purpose">{{ 'schemaLib.namespace.purpose' | transloco }}</p>
      @if (loading()) {
        <p class="ns-empty" role="status"><span class="spinner"></span> {{ 'common.loading' | transloco }}</p>
      } @else if (loadError()) {
        <app-error-state [message]="'schemaLib.namespace.loadFailed' | transloco" [reason]="loadError()" [icon]="28" (retry)="load()"/>
      } @else if (!groups().length) {
        <p class="ns-empty">{{ 'schemaLib.namespace.empty' | transloco }}</p>
      } @else {
        @for (g of groups(); track g.name) {
          <div class="ns-row">
            <div>
              <span class="ns-group">{{ g.name }}</span><span class="ns-count">{{ entryCount(g.count) }}</span>
              <div>
                @if (g.namespace) { <span class="ns-value">{{ g.namespace.prefix }}: {{ g.namespace.iri }}</span> }
                @else { <span class="ns-none">{{ 'schemaLib.namespace.none' | transloco }}</span> }
              </div>
            </div>
            @if (draft()?.group !== g.name) {
              <div class="ns-actions">
                <button class="btn btn-secondary btn-sm" type="button" (click)="open(g)" [disabled]="!!draft() || removing() === g.name">
                  <ph-icon name="pencil-simple" [size]="13"/> {{ (g.namespace ? 'schemaLib.namespace.change' : 'schemaLib.namespace.set') | transloco }}
                </button>
                @if (g.namespace) {
                  <button class="btn btn-danger btn-sm" type="button" (click)="remove(g)" [disabled]="!!draft() || removing() === g.name">
                    <ph-icon name="trash" [size]="13"/> {{ (removing() === g.name ? 'schemaLib.namespace.removing' : 'common.remove') | transloco }}
                  </button>
                }
              </div>
            } @else {
              <form class="ns-form" (ngSubmit)="save()">
                <div>
                  <label [for]="'ns-prefix-' + g.name">{{ 'schemaLib.namespace.prefixLabel' | transloco }}</label>
                  <input type="text" [id]="'ns-prefix-' + g.name" name="prefix" [ngModel]="draft()!.prefix" (ngModelChange)="patch({ prefix: $event })" maxlength="50" autocomplete="off" required />
                </div>
                <div>
                  <label [for]="'ns-iri-' + g.name">{{ 'schemaLib.namespace.iriLabel' | transloco }}</label>
                  <input type="text" [id]="'ns-iri-' + g.name" name="iri" [ngModel]="draft()!.iri" (ngModelChange)="patch({ iri: $event })" maxlength="2000" autocomplete="off" required />
                  <p class="ns-hint">{{ 'schemaLib.namespace.iriHint' | transloco }}</p>
                </div>
                @if (draft()!.error) { <p class="ns-error" role="alert">{{ draft()!.error }}</p> }
                @if (draft()!.renameRefused) {
                  <label class="ns-rebase">
                    <input type="checkbox" name="rebase" [ngModel]="draft()!.rebase" (ngModelChange)="patch({ rebase: $event })" />
                    <span>{{ 'schemaLib.namespace.rebaseChoice' | transloco }}</span>
                  </label>
                }
                <div class="ns-buttons">
                  <button class="btn btn-secondary btn-sm" type="button" (click)="cancel()" [disabled]="draft()!.saving">{{ 'common.cancel' | transloco }}</button>
                  <button class="btn btn-primary btn-sm" type="submit" [disabled]="draft()!.saving || !draft()!.prefix.trim() || !draft()!.iri.trim() || (draft()!.renameRefused && !draft()!.rebase)">
                    {{ (draft()!.saving ? 'common.saving' : 'common.save') | transloco }}
                  </button>
                </div>
              </form>
            }
          </div>
        }
      }
    </section>
  `,
})
export class SchemaLibraryNamespaceComponent implements OnInit {
  private readonly schemaApi = inject(SchemaApi);
  private readonly transloco = inject(TranslocoService);
  private readonly plural = inject(PluralText);
  private readonly toast = inject(ToastService);
  private readonly confirmDialog = inject(ConfirmDialogService);

  readonly groups = signal<SchemaLibraryGroup[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal('');
  readonly draft = signal<NamespaceDraft | null>(null);
  /** The group whose namespace is being removed, while the request runs. */
  readonly removing = signal<string | null>(null);

  private readonly held = holdUnsavedEdits(() => {
    const d = this.draft();
    return !!d && (d.prefix !== d.openedWith.prefix || d.iri !== d.openedWith.iri);
  });

  ngOnInit(): void { this.load(); }

  /** Read the groups and their namespaces. */
  load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.schemaApi.getSchemaLibraryGroups().pipe(finalize(() => this.loading.set(false))).subscribe({
      next: (r) => this.groups.set(r.groups ?? []),
      error: (err: unknown) => this.loadError.set(httpErrorReason(err)),
    });
  }

  /** "3 schemas" beside a group, in the reader's plural form. */
  entryCount(count: number): string {
    return this.plural.text('schemaLib.namespace.entries', count);
  }

  /** Open the editor for `g`, with what it holds. */
  open(g: SchemaLibraryGroup): void {
    const prefix = g.namespace?.prefix ?? '';
    const iri = g.namespace?.iri ?? '';
    this.draft.set({ group: g.name, prefix, iri, openedWith: { prefix, iri }, saving: false, error: '', renameRefused: false, rebase: false });
  }

  /** Change fields of the draft through its signal (the client is zoneless: an in-place edit is a change nothing sees). */
  patch(change: Partial<Pick<NamespaceDraft, 'prefix' | 'iri' | 'rebase'>>): void {
    this.draft.update(d => (d ? { ...d, ...change } : d));
  }

  /** Close the editor, asking first when the draft holds a change. */
  cancel(): void {
    void this.held.closeIfConfirmed(() => this.draft.set(null));
  }

  /** Store the draft; a rename the server refuses is offered as a choice, never retried on its own. */
  save(): void {
    const d = this.draft();
    if (!d || d.saving) return;
    this.draft.set({ ...d, saving: true, error: '' });
    const body = { prefix: d.prefix.trim(), iri: d.iri.trim(), ...(d.rebase ? { rebase: true as const } : {}) };
    this.schemaApi.setGroupNamespace(d.group, body).subscribe({
      next: (r) => {
        this.groups.update(gs => gs.map(g => (g.name === r.group ? { ...g, namespace: r.namespace } : g)));
        this.draft.set(null);
        this.toast.success(this.transloco.translate(`${WORDS}saved`));
      },
      error: (err) => {
        const current = this.draft();
        if (!current) return;
        const renameRefused = answerCode(err) === 'rdf_term_rename';
        this.draft.set({
          ...current, saving: false, renameRefused: current.renameRefused || renameRefused,
          error: refusalText(this.transloco, err, `${WORDS}saveFailed`, NAMESPACE_REFUSAL_PREFIX),
        });
      },
    });
  }

  /** Remove `g`'s namespace after asking; a refused rename is asked again as the choice to make it on purpose. */
  async remove(g: SchemaLibraryGroup, rebase = false): Promise<void> {
    const asked = await this.confirmDialog.confirm({
      title: this.transloco.translate(rebase ? 'schemaLib.namespace.removeRebaseTitle' : 'schemaLib.namespace.removeTitle', { group: g.name }),
      message: this.transloco.translate(rebase ? 'schemaLib.namespace.removeRebaseMessage' : 'schemaLib.namespace.removeMessage'),
      confirmLabel: this.transloco.translate('common.remove'),
      danger: true,
    });
    if (!asked) return;
    this.removing.set(g.name);
    this.schemaApi.removeGroupNamespace(g.name, rebase).pipe(finalize(() => this.removing.set(null))).subscribe({
      next: () => {
        this.groups.update(gs => gs.map(x => (x.name === g.name ? { name: x.name, count: x.count } : x)));
        this.toast.success(this.transloco.translate(`${WORDS}removed`));
      },
      error: (err) => {
        this.toast.error(refusalText(this.transloco, err, `${WORDS}removeFailed`, NAMESPACE_REFUSAL_PREFIX));
        if (!rebase && answerCode(err) === 'rdf_term_rename') void this.remove(g, true);
      },
    });
  }
}
