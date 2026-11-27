/**
 * "Export RDF" with its format, beside "Export JSON" on the space's Schema tab (Q-942, layout D): the schema as an OWL ontology with SHACL
 * shapes (`GET /api/spaces/:id/schema-rdf?format=turtle|jsonld`), saved as the file the server names.
 *
 * Its own component, so the Schema tab (over its size ceiling) carries one element for it.
 *
 * ## What it prevents
 *
 * - **A button that can only be refused.** With RDF names off the export cannot answer (`rdf_not_enabled`): the button and its format are
 *   disabled, and the line below says why and links to the RDF names card on the Settings tab.
 * - **A refusal in the server's English.** A refused export (a contested base, a term clash, an address no document can carry) is worded
 *   by `rdf-refusal.ts` in the reader's language, on the line below the toolbar.
 * - **The stored schema mistaken for the edited one.** The export reads the SAVED schema; with unsaved edits the line says so.
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { SpaceSettingsState } from './space-settings-state.service';
import { RdfExportRuns } from '../../core/rdf-export-runs.service';
import { valueOfEvent } from '../../core/event-value';
import { RDF_SCHEMA_FORMATS, rdfIsOn, type RdfSchemaFormat } from '../../core/rdf-names';
import { rdfRefusalText } from '../../core/rdf-refusal';

@Component({
  selector: 'app-schema-rdf-export',
  standalone: true,
  imports: [TranslocoPipe, PhIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: contents; }
    .btn-join { display: inline-flex; align-items: stretch; }
    .btn-join .btn { border-top-right-radius: 0; border-bottom-right-radius: 0; }
    .btn-join select { border-top-left-radius: 0; border-bottom-left-radius: 0; border-left: 0; width: auto; padding: 0 8px; font-size: 12px; }
    /* The toolbar wraps; the line goes last, under every button (order), as one line of its own (basis). */
    .sch-hint { flex-basis: 100%; order: 99; margin: 0; font-size: 12px; color: var(--text-muted); }
    .sch-hint.err { color: var(--error); }
    .linkish { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font: inherit; text-decoration: underline; }
  `],
  template: `
<span class="btn-join">
  <button class="btn btn-secondary btn-sm" type="button" data-testid="schema-rdf-export" [disabled]="!on() || saving()"
    [attr.aria-describedby]="on() ? 'schema-rdf-hint' : 'schema-rdf-off'" (click)="save()">
    <ph-icon name="upload" [size]="13" style="margin-right:5px;"/>{{ 'rdf.schema.export' | transloco }}</button>
  <label class="sr-only" for="schema-rdf-format">{{ 'rdf.schema.formatLabel' | transloco }}</label>
  <select id="schema-rdf-format" data-testid="schema-rdf-format" [disabled]="!on() || saving()" (change)="format.set(valueOf($event))">
    @for (f of formats; track f) { <option [value]="f" [selected]="f === format()">{{ 'rdf.format.' + f | transloco }}</option> }
  </select>
</span>
@if (refusal()) {
  <p class="sch-hint err" role="alert" data-testid="schema-rdf-refusal">{{ refusal() }}</p>
} @else if (!on()) {
  <p class="sch-hint" id="schema-rdf-off" data-testid="schema-rdf-off">{{ 'rdf.schema.off' | transloco }}
    <button type="button" class="linkish" data-testid="schema-rdf-open-names" (click)="openNames()">{{ 'rdf.schema.offLink' | transloco }}</button></p>
} @else {
  <p class="sch-hint" id="schema-rdf-hint">{{ 'rdf.schema.hint' | transloco }}</p>
}
  `,
})
export class SchemaRdfExportComponent {
  private readonly state = inject(SpaceSettingsState);
  private readonly runs = inject(RdfExportRuns);
  private readonly transloco = inject(TranslocoService);

  readonly formats = RDF_SCHEMA_FORMATS;
  readonly format = signal<RdfSchemaFormat>('turtle');
  readonly saving = signal(false);
  readonly refusal = signal('');
  /** RDF names as STORED: the export reads the saved setting, so a switch not yet saved does not enable it. */
  readonly on = computed(() => { this.state.settingsSpace(); return rdfIsOn(this.state.rdfStored); });

  async save(): Promise<void> {
    const id = this.state.settingsSpace()?.id;
    if (!id || !this.on()) return;
    this.saving.set(true);
    this.refusal.set('');
    try {
      const refused = await this.runs.saveSchema(id, this.format());
      if (refused) this.refusal.set(rdfRefusalText(this.transloco, refused));
    } finally {
      this.saving.set(false);
    }
  }

  /** The Settings tab, with the RDF names card in view. */
  openNames(): void {
    this.state.showRdfNames();
  }

  /** The chosen format of the select; its options are this component's own. */
  readonly valueOf = valueOfEvent<RdfSchemaFormat>;
}
