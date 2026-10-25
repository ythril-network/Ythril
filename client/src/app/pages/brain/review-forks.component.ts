import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { ActiveLanguage } from '../../core/active-language';
import { DateFormatService } from '../../core/date-format.service';
import { formatList } from '../../core/list-format';
import { PluralText } from '../../core/plural-text.service';
import { type ForkKeep, type ForkRow, type ForkVersion } from '../../core/forks.types';
import { ModalDirective } from '../../shared/modal.directive';
import { DIALOG_STYLES } from '../settings/dialog.styles';
import { compareForkVersions, fieldSegments, wordDiff, type FieldDifference, type Segment } from './fork-diff';

/** Characters of the discarded text the confirmation quotes: enough to recognise it, short enough to read in a dialog. */
const QUOTE_CHARS = 90;

/**
 * The forks of a space, one hairline row each, with the difference inline (bundle-81, design rev 8 section 5, decisions 19, 41 and 43;
 * mockup layout 3, "Inline difference", chosen by the owner 2026-10-24).
 *
 * A fork is a fact two peers wrote differently at one version; both copies were kept. Each row writes the fact text ONCE, with the words only
 * this version has marked `<ins>` and the words only the other has marked `<del>`, and every other field that differs on a line of marks. The
 * marks are not colour alone: underline and strike carry them, and each starts with the legend's words for a screen reader ("Only in this
 * version" / "Only in the other version"). Both versions stay available whole behind "Show both versions in full".
 *
 * Two actions per fork, "Keep this version" and "Keep the other version", each behind a confirmation that names what is deleted (the other
 * text, and what pointed at the fork, which moves to the parent); nothing is resolved before the confirmation is confirmed. The component only
 * asks: it emits `resolve` and the Review tab does the request. It draws its own focus ring, as the app has no global one (decision 41).
 */
