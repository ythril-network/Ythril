/**
 * The "RDF export" panel of a space's and a personal view's Overview (Q-942, layout D): the records as one RDF file, with the format and how
 * edge details are written, the running state, and what the finished export left out.
 *
 * It sits in the Overview's own panel grid with the Indexing panel's header, pill slot and span rule; the run is kept by `RdfExportRuns`
 * (a root service), so leaving the tab keeps it going and coming back shows it.
 *
 * ## What it prevents
 *
 * - **An export that can only be refused.** A space with RDF names off, or a view none of whose member spaces has them, shows no export:
 *   it says why and offers "Open RDF names" for each space concerned.
 * - **A format the scope cannot carry.** A view of several spaces is offered TriG, N-Quads and JSON-LD only (Turtle holds one graph), and
 *   JSON-LD carries edge details only in the classic form, so the edge choice is locked to it there.
 * - **A format changed under a running export.** The fields are disabled while it runs; the run line says it keeps going on other tabs.
 * - **Values left out silently.** A finished export names the count and the values the file names (at most 100), each reason in the
 *   reader's language, and the member spaces a view's export left out.
 * - **A refusal in the server's English.** A refused start ("two exports already run") is worded by `rdf-refusal.ts`, beside the previous
 *   result, which stays.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import type { Space } from '../../core/api.types';
import { RdfExportRuns, megabytes, type RdfExportRun } from '../../core/rdf-export-runs.service';
import { RDF_SPACE_FORMATS, RDF_VIEW_FORMATS, rdfIsOn, type RdfEdgeDetails, type RdfRecordFormat } from '../../core/rdf-names';
import { rdfRefusalText } from '../../core/rdf-refusal';


@Component({
  selector: 'app-rdf-export-panel',
  standalone: true,
  imports: [TranslocoPipe, PhIconComponent, StatusPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.span-all]': 'wide()', '[class.span-2]': '!wide() && isView()', class: 'panel', role: 'region', '[attr.aria-labelledby]': '"rdf-export-h"', 'data-testid': 'rdf-export-panel' },
  styles: [`
    :host { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; }
    :host(.span-all) { grid-column: 1 / -1; }
    @media (min-width: 900px) { :host(.span-2) { grid-column: span 2; } }
    .panel-h { display: flex; align-items: center; gap: 9px; padding: 13px 16px; border-bottom: 1px solid var(--border); }
    .panel-h .ic { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; flex: none; background: var(--bg-elevated, var(--bg-primary)); color: var(--accent); }
    .panel-h .tt { flex: 1; min-width: 0; }
    .panel-h h3 { margin: 0; font-size: 14px; font-weight: 620; }
    .panel-h p { margin: 1px 0 0; font-size: 12px; color: var(--text-secondary); line-height: 1.35; }
    .panel-b { padding: 14px 16px; flex: 1; display: flex; flex-direction: column; gap: 12px; }
    .fields { display: flex; flex-wrap: wrap; gap: 12px; }
    .field { flex: 1 1 180px; margin: 0; }
    .field label { display: block; font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: 5px; }
    .go { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .reason { font-size: 12px; color: var(--text-muted); }
    .run-line { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 13px; }
    .track { height: 6px; border-radius: 3px; background: var(--bg-elevated, var(--border)); overflow: hidden; margin-top: 6px; }
    .track i { display: block; height: 100%; width: 35%; background: var(--accent); }
    .sep { border-top: 1px solid var(--border); padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
    .result { margin: 0; font-size: 13px; }
    .lo-h { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; font-size: 13px; }
    .scrollbox { max-height: 280px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
    table.leftout { width: 100%; border-collapse: collapse; font-size: 12px; }
    table.leftout th, table.leftout td { text-align: left; padding: 6px 8px; border-top: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
    table.leftout th { color: var(--text-secondary); font-weight: 500; border-top: 0; }
    .member-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .member-list li { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; }
    .why { color: var(--text-muted); font-size: 12px; }
    @media (max-width: 560px) {
      table.leftout thead { display: none; }
      table.leftout tr { display: block; padding: 6px 0; border-top: 1px solid var(--border); }
      table.leftout td { display: block; border: 0; padding: 2px 8px; }
    }
  `],
  template: `
<header class="panel-h">
  <span class="ic"><ph-icon name="file" [size]="16"/></span>
  <div class="tt"><h3 id="rdf-export-h">{{ 'rdf.export.title' | transloco }}</h3>
    <p>{{ (isView() ? 'rdf.export.whatView' : 'rdf.export.whatSpace') | transloco: { name: label() } }}</p></div>
  @if (run()?.running) { <app-status-pill variant="pending" [dot]="true" data-testid="rdf-export-pill">{{ 'rdf.export.pill.running' | transloco }}</app-status-pill> }
  @else if (run()?.result) { <app-status-pill variant="active" [dot]="true" data-testid="rdf-export-pill">{{ 'rdf.export.pill.saved' | transloco }}</app-status-pill> }
</header>
<div class="panel-b">
  @if (exportable().length === 0) {
    <p style="margin:0;font-size:13px" data-testid="rdf-export-empty">{{ (isView() ? 'rdf.export.emptyView' : 'rdf.export.offSpace') | transloco: { name: label() } }}</p>
    <ul class="member-list">
      @for (m of members(); track m.id) {
        <li><span><b>{{ m.label }}</b> <span class="why">{{ 'rdf.export.whyOff' | transloco }}</span></span>
          <button class="btn btn-secondary btn-sm" type="button" data-testid="rdf-export-open-names" (click)="openNames.emit(m)">{{ 'rdf.export.openNames' | transloco }}</button></li>
      }
    </ul>
  } @else {
    <div class="fields">
      <div class="field"><label for="rdf-export-format">{{ 'rdf.export.format' | transloco }}</label>
        <select id="rdf-export-format" data-testid="rdf-export-format" [disabled]="!!run()?.running" (change)="format.set(valueOf($event))">
          @for (f of formats(); track f) { <option [value]="f" [selected]="f === chosenFormat()">{{ 'rdf.format.' + f | transloco }}</option> }
        </select></div>
      <div class="field"><label for="rdf-export-edges">{{ 'rdf.export.edges' | transloco }}</label>
        <select id="rdf-export-edges" data-testid="rdf-export-edges" [disabled]="!!run()?.running || chosenFormat() === 'jsonld'" (change)="edgeChoice.set(valueOf($event))">
          <option value="rdf12" [selected]="edges() === 'rdf12'">{{ 'rdf.export.edge.rdf12' | transloco }}</option>
          <option value="reification" [selected]="edges() === 'reification'">{{ 'rdf.export.edge.reification' | transloco }}</option>
        </select></div>
    </div>
    @if (run()?.running) {
      <div role="status" data-testid="rdf-export-running">
        <div class="run-line"><span>{{ 'rdf.export.exporting' | transloco: { file: run()!.file } }}</span><span>{{ 'rdf.export.soFar' | transloco: { mb: mbOf(run()!.bytes) } }}</span></div>
        <div class="track" role="progressbar" [attr.aria-label]="'rdf.export.exporting' | transloco: { file: run()!.file }" [attr.aria-valuetext]="'rdf.export.soFar' | transloco: { mb: mbOf(run()!.bytes) }"><i></i></div>
      </div>
      <div class="go"><button class="btn btn-secondary btn-sm" type="button" data-testid="rdf-export-stop" (click)="runs.stop(subjectId())">{{ 'rdf.export.stop' | transloco }}</button>
        <span class="reason">{{ 'rdf.export.keepsRunning' | transloco }}</span></div>
    } @else {
      <div class="go"><button class="btn btn-primary btn-sm" type="button" data-testid="rdf-export-go" (click)="start()">{{ (run()?.result ? 'rdf.export.again' : 'rdf.export.go') | transloco }}</button>
        <span class="reason">{{ (isView() ? 'rdf.export.savesView' : 'rdf.export.saves') | transloco }}</span></div>
    }
    @if (failure()) { <div class="alert alert-error" role="alert" data-testid="rdf-export-refusal">{{ failure() }}</div> }
    @if (run()?.result; as r) {
      <div class="sep">
        <p class="result" role="status" data-testid="rdf-export-result">{{ 'rdf.export.result' | transloco: { file: r.file, records: r.records, mb: mbOf(r.bytes) } }}</p>
        @if (r.withoutRdf.length || r.inConflict.length) {
          <div data-testid="rdf-export-members-left">
            <b style="font-size:13px">{{ 'rdf.export.membersLeft' | transloco: { n: r.withoutRdf.length + r.inConflict.length } }}</b>
            <ul class="member-list" style="margin-top:6px">
              @for (m of r.withoutRdf; track m) { <li><span>{{ labelOf(m) }}</span><span class="why">{{ 'rdf.export.whyOff' | transloco }}</span></li> }
              @for (m of r.inConflict; track m) { <li><span>{{ labelOf(m) }}</span><span class="why">{{ 'rdf.export.whyConflict' | transloco }}</span></li> }
            </ul>
          </div>
        }
        @if (r.leftOutCount > 0) {
          <div class="lo-h"><b id="rdf-lo-h" data-testid="rdf-export-left-count">{{ 'rdf.export.leftOut' | transloco: { n: r.leftOutCount } }}</b>
            <span class="reason">{{ (r.leftOutCount > r.leftOut.length ? 'rdf.export.leftOutFirst' : 'rdf.export.leftOutRest') | transloco: { named: r.leftOut.length } }}</span></div>
          <div class="scrollbox" tabindex="0" role="region" aria-labelledby="rdf-lo-h">
            <table class="leftout" aria-labelledby="rdf-lo-h" data-testid="rdf-export-left-table">
              <thead><tr><th>{{ 'rdf.export.col.record' | transloco }}</th><th>{{ 'rdf.export.col.property' | transloco }}</th><th>{{ 'rdf.export.col.why' | transloco }}</th></tr></thead>
              <tbody>
                @for (v of r.leftOut; track $index) {
                  <tr><td class="mono">{{ v.record }}</td><td class="mono">{{ v.key }}</td>
                    <td>{{ v.reason === 'other' ? v.reasonText : ('rdf.export.reason.' + v.reason | transloco) }}</td></tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>
    }
  }
</div>
  `,
})
export class RdfExportPanelComponent {
  readonly runs = inject(RdfExportRuns);
  private readonly transloco = inject(TranslocoService);

  /** The space or the caller's own view to export. */
  readonly subjectId = input.required<string>();
  readonly label = input('');
  readonly isView = input(false);
  /** The spaces the export reads: the space itself, or the view's member spaces. */
  readonly members = input<readonly Space[]>([]);
  /** "Open RDF names" for a space: the host opens its settings on the RDF names card. */
  readonly openNames = output<Space>();

  readonly format = signal<RdfRecordFormat | ''>('');
  readonly edgeChoice = signal<RdfEdgeDetails>('rdf12');

  readonly formats = computed<readonly RdfRecordFormat[]>(() => (this.isView() ? RDF_VIEW_FORMATS : RDF_SPACE_FORMATS));
  readonly chosenFormat = computed<RdfRecordFormat>(() => { const f = this.format(); return f && this.formats().includes(f) ? f : this.formats()[0]!; });
  readonly edges = computed<RdfEdgeDetails>(() => (this.chosenFormat() === 'jsonld' ? 'reification' : this.edgeChoice()));
  readonly exportable = computed(() => this.members().filter(m => rdfIsOn(m.meta?.rdf)));
  /** This subject's run; undefined before its first export. */
  readonly run = computed<RdfExportRun | undefined>(() => this.runs.runs()[this.subjectId()]);
  readonly wide = computed(() => !!this.run()?.result);
  /**
   * The last start's failure in words. A method, asked at each render, not a computed: a computed would keep the words of the language it
   * first read, and the page's words may arrive or change after the failure.
   */
  failure(): string {
    const f = this.run()?.failure;
    if (!f) return '';
    return f === 'cut' ? this.transloco.translate('rdf.export.cut') : rdfRefusalText(this.transloco, f);
  }

  mbOf(bytes: number): string { return megabytes(bytes); }

  /** A select's chosen value; the options are this panel's own, so it is one of them. */
  valueOf<T extends string>(e: Event): T { return (e.target as HTMLSelectElement).value as T; }

  labelOf(id: string): string { return this.members().find(m => m.id === id)?.label ?? id; }

  start(): void {
    void this.runs.start(this.subjectId(), this.chosenFormat(), this.edges());
  }
}
