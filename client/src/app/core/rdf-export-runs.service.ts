import { Injectable, InjectionToken, Injector, inject, signal } from '@angular/core';
import { AuthenticatedDownload, saveBlob } from './authenticated-download';
import { rdfExportEnding, type RdfExportEnding } from './rdf-export-ending';
import { RDF_EXTENSION, type RdfEdgeDetails, type RdfRecordFormat, type RdfSchemaFormat } from './rdf-names';
import { RDF_SAVE_PICKER, SAVED_URL_HOLD_MS, SaveFailure, memoryTarget, pickedTarget, pickerOptionsOf, type SaveHandle, type SaveTarget } from './rdf-save-target';
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
 *   ended without one, or with the incomplete mark, is a failure, and nothing is saved (a picked file's stream is aborted, never closed).
 * - **Two runs of one export.** A start while the same subject's export runs is ignored; the server allows two exports per instance and
 *   one per token, and answers the rest `429 rdf_export_busy`, which is worded like any refusal.
 * - **A result lost to the next refusal.** "Export again" that is refused keeps the previous result on screen beside the refusal.
 * - **A whole export held in memory where the browser can stream it.** Where the browser has a save-file picker it is opened on the click,
 *   before the fetch (the browser grants it only inside the user's gesture), and the stream is written to the file as it arrives; only the
 *   document's last bytes are kept, to read its ending. A browser without one saves a Blob (`rdf-save-target.ts`), and the run says so.
 * - **A stream that stalls for ever.** No chunk for {@link RDF_EXPORT_IDLE_MS} ends the run as failed (`idle`); the server's own bound for a
 *   reader is five minutes, so a stream quiet this long is not coming back.
 * - **A failure of the file read as a lost server.** A failed write or save is `save`; only a failed request is status 0.
 * - **A signal write and a decode per chunk.** The size shown moves at most every {@link SIZE_EVERY_MS}; the ending is decoded once, at the end.
 */

export interface RdfExportResult extends RdfExportEnding {
  file: string;
  bytes: number;
  /** Member spaces of a view left out: RDF off, or names not settled. */
  withoutRdf: string[];
  inConflict: string[];
}

/** Why a run failed, apart from a refusal: a document without its ending, a stream gone quiet, a file that could not be written. */
export type RdfRunFailure = 'cut' | 'idle' | 'save';

export interface RdfExportRun {
  running: boolean;
  file: string;
  bytes: number;
  /** True while the whole export is held in memory (a browser with no save picker). */
  inMemory: boolean;
  /** The last finished export of this subject. */
  result?: RdfExportResult;
  /** The last start's refusal or failure: a refusal source to word, or why the run ended without a file. */
  failure?: RefusalSource | RdfRunFailure;
}

/** The last bytes of a document kept to read its ending: the server names at most 100 left-out values. */
const TAIL_BYTES = 256 * 1024;
/** How often the size shown may move. */
const SIZE_EVERY_MS = 250;

/** How long a stream may send nothing before the run ends as failed, in milliseconds; a token so a spec can shorten it. */
export const RDF_EXPORT_IDLE_MS = new InjectionToken<number>('RDF_EXPORT_IDLE_MS', { providedIn: 'root', factory: () => 180_000 });

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

/** A header's list of space ids (`Ythril-View-Members-Without-Rdf`), [] when absent. */
export function headerList(value: string | null): string[] {
  // Each id is percent-encoded by the server (a header value is Latin-1).
  return (value ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
}

/** The ending of a stream: the last {@link TAIL_BYTES} bytes it sent, kept as the chunks they came in and decoded once. */
class Tail {
  private chunks: Uint8Array[] = [];
  private held = 0;
  add(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.held += chunk.byteLength;
    while (this.chunks.length > 1 && this.held - this.chunks[0]!.byteLength >= TAIL_BYTES) this.held -= this.chunks.shift()!.byteLength;
  }
  text(): string {
    const all = new Uint8Array(this.held);
    let at = 0;
    for (const c of this.chunks) { all.set(c, at); at += c.byteLength; }
    return new TextDecoder().decode(all.subarray(Math.max(0, all.byteLength - TAIL_BYTES)));
  }
}

/** The stream sent nothing for the idle bound. */
class Idle extends Error {}

/** `p`, or a rejection with {@link Idle} (after `onIdle`) when it takes longer than `ms`. */
function within<T>(p: Promise<T>, ms: number, onIdle: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { onIdle(); reject(new Idle()); }, ms);
    p.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

const isAbort = (err: unknown): boolean => (err as { name?: string } | null)?.name === 'AbortError';

@Injectable({ providedIn: 'root' })
export class RdfExportRuns {
  private readonly injector = inject(Injector);
  private readonly picker = inject(RDF_SAVE_PICKER);
  private readonly idleMs = inject(RDF_EXPORT_IDLE_MS);
  /** Asked when an export starts, not when a screen that shows one is built: a screen never needs the session to draw. */
  private get download(): AuthenticatedDownload { return this.injector.get(AuthenticatedDownload); }
  private readonly stops = new Map<string, AbortController>();
  /** Every subject's run, by space or view id. */
  readonly runs = signal<Readonly<Record<string, RdfExportRun>>>({});

  private put(id: string, run: RdfExportRun): void { this.runs.update(all => ({ ...all, [id]: run })); }

  /**
   * The file the export goes to: the reader's pick where the browser has a picker, else memory; null when the reader closed the picker.
   * Called before the first `await` of {@link start}: the picker opens only inside the click's own turn.
   */
  private async openTarget(opening: Promise<SaveHandle> | null): Promise<SaveTarget | null> {
    if (!opening) return memoryTarget();
    try {
      return await pickedTarget(await opening);
    } catch (err) {
      if (isAbort(err)) return null;
      // A picker the browser refuses (no gesture left, a sandbox) is no reason to lose the export: it is held and saved at the end.
      return memoryTarget();
    }
  }

  /** Export the records of `id` (a space, or the caller's own view) and save the file; the run's state is in {@link runs}. */
  async start(id: string, format: RdfRecordFormat, edgeDetails: RdfEdgeDetails): Promise<void> {
    if (this.runs()[id]?.running) return;
    const previous = this.runs()[id]?.result;
    const fallback = `${id.replace(/^@/, '')}.${RDF_EXTENSION[format]}`;
    const stop = new AbortController();
    this.stops.set(id, stop);
    // The picker, synchronously: nothing above awaits, so this is still the click's turn.
    let opening: Promise<SaveHandle> | null = null;
    try { opening = this.picker ? this.picker(pickerOptionsOf(fallback, format)) : null; } catch { opening = null; }
    this.put(id, { running: true, file: fallback, bytes: 0, inMemory: opening === null, ...(previous ? { result: previous } : {}) });
    const edges = format === 'jsonld' ? 'reification' : edgeDetails;
    const url = `/api/brain/spaces/${encodeURIComponent(id)}/export/rdf?format=${format}&edgeDetails=${edges}`;
    const end = (patch: Partial<RdfExportRun>): void => this.put(id, { ...this.runs()[id]!, running: false, ...patch });
    let idle = false;
    const onIdle = (): void => { idle = true; stop.abort(); };
    let target: SaveTarget | null = null;
    try {
      target = await this.openTarget(opening);
      // The reader closed the picker: nothing was asked of the server, and the previous result stays.
      if (!target) { end({ failure: undefined }); return; }
      this.put(id, { ...this.runs()[id]!, inMemory: target.inMemory, file: target.name ?? fallback });
      const r = await within(this.download.open(url, stop.signal), this.idleMs, onIdle);
      if (!r.ok || !r.body) { end({ failure: await refusalOf(r) }); return; }
      const file = target.name ?? fileNameOf(r, fallback);
      this.put(id, { ...this.runs()[id]!, file });
      const tail = new Tail();
      const reader = r.body.getReader();
      let bytes = 0;
      // The first bytes are shown at once (the bar has said nothing yet); after that the size moves at most every SIZE_EVERY_MS.
      let shownAt = Number.NEGATIVE_INFINITY;
      try {
        for (;;) {
          const { done, value } = await within(reader.read(), this.idleMs, onIdle);
          if (done) break;
          await target.write(value);
          tail.add(value);
          bytes += value.byteLength;
          const now = performance.now();
          if (now - shownAt >= SIZE_EVERY_MS) { shownAt = now; this.put(id, { ...this.runs()[id]!, bytes }); }
        }
      } finally {
        // A read that ended early (a stop, a quiet stream, a failed write) frees the connection; one that finished has nothing to cancel.
        void reader.cancel().catch(() => undefined);
      }
      const ending = rdfExportEnding(tail.text(), format);
      if (!ending || !ending.complete) { await target.discard(); end({ failure: 'cut', bytes }); return; }
      await target.commit(file, r.headers.get('Content-Type') ?? 'application/octet-stream');
      const result: RdfExportResult = {
        ...ending, file, bytes,
        withoutRdf: headerList(r.headers.get('Ythril-View-Members-Without-Rdf')),
        inConflict: headerList(r.headers.get('Ythril-View-Members-In-Conflict')),
      };
      end({ result, failure: undefined, bytes });
    } catch (err) {
      if (idle) end({ failure: 'idle' });
      // A stop is the reader's own act: nothing to report, the previous result stays.
      else if (stop.signal.aborted) end({ failure: undefined });
      else if (err instanceof SaveFailure) end({ failure: 'save' });
      else end({ failure: { status: 0, message: String(err) } });
    } finally {
      // A refused answer, a stop, a failure and a cut end here with the file not committed; a committed one is left as it is.
      await target?.discard();
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
      saveBlob(await r.blob(), fileNameOf(r, `${id}-schema.${format === 'jsonld' ? 'jsonld' : 'ttl'}`), { revokeAfterMs: SAVED_URL_HOLD_MS });
      return null;
    } catch (err) {
      return { status: 0, message: String(err) };
    }
  }
}