@Component({
  selector: 'app-review-forks',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, TranslocoPipe, ModalDirective],
  styles: [DIALOG_STYLES, `
    :host { display: block; }
    .l3-legend { display: flex; gap: 20px; flex-wrap: wrap; font-size: 12.5px; padding: 0 0 10px; border-bottom: 1px solid var(--border); }
    .l3-list { list-style: none; margin: 0; padding: 0; max-width: 860px; }
    .l3-item { padding: 16px 0; border-bottom: 1px solid var(--border-muted); }
    .l3-h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
    .fk-id { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text-primary); }
    .con-key { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); }
    .fk-type { color: var(--text-secondary); font-family: var(--font-mono); font-size: 11px; }
    .fk-cap { font-size: 11.5px; font-weight: 600; padding: 2px 9px; border-radius: 999px; color: var(--text-muted); background: var(--bg-elevated); border: 1px solid var(--border); white-space: nowrap; }
    .cap-note { margin: 0 0 8px; font-size: 11px; color: var(--warning); }
    .l3-who { display: flex; gap: 4px 24px; flex-wrap: wrap; margin: 0 0 10px; }
    .l3-who > div { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .l3-who dt { font-size: 12.5px; font-weight: 600; color: var(--text-primary); }
    .l3-who dd { font-size: 11.5px; color: var(--text-muted); margin: 0; }
    .l3-text { font-size: 14px; line-height: 1.7; color: var(--text-primary); max-width: 72ch; overflow-wrap: anywhere; margin: 0; }
    .l3-fields { margin: 8px 0 0; display: flex; flex-direction: column; gap: 4px; }
    .l3-f { display: grid; grid-template-columns: 200px 1fr; gap: 10px; align-items: baseline; font-size: 13px; }
    .l3-f dd { overflow-wrap: anywhere; line-height: 1.6; margin: 0; }
    .l3-same { margin: 8px 0 0; font-size: 11.5px; color: var(--text-muted); overflow-wrap: anywhere; }
    .l3-foot { display: flex; align-items: center; gap: 10px 16px; flex-wrap: wrap; margin-top: 12px; }
    .fk-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .fk-pointed { font-size: 12px; color: var(--text-muted); }
    .l3-full { margin-top: 8px; font-size: 12px; color: var(--text-secondary); }
    .l3-full summary { cursor: pointer; width: fit-content; }
    .l3-full > div { margin-top: 8px; max-width: 72ch; }
    .l3-full h4 { font-size: 12.5px; font-weight: 600; color: var(--text-primary); margin: 0; }
    .l3-full p { font-size: 13px; line-height: 1.6; color: var(--text-secondary); overflow-wrap: anywhere; margin: 0; }

    /* Inline marking: words only one side has. Underline and strike carry it as well as colour. */
    ins.ins, del.del { color: var(--text-primary); border-radius: 2px; padding: 0 1px; }
    ins.ins { background: var(--success-bg); text-decoration: underline; text-decoration-color: var(--success); text-underline-offset: 3px; text-decoration-thickness: 2px; }
    del.del { background: var(--error-bg); text-decoration: line-through; text-decoration-color: var(--error); }
    del.del + ins.ins, ins.ins + del.del { margin-left: 5px; }

    /* The confirmation, in the geometry of the app's confirm dialog. */
    .dialog { --dialog-max-width: 440px; background: var(--bg-card); border-radius: 10px; padding: 1.5rem; }
    .dialog h2 { margin: 0 0 0.6rem; font-size: 1.1rem; color: var(--text-primary); }
    .dialog .message { margin: 0 0 1.1rem; color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5; }
    .dialog .message span { display: block; margin-top: 0.8rem; }
    .dialog .actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
    .btn-danger-solid { background: var(--danger); color: #fff; border-color: var(--danger); }
    .btn-danger-solid:not(:disabled):hover { opacity: .9; }

    /* The app has no global focus ring, so the keep actions and the confirmation draw their own (decision 41). */
    .fk-actions button:focus-visible, .dialog button:focus-visible, .l3-full summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    @media (max-width: 560px) {
      .l3-f { grid-template-columns: 1fr; gap: 0; }
      .fk-actions .btn { flex: 1 1 100%; justify-content: center; }
    }
  `],
  template: `
    <ng-template #marks let-segments>
      @for (s of segments; track $index) {
        @switch (s.kind) {
          @case ('ins') {<ins class="ins"><span class="sr-only">{{ 'brain.review.forks.legend.onlyThis' | transloco }}: </span>{{ s.text }}</ins>}
          @case ('del') {<del class="del"><span class="sr-only">{{ 'brain.review.forks.legend.onlyOther' | transloco }}: </span>{{ s.text }}</del>}
          @default {<ng-container>{{ s.text }}</ng-container>}
        }
      }
    </ng-template>

    <div class="l3-legend" role="note">
      <span><ins class="ins">{{ 'brain.review.forks.legend.onlyThis' | transloco }}</ins></span>
      <span><del class="del">{{ 'brain.review.forks.legend.onlyOther' | transloco }}</del></span>
    </div>
    <ul class="l3-list">
      @for (r of rows(); track r.forkId) {
        <li class="l3-item">
          <article [attr.aria-label]="'brain.review.forks.forkOf' | transloco: { id: short(r.forkId) }">
            <header class="l3-h">
              <span class="fk-id" [attr.title]="r.forkId">{{ 'brain.review.forks.forkOf' | transloco: { id: short(r.forkId) } }}</span>
              <span class="fk-type">{{ r.fork.type }}</span>
              @if (capNoteFor(r)) { <span class="fk-cap">{{ 'brain.review.forks.atCap' | transloco: { cap: cap() } }}</span> }
            </header>
            @if (capNoteFor(r)) { <p class="cap-note">{{ 'brain.review.forks.atCapBody' | transloco: { cap: cap() } }}</p> }
            <dl class="l3-who">
              <div><dt>{{ 'brain.review.forks.thisVersion' | transloco }}</dt><dd>{{ written(r.fork) }}</dd></div>
              <div><dt>{{ 'brain.review.forks.otherVersion' | transloco }}</dt><dd>{{ written(r.parent) }}</dd></div>
            </dl>
            <p class="l3-text" data-forks-text><ng-container *ngTemplateOutlet="marks; context: { $implicit: factMarks(r) }"/></p>
            <details class="l3-full">
              <summary>{{ 'brain.review.forks.showBoth' | transloco }}</summary>
              <div><h4>{{ 'brain.review.forks.thisVersion' | transloco }}</h4><p>{{ r.fork.fact }}</p></div>
              <div><h4>{{ 'brain.review.forks.otherVersion' | transloco }}</h4><p>{{ r.parent.fact }}</p></div>
            </details>
            @if (otherFields(r); as fields) {
              @if (fields.length > 0) {
                <dl class="l3-fields">
                  @for (f of fields; track f.key) {
                    <div class="l3-f"><dt class="con-key">{{ f.key }}</dt><dd><ng-container *ngTemplateOutlet="marks; context: { $implicit: fieldMarks(f) }"/></dd></div>
                  }
                </dl>
              }
            }
            @if (sameFields(r); as same) {
              @if (same.length > 0) { <p class="l3-same">{{ 'brain.review.forks.unchanged' | transloco: { fields: same } }}</p> }
            }
            <footer class="l3-foot">
              <div class="fk-actions">
                <button type="button" class="btn btn-sm btn-secondary" [attr.aria-label]="keepLabel(r, 'fork')" (click)="ask(r, 'fork')">{{ 'brain.review.forks.keepThis' | transloco }}</button>
                <button type="button" class="btn btn-sm btn-secondary" [attr.aria-label]="keepLabel(r, 'parent')" (click)="ask(r, 'parent')">{{ 'brain.review.forks.keepOther' | transloco }}</button>
              </div>
              <span class="fk-pointed">{{ pointedAt(r) }}</span>
            </footer>
          </article>
        </li>
      }
    </ul>

    @if (pending(); as p) {
      <div class="dialog-backdrop">
        <div class="dialog" [appModal]="confirmTitle(p)" appModalCloseOnBackdrop (dismiss)="cancel()" (click)="$event.stopPropagation()"
             aria-labelledby="forks-confirm-title" aria-describedby="forks-confirm-message">
          <h2 id="forks-confirm-title">{{ confirmTitle(p) }}</h2>
          <p class="message" id="forks-confirm-message">{{ confirmBody(p) }}<span>{{ confirmDeletes(p) }}</span></p>
          <div class="actions">
            <button type="button" class="btn btn-secondary btn-sm" (click)="cancel()">{{ 'common.cancel' | transloco }}</button>
            <button type="button" class="btn btn-sm btn-danger-solid" (click)="confirm()">{{ keepWord(p.keep) }}</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ReviewForksComponent {
  private readonly transloco = inject(TranslocoService);
  private readonly active = inject(ActiveLanguage);
  private readonly dates = inject(DateFormatService);
  private readonly plural = inject(PluralText);

  /** The forks to show, each beside its parent. */
  readonly rows = input.required<readonly ForkRow[]>();
  /** The most forks one record may hold, as the server's list says it; null when it does not (no "at the limit" notice then). */
  readonly cap = input<number | null>(null);
  /** A confirmation was confirmed: which fork, and which version to keep (`fork` is this version, `parent` the other). */
  readonly resolve = output<{ forkId: string; keep: ForkKeep }>();

  /** The fork whose keep action is awaiting its confirmation. */
  protected readonly pending = signal<{ row: ForkRow; keep: ForkKeep } | null>(null);

  protected short(id: string): string { return id.slice(0, 8); }

  /** One words lookup, in the page's language and recomputed when its words arrive. */
  private tr(key: string, params?: Record<string, unknown>): string {
    this.active.revision();
    return this.transloco.translate(key, params, this.active.language() || undefined);
  }

  /** The parent holds as many forks as it may: said on the first of its forks in the list only, so the notice is not repeated per row. */
  protected capNoteFor(row: ForkRow): boolean {
    const cap = this.cap();
    if (cap === null || row.siblings < cap) return false;
    const first = this.rows().find(r => r.parentId === row.parentId);
    return first?.forkId === row.forkId;
  }

  protected written(v: ForkVersion): string {
    const at = v.updatedAt ?? v.createdAt;
    const when = at ? this.dates.relative(at) : '';
    const instance = v.author?.instanceLabel ?? v.author?.instanceId?.slice(0, 8);
    return instance ? this.tr('brain.review.forks.writtenOn', { instance, when }) : this.tr('brain.review.forks.writtenHere', { when });
  }

  private readonly emptyWords = () => ({ empty: this.tr('brain.review.forks.valueEmpty'), none: this.tr('brain.review.forks.valueNone') });

  protected factMarks(row: ForkRow): Segment[] {
    const fact = compareForkVersions(row.fork, row.parent).fact;
    return fact ? wordDiff(String(fact.a ?? ''), String(fact.b ?? '')) : [{ kind: 'same', text: row.fork.fact }];
  }
  protected otherFields(row: ForkRow): FieldDifference[] { return compareForkVersions(row.fork, row.parent).others; }
  protected fieldMarks(field: FieldDifference): Segment[] { return fieldSegments(field, this.emptyWords()); }
  protected sameFields(row: ForkRow): string { return formatList(compareForkVersions(row.fork, row.parent).same, this.active.language()); }

  /** What points at the fork, said in one sentence: edges, links, both, or nothing. */
  protected pointedAt(row: ForkRow): string {
    const { edgeCount, linkCount } = row;
    if (edgeCount && linkCount) {
      return this.tr('brain.review.forks.pointedAt', {
        edgePhrase: this.plural.text('brain.review.forks.edgeCount', edgeCount),
        linkPhrase: this.plural.text('brain.review.forks.linkCount', linkCount),
      });
    }
    if (edgeCount) return this.plural.text('brain.review.forks.edges', edgeCount);
    if (linkCount) return this.plural.text('brain.review.forks.links', linkCount);
    return this.tr('brain.review.forks.pointedAtNone');
  }

  protected keepWord(keep: ForkKeep): string { return this.tr(keep === 'fork' ? 'brain.review.forks.keepThis' : 'brain.review.forks.keepOther'); }

  /** The button's accessible name: the action, then whose version it keeps. */
  protected keepLabel(row: ForkRow, keep: ForkKeep): string {
    return `${this.keepWord(keep)}, ${this.written(keep === 'fork' ? row.fork : row.parent)}`;
  }

  protected ask(row: ForkRow, keep: ForkKeep): void { this.pending.set({ row, keep }); }
  protected cancel(): void { this.pending.set(null); }
  protected confirm(): void {
    const p = this.pending();
    if (!p) return;
    this.pending.set(null);
    this.resolve.emit({ forkId: p.row.forkId, keep: p.keep });
  }

  protected confirmTitle(p: { keep: ForkKeep }): string {
    return this.tr(p.keep === 'fork' ? 'brain.review.forks.confirm.keepThis.title' : 'brain.review.forks.confirm.keepOther.title');
  }

  /** What the other text becomes: the version that is discarded, quoted, with the other fields that go with it. */
  protected confirmBody(p: { row: ForkRow; keep: ForkKeep }): string {
    const { row, keep } = p;
    const discarded = (keep === 'fork' ? row.parent : row.fork).fact;
    const clipped = discarded.length > QUOTE_CHARS ? `${discarded.slice(0, QUOTE_CHARS - 1).trimEnd()}…` : discarded;
    const others = compareForkVersions(row.fork, row.parent).others.map(f => f.key);
    const extra = others.length ? this.tr('brain.review.forks.confirm.extra', { fields: formatList(others, this.active.language()) }) : '';
    return this.tr(keep === 'fork' ? 'brain.review.forks.confirm.keepThis.body' : 'brain.review.forks.confirm.keepOther.body', { parent: this.short(row.parentId), discarded: clipped, extra });
  }

  /** What else the deletion does: the fork goes, and what pointed at it moves to the parent. */
  protected confirmDeletes(p: { row: ForkRow }): string {
    const { row } = p;
    if (!row.edgeCount && !row.linkCount) return this.tr('brain.review.forks.confirm.deletesNone', { fork: this.short(row.forkId) });
    const parts = [
      ...(row.edgeCount ? [this.plural.text('brain.review.forks.edgeCount', row.edgeCount)] : []),
      ...(row.linkCount ? [this.plural.text('brain.review.forks.linkCount', row.linkCount)] : []),
    ];
    return this.tr('brain.review.forks.confirm.deletes', { fork: this.short(row.forkId), pointed: formatList(parts, this.active.language()), parent: this.short(row.parentId) });
  }
}
