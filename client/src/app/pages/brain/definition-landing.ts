import { DestroyRef, Injector, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { TranslocoService } from '@jsverse/transloco';
import { LatestWins } from '../../core/latest-wins';
import { SchemaApi, type TypeStandingRow } from '../../core/schema-api.service';
import { DateFormatService } from '../../core/date-format.service';
import { definitionSpan, type Words } from '../../core/type-definition-words';
import type { TypedKind } from '../../core/type-field';

/** What the history dialog's Open links put in `definition=` (r4 §5.4): `older`, or `sameAs:` and a 64-hex fingerprint. */
const DEFINITION = /^(older|sameAs:[0-9a-f]{64})$/;

/** The list body's version arguments for a definition filter: `older` asks every change (`any`), as the glyph's rule does. */
export function definitionListArgs(definition: string): { schemaVersion?: string; schemaChanged?: 'any' } {
  if (definition === 'older') return { schemaVersion: 'older', schemaChanged: 'any' };
  return definition ? { schemaVersion: definition } : {};
}

/**
 * The Brain landing of a type's history (Q-744, design r4 §5.4), one per record tab: the deep link's `type` and `definition`, the
 * version arguments the list asks with, the "Type definition" column read with ONE `fps` call per page, and the note an older server
 * that refuses `sameAs:` earns. The four record tabs answer one rule, so it lives here once and each tab only wires it.
 *
 * The link is read once when the tab opens and again when a later navigation brings a different one (an Open link followed from a
 * history dialog opened inside the Brain), and a space change drops it: the same type name can mean different things in two spaces.
 *
 * Collaborators the tab specs of other rules do not provide (the route, the schema reads) are reached lazily and only when a link is
 * set, so a tab mounted without them behaves as it always did.
 */
export class DefinitionLanding {
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute, { optional: true });
  private readonly reads = new LatestWins(inject(DestroyRef));

  /** The definition filter in force: '', `older` or `sameAs:<fp>`. */
  readonly definition = signal('');
  /** The server refused the definition filter (an older one does not know `sameAs:`); the list fell back to the type alone. */
  readonly refused = signal(false);
  /** The page's stamps and how each stands for the type, from the one `fps` read. */
  private readonly standings = signal<ReadonlyMap<string, TypeStandingRow>>(new Map());
  /**
   * The deep-linked type. The entities, facts and chrono tabs move it into their type filter (`takeType`); the edges tab keeps it here,
   * because an edge's type is its label and the edges tab's type filter is the edge's own `type` field (TYPE_FIELD).
   */
  readonly linked = signal('');
  private taken = false;

  /** Whether the list is filtered by a definition: the chips and the column show. */
  readonly active = computed(() => this.definition() !== '');

  /**
   * @param kind the tab's knowledge kind, as the versions door names it
   * @param relanded called when a later navigation brings a new link; the tab applies `takeType()` and reloads from page one
   */
  constructor(private readonly kind: TypedKind, private readonly relanded: () => void) {
    const read = (get: (k: string) => string | null) => {
      const def = get('definition') ?? '';
      return { type: get('type') ?? '', definition: DEFINITION.test(def) ? def : '' };
    };
    const first = this.route ? read(k => this.route!.snapshot.queryParamMap.get(k)) : { type: '', definition: '' };
    this.linked.set(first.type);
    this.definition.set(first.type ? first.definition : '');
    this.route?.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(map => {
      const next = read(k => map.get(k));
      if (!next.type || !next.definition || (next.definition === this.definition() && next.type === this.linked())) return;
      this.linked.set(next.type);
      this.taken = false;
      this.definition.set(next.definition);
      this.refused.set(false);
      this.relanded();
    });
  }

  /**
   * The type the tab's filter starts with: the linked one on the tab's first load, '' after, so a space change drops the link (the
   * definition with it).
   */
  takeType(): string {
    if (this.taken) { this.clear(); this.linked.set(''); return ''; }
    this.taken = true;
    return this.linked();
  }

  /** The chip's ✕, or the type chip's: no definition filter any more. */
  clear(): void {
    this.definition.set('');
    this.refused.set(false);
    this.standings.set(new Map());
    this.reads.cancel();
  }

  /** The list body's version arguments. */
  listArgs(): { schemaVersion?: string; schemaChanged?: 'any' } {
    return definitionListArgs(this.definition());
  }

  /** A failed list read: a 400 under a definition filter is an older server refusing it. The filter goes, the note shows. */
  refuse(err: unknown): boolean {
    if (!this.active() || (err as { status?: unknown } | null)?.status !== 400) return false;
    this.clear();
    this.refused.set(true);
    return true;
  }

  /**
   * The page's rows arrived: ask how their stamps stand for `type`, all of them in ONE read (r4 §5.3). Unstamped rows ask nothing
   * (they read "No version"); under `sameAs:` the definition's own version rides along, so the chip can say its span.
   */
  readColumn(spaceId: string, type: string, records: readonly object[]): void {
    this.standings.set(new Map());
    if (!this.active() || !type) { this.reads.cancel(); return; }
    const fps = new Set<string>();
    for (const r of records) { const fp = (r as { schemaFingerprint?: unknown }).schemaFingerprint; if (typeof fp === 'string' && fp) fps.add(fp); }
    const rep = this.sameAsRep();
    if (rep) fps.add(rep);
    if (!fps.size) { this.reads.cancel(); return; }
    let api: SchemaApi;
    try { api = this.injector.get(SchemaApi); } catch { return; }
    this.reads.run(api.typeStandings(spaceId, this.kind, type, [...fps]), {
      next: r => { if (r.supported) this.standings.set(new Map(r.answer.standings.map(s => [s.fp, s]))); },
      // The column is an aid to the list; failing, its cells stay empty and the list stands.
      error: () => this.standings.set(new Map()),
    });
  }

  /** A row's cell: its definition's span, "Cannot tell", or "No version" for a row with no stamp; null until the read answers. */
  cell(record: object): Words | null {
    const fp = (record as { schemaFingerprint?: unknown }).schemaFingerprint;
    if (typeof fp !== 'string' || !fp) return { key: 'brain.drawer.typeDefinition.none', params: {} };
    const s = this.standings().get(fp);
    if (!s) return null;
    const span = s.definition && (s.standing === 'current' || s.standing === 'older')
      ? definitionSpan({ current: s.standing === 'current', ...s.definition }, iso => this.date(iso)) : null;
    if (span) return span;
    return s.standing === 'current' ? { key: 'spaces.schema.history.current', params: {} } : { key: 'brain.drawer.typeDefinition.cannotTell', params: {} };
  }

  /** The definition chip: "not current", or the span of the `sameAs:` definition once the column's read has said it. */
  chip(): Words {
    const rep = this.sameAsRep();
    if (!rep) return { key: 'brain.filter.typeDefinitionOlder', params: {} };
    const s = this.standings().get(rep);
    const span = s?.definition ? definitionSpan({ current: s.standing === 'current', ...s.definition }, iso => this.date(iso)) : null;
    const text = span ? this.injector.get(TranslocoService).translate(span.key, span.params) : '…';
    return { key: 'brain.filter.typeDefinitionSpan', params: { span: text } };
  }

  private sameAsRep(): string {
    const d = this.definition();
    return d.startsWith('sameAs:') ? d.slice('sameAs:'.length) : '';
  }

  private date(iso: string): string {
    return this.injector.get(DateFormatService).format(iso, 'date');
  }
}
