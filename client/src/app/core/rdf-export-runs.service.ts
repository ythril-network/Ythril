import { Injectable, Injector, inject, signal } from '@angular/core';
import { AuthenticatedDownload, saveBlob } from './authenticated-download';
import { headerList, rdfExportEnding, type RdfExportEnding } from './rdf-export-ending';
import { RDF_EXTENSION, type RdfEdgeDetails, type RdfRecordFormat, type RdfSchemaFormat } from './rdf-names';
import type { RefusalSource } from './refusal-text';

/**
 * The RDF exports a reader starts from the screens (Q-942): the records of a space or a personal view, and a space's schema.
 *
 * ## Why a root service
 *
 * A records export of a big space runs for minutes. Its run is kept here, by the space or view it exports, not in the panel that started
 * it: the reader may open another Brain tab while it runs (the Overview tab then carries it in its count) and come back to the result. It
 * stops when the browser tab closes, as the panel says.
 *
 * ## What it prevents
 *
 * - **A refusal said as `HTTP 409`.** A refused export keeps the answer as a refusal source (status, body, headers), which the screen words
 *   through `rdf-refusal.ts` in the reader's language.
 * - **A cut-off file saved as if whole.** The document is saved only when its ending was read (`rdf-export-ending.ts`); an export that
 *   ended without one, or with the incomplete mark, is a failure, and nothing is saved.
 * - **Two runs of one export.** A start while the same subject's export runs is ignored; the server allows two exports per instance and
 *   one per token, and answers the rest `429 rdf_export_busy`, which is worded like any refusal.
 * - **A result lost to the next refusal.** "Export again" that is refused keeps the previous result on screen beside the refusal.
 */

export interface RdfExportResult extends RdfExportEnding {
  file: string;
  bytes: number;
  /** Member spaces of a view left out: RDF off, or names not settled. */
  withoutRdf: string[];
  inConflict: string[];
}

export interface RdfExportRun {
  running: boolean;
  format: RdfRecordFormat;
  file: string;
  bytes: number;
  /** The last finished export of this subject. */
  result?: RdfExportResult;
  /** The last start's refusal or failure: a refusal source to word, or `'cut'` for a document that ended without its ending. */
  failure?: RefusalSource | 'cut';
}

/** The last bytes of a document kept to read its ending: the server names at most 100 left-out values. */
const TAIL_CHARS = 256 * 1024;

/** A refused answer as a refusal source: its status, its JSON body when it has one, its headers. */
async function refusalOf(r: Response): Promise<RefusalSource> {
  let body: unknown = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, statusText: r.statusText, error: body as RefusalSource['error'], headers: r.headers };
}

/** The file name the answer gives (`Content-Disposition: attachment; filename="research.ttl"`), else `fallback`. */
function fileNameOf(r: Response, fallback: string): string {
  const cd = r.headers.get('Content-Disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) ?? /filename="?([^";]+)"?/i.exec(cd);
  if (!m) return fallback;
  try { return decodeURIComponent(m[1]!); } catch { return m[1]!; }
}

@Injectable({ providedIn: 'root' })
export class RdfExportRuns {
  private readonly injector = inject(Injector);
  /** Asked when an export starts, not when a screen that shows one is built: a screen never needs the session to draw. */
  private get download(): AuthenticatedDownload { return this.injector.get(AuthenticatedDownload); }
  private readonly stops = new Map<string, AbortController>();
  /** Every subject's run, by space or view id. */
  readonly runs = signal<Readonly<Record<string, RdfExportRun>>>({});

  runOf(id: string): RdfExportRun | undefined { return this.runs()[id]; }

  private put(id: string, run: RdfExportRun): void { this.runs.update(all => ({ ...all, [id]: run })); }

  /** Export the records of `id` (a space, or the caller's own view) and save the file; the run's state is in {@link runs}. */
  async start(id: string, format: RdfRecordFormat, edgeDetails: RdfEdgeDetails): Promise<void> {
    if (this.runs()[id]?.running) return;
    const previous = this.runs()[id]?.result;
    const fallback = `${id.replace(/^@/, '')}.${RDF_EXTENSION[format]}`;
    const stop = new AbortController();
    this.stops.set(id, stop);
    this.put(id, { running: true, format, file: fallback, bytes: 0, ...(previous ? { result: previous } : {}) });
    const edges = format === 'jsonld' ? 'reification' : edgeDetails;
    const url = `/api/brain/spaces/${encodeURIComponent(id)}/export/rdf?format=${format}&edgeDetails=${edges}`;
    const end = (patch: Partial<RdfExportRun>): void => this.put(id, { ...this.runs()[id]!, running: false, ...patch });
    try {
      const r = await this.download.open(url, stop.signal);
      if (!r.ok || !r.body) { end({ failure: await refusalOf(r) }); return; }
      const file = fileNameOf(r, fallback);
      this.put(id, { ...this.runs()[id]!, file });
      const parts: BlobPart[] = [];
      const decoder = new TextDecoder();
      let tail = '';
      let bytes = 0;
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        bytes += value.byteLength;
        tail = (tail + decoder.decode(value, { stream: true })).slice(-TAIL_CHARS);
        this.put(id, { ...this.runs()[id]!, bytes });
      }
      const ending = rdfExportEnding(tail, format);
      if (!ending || !ending.complete) { end({ failure: 'cut', bytes }); return; }
      saveBlob(new Blob(parts, { type: r.headers.get('Content-Type') ?? 'application/octet-stream' }), file, { revokeAfterMs: 10_000 });
      const result: RdfExportResult = {
        ...ending, file, bytes,
        withoutRdf: headerList(r.headers.get('Ythril-View-Members-Without-Rdf')),
        inConflict: headerList(r.headers.get('Ythril-View-Members-In-Conflict')),
      };
      end({ result, failure: undefined, bytes });
    } catch (err) {
      // A stop is the reader's own act: nothing to report, the previous result stays.
      if (stop.signal.aborted) { end({ failure: undefined }); return; }
      end({ failure: { status: 0, message: String(err) } });
    } finally {
      if (this.stops.get(id) === stop) this.stops.delete(id);
    }
  }

  /** Stop the running export of `id`; nothing is saved. */
  stop(id: string): void {
    this.stops.get(id)?.abort();
  }

  /** Save the schema of space `id` as OWL and SHACL; resolves to the refusal when the server refused, else to null. */
  async saveSchema(id: string, format: RdfSchemaFormat): Promise<RefusalSource | null> {
    try {
      const r = await this.download.open(`/api/spaces/${encodeURIComponent(id)}/schema-rdf?format=${format}`);
      if (!r.ok) return await refusalOf(r);
      saveBlob(await r.blob(), fileNameOf(r, `${id}-schema.${format === 'jsonld' ? 'jsonld' : 'ttl'}`), { revokeAfterMs: 10_000 });
      return null;
    } catch (err) {
      return { status: 0, message: String(err) };
    }
  }
}
