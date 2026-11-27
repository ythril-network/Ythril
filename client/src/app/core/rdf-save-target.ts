import { InjectionToken } from '@angular/core';
import { saveBlob } from './authenticated-download';
import type { RdfRecordFormat } from './rdf-names';

/**
 * Where an RDF records export is written as it arrives (Q-942): a file the reader chose through the browser's save-file picker, or, in a
 * browser with none, a Blob held in memory and saved at the end.
 *
 * ## What it prevents
 *
 * - **A whole export held in memory where the browser can stream it.** A records export of a big space is gigabytes. With a picker the
 *   chunks go to the file as they are read; only a browser without one keeps them (and the screen says so while it runs).
 * - **A cut file committed as if whole.** The picked file is written through a writable stream that keeps its bytes aside until `close`;
 *   a document without its ending is `discard`ed (the stream aborted), never closed, so the file keeps what it held before.
 * - **A failure of the file read as "the server could not be reached".** Every write and the final save throw {@link SaveFailure}, which
 *   the run reports as a save failure, apart from a lost connection.
 * - **A picker the browser refuses.** The picker is opened by the caller inside the click (the browser's user-gesture rule); one the
 *   browser still refuses (anything but the reader closing it) falls back to the memory target instead of failing the export.
 */

/** The writable stream of a picked file, as far as the export uses it. */
export interface SaveWritable {
  write(chunk: Uint8Array): Promise<void>;
  /** Commit the file: its bytes become the file only now. */
  close(): Promise<void>;
  /** Drop everything written; the file keeps what it held before. */
  abort(reason?: unknown): Promise<void>;
}

/** A file the reader picked. */
export interface SaveHandle {
  name?: string;
  createWritable(): Promise<SaveWritable>;
  /** Not every browser can remove a file it created; best effort. */
  remove?(): Promise<void>;
}

export interface SavePickerOptions {
  suggestedName: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}

/** `window.showSaveFilePicker`: Chromium browsers have it; Firefox and Safari do not. */
export type SavePicker = (options: SavePickerOptions) => Promise<SaveHandle>;

/** The save-file picker of this browser, or null when it has none. A token, so a spec can plant one. */
export const RDF_SAVE_PICKER = new InjectionToken<SavePicker | null>('RDF_SAVE_PICKER', {
  providedIn: 'root',
  factory: () => {
    const w = typeof window === 'undefined' ? undefined : (window as unknown as { showSaveFilePicker?: SavePicker });
    return typeof w?.showSaveFilePicker === 'function' ? w.showSaveFilePicker.bind(window) : null;
  },
});

/** A failure of the file: a write, the final save, or opening the writable stream. Not a failure of the connection. */
export class SaveFailure extends Error {
  constructor(readonly original: unknown) { super(original instanceof Error ? original.message : String(original)); }
}

export interface SaveTarget {
  /** True when the whole export is held in memory until `commit`. */
  readonly inMemory: boolean;
  /** The name the reader gave the file, when the browser says it. */
  readonly name: string | undefined;
  write(chunk: Uint8Array): Promise<void>;
  /** The document is whole: make it the file. */
  commit(file: string, contentType: string): Promise<void>;
  /** The document is not to be kept: drop what was written. Never throws; safe to call after `commit`. */
  discard(): Promise<void>;
}

/** How long a saved Blob's object URL is kept after the click: a large file may take the browser a moment to hand over. */
const SAVED_URL_HOLD_MS = 10_000;

/** The browsers without a picker: the chunks are held, then saved as one Blob. */
export function memoryTarget(): SaveTarget {
  let parts: BlobPart[] = [];
  return {
    inMemory: true,
    name: undefined,
    write: async (chunk) => { parts.push(chunk); },
    commit: async (file, contentType) => {
      try { saveBlob(new Blob(parts, { type: contentType }), file, { revokeAfterMs: SAVED_URL_HOLD_MS }); } catch (err) { throw new SaveFailure(err); } finally { parts = []; }
    },
    discard: async () => { parts = []; },
  };
}

/** A file the reader picked: its writable stream is opened here, and the chunks are written to it as they come. */
export async function pickedTarget(handle: SaveHandle): Promise<SaveTarget> {
  let writable: SaveWritable;
  try { writable = await handle.createWritable(); } catch (err) { throw new SaveFailure(err); }
  let ended = false;
  return {
    inMemory: false,
    name: handle.name,
    write: async (chunk) => { try { await writable.write(chunk); } catch (err) { throw new SaveFailure(err); } },
    commit: async () => { try { await writable.close(); ended = true; } catch (err) { throw new SaveFailure(err); } },
    discard: async () => {
      if (ended) return;
      ended = true;
      // The file the picker made stays (an empty one, or what it held before): the browser lets a page remove it only where it can.
      try { await writable.abort(); } catch { /* the stream is gone already */ }
      try { await handle.remove?.(); } catch { /* not every browser can remove a file */ }
    },
  };
}

/** The MIME type and extension of each format, for the picker's file-type filter. */
const PICKER_TYPES: Readonly<Record<RdfRecordFormat, { mime: string; ext: string }>> = {
  turtle: { mime: 'text/turtle', ext: '.ttl' },
  trig: { mime: 'application/trig', ext: '.trig' },
  nquads: { mime: 'application/n-quads', ext: '.nq' },
  jsonld: { mime: 'application/ld+json', ext: '.jsonld' },
};

/** The picker's options for an export in `format` suggested as `name`. */
export const pickerOptionsOf = (name: string, format: RdfRecordFormat): SavePickerOptions =>
  ({ suggestedName: name, types: [{ description: 'RDF', accept: { [PICKER_TYPES[format].mime]: [PICKER_TYPES[format].ext] } }] });
