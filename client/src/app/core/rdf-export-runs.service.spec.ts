/**
 * Q-942: the records export's run, kept by the root service `RdfExportRuns` (fix round of the bundle's verify findings L1.4, L2.2, D3).
 *
 * ## What it holds
 *
 * - **A document with no ending is not saved.** An export cut on the way, or one that ended with the incomplete mark, is a failure and
 *   nothing reaches the disk.
 * - **A second start while one runs is ignored**, and a refusal ("two exports already run", 429) keeps the previous result.
 * - **A stop is not a failure**, and a failure of the file itself is not "the server could not be reached".
 * - **A stream that goes quiet ends as failed** (no chunk for the idle bound).
 * - **A browser with a save-file picker is never made to hold the export in memory.** The picker opens inside the click, before the fetch;
 *   the stream goes to the file as it arrives, and only the document's end is kept to read its ending. A browser without one saves a Blob.
 * - **Reading the stream is cheap per chunk**: the bytes shown move at most a few times a second, and the ending is decoded once.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthenticatedDownload, saveBlob } from './authenticated-download';
import { RDF_EXPORT_IDLE_MS, RdfExportRuns, headerList } from './rdf-export-runs.service';
import { RDF_SAVE_PICKER, type SaveHandle, type SaveWritable } from './rdf-save-target';
import { rdfRefusalText } from './rdf-refusal';

vi.mock('./authenticated-download', async (orig) => ({ ...(await orig<typeof import('./authenticated-download')>()), saveBlob: vi.fn() }));

const ENDING = '# ythril-export: 3 records; complete, nothing is left; 0 property values left out\n';
const BODY = '<a> <b> <c> .\n';
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A response whose body is `chunks`, closed after the last (or held open when `hold` is set). */
function answer(chunks: string[], init: { status?: number; headers?: Record<string, string>; json?: unknown; hold?: boolean } = {}): Response {
  if (init.json !== undefined) return new Response(JSON.stringify(init.json), { status: init.status ?? 400, headers: { 'Content-Type': 'application/json', ...init.headers } });
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(bytes(ch)); if (!init.hold) c.close(); },
  });
  return new Response(stream, { status: init.status ?? 200, headers: { 'Content-Type': 'text/turtle', 'Content-Disposition': 'attachment; filename="platform.ttl"', ...init.headers } });
}

interface Writes { writes: string[]; closed: boolean; aborted: boolean; removed: boolean }
function fakePicker(over: { failWrite?: boolean; reject?: unknown } = {}) {
  const log: Writes = { writes: [], closed: false, aborted: false, removed: false };
  const writable: SaveWritable = {
    write: async (c) => { if (over.failWrite) throw new Error('disk full'); log.writes.push(new TextDecoder().decode(c)); },
    close: async () => { log.closed = true; },
    abort: async () => { log.aborted = true; },
  };
  const handle: SaveHandle = { name: 'picked.ttl', createWritable: async () => writable, remove: async () => { log.removed = true; } };
  const picker = vi.fn(() => (over.reject !== undefined ? Promise.reject(over.reject) : Promise.resolve(handle)));
  return { picker, log };
}

function setup(open: (url: string, signal?: AbortSignal) => Promise<Response>, extra: { picker?: unknown; idleMs?: number } = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: AuthenticatedDownload, useValue: { open: vi.fn(open) } },
      ...(extra.picker !== undefined ? [{ provide: RDF_SAVE_PICKER, useValue: extra.picker }] : []),
      ...(extra.idleMs !== undefined ? [{ provide: RDF_EXPORT_IDLE_MS, useValue: extra.idleMs }] : []),
    ],
  });
  const runs = TestBed.inject(RdfExportRuns);
  const download = TestBed.inject(AuthenticatedDownload) as unknown as { open: ReturnType<typeof vi.fn> };
  return { runs, open: download.open };
}

beforeEach(() => vi.mocked(saveBlob).mockReset());

describe('RdfExportRuns, without a save picker (the Blob path)', () => {
  it('saves a document that ends with its ending, as the file the server names, and keeps the result', async () => {
    const { runs } = setup(async () => answer([BODY, ENDING]));
    await runs.start('platform', 'turtle', 'rdf12');
    expect(saveBlob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveBlob).mock.calls[0]![1]).toBe('platform.ttl');
    const run = runs.runs()['platform']!;
    expect(run.running).toBe(false);
    expect(run.failure).toBeUndefined();
    expect(run.result).toMatchObject({ file: 'platform.ttl', records: 3, complete: true, bytes: BODY.length + ENDING.length });
  });

  it('a document with no ending is not saved: the run fails as cut', async () => {
    const { runs } = setup(async () => answer([BODY, BODY]));
    await runs.start('platform', 'turtle', 'rdf12');
    expect(saveBlob).not.toHaveBeenCalled();
    expect(runs.runs()['platform']!.failure).toBe('cut');
    expect(runs.runs()['platform']!.result).toBeUndefined();
  });

  it('a document that ends with the incomplete mark is not saved either', async () => {
    const { runs } = setup(async () => answer([BODY, '# ythril-export: 5 records; INCOMPLETE, the export could not finish: store; 0 property values left out\n!ythril-export-incomplete\n']));
    await runs.start('platform', 'turtle', 'rdf12');
    expect(saveBlob).not.toHaveBeenCalled();
    expect(runs.runs()['platform']!.failure).toBe('cut');
  });

  it('a second start of the same export while it runs is ignored', async () => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const { runs, open } = setup(async () => { await held; return answer([BODY, ENDING]); });
    const first = runs.start('platform', 'turtle', 'rdf12');
    await runs.start('platform', 'turtle', 'rdf12');
    expect(open).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(saveBlob).toHaveBeenCalledTimes(1);
  });

  it('a refusal keeps the previous result beside it, and a 429 is worded as the busy refusal (D3)', async () => {
    let n = 0;
    const { runs } = setup(async () => (n++ === 0 ? answer([BODY, ENDING]) : answer([], { status: 429, json: { error: 'Two exports already run', code: 'rdf_export_busy' } })));
    await runs.start('platform', 'turtle', 'rdf12');
    await runs.start('platform', 'turtle', 'rdf12');
    const run = runs.runs()['platform']!;
    expect(run.result?.records).toBe(3);
    expect(run.running).toBe(false);
    const t = { translate: (k: string) => `T:${k}` };
    expect(rdfRefusalText(t, run.failure as never)).toBe('T:rdf.refusal.rdf_export_busy');
  });

  it('another subject refused while the first still runs shows the 429 words and leaves the first running (D3)', async () => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const { runs } = setup(async (url) => (url.includes('/platform/') ? (await held, answer([BODY, ENDING])) : answer([], { status: 429, json: { error: 'busy', code: 'rdf_export_busy' } })));
    const first = runs.start('platform', 'turtle', 'rdf12');
    await runs.start('other', 'turtle', 'rdf12');
    expect(runs.runs()['platform']!.running).toBe(true);
    expect((runs.runs()['other']!.failure as { status: number }).status).toBe(429);
    release();
    await first;
  });

  it('a stop reports no failure and saves nothing', async () => {
    const { runs } = setup((_url, signal) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes(BODY)); signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); },
    }), { status: 200, headers: { 'Content-Type': 'text/turtle' } })));
    const run = runs.start('platform', 'turtle', 'rdf12');
    await vi.waitFor(() => expect(runs.runs()['platform']!.bytes).toBeGreaterThan(0));
    runs.stop('platform');
    await run;
    expect(runs.runs()['platform']!.failure).toBeUndefined();
    expect(runs.runs()['platform']!.running).toBe(false);
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it('a failure to save the file is a save failure, never "the server could not be reached"', async () => {
    vi.mocked(saveBlob).mockImplementation(() => { throw new Error('Array buffer allocation failed'); });
    const { runs } = setup(async () => answer([BODY, ENDING]));
    await runs.start('platform', 'turtle', 'rdf12');
    expect(runs.runs()['platform']!.failure).toBe('save');
    expect(runs.runs()['platform']!.result).toBeUndefined();
  });

  it('a lost connection stays a failure with status 0, which the screen words as unreachable', async () => {
    const { runs } = setup(async () => { throw new TypeError('Failed to fetch'); });
    await runs.start('platform', 'turtle', 'rdf12');
    expect((runs.runs()['platform']!.failure as { status: number }).status).toBe(0);
  });

  it('a stream that sends nothing for the idle bound ends as failed (idle), saving nothing', async () => {
    const { runs } = setup(async () => answer([BODY], { hold: true }), { idleMs: 40 });
    await runs.start('platform', 'turtle', 'rdf12');
    expect(runs.runs()['platform']!.failure).toBe('idle');
    expect(runs.runs()['platform']!.running).toBe(false);
    expect(saveBlob).not.toHaveBeenCalled();
  }, 3_000);

  it('reads many chunks cheaply: the ending is decoded once and the bytes shown move a few times, not once a chunk', async () => {
    const chunks = Array.from({ length: 300 }, () => BODY);
    chunks.push(ENDING);
    const { runs } = setup(async () => answer(chunks));
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    const update = vi.spyOn(runs.runs as unknown as { update: () => void }, 'update');
    await runs.start('platform', 'turtle', 'rdf12');
    expect(runs.runs()['platform']!.result?.bytes).toBe(300 * BODY.length + ENDING.length);
    expect(decode.mock.calls.length).toBeLessThanOrEqual(2);
    expect(update.mock.calls.length).toBeLessThan(10);
    decode.mockRestore();
  });

  it('says it holds the export in memory (the browser has no save picker)', async () => {
    const { runs } = setup(async () => answer([BODY], { hold: true }), { idleMs: 40 });
    const run = runs.start('platform', 'turtle', 'rdf12');
    await vi.waitFor(() => expect(runs.runs()['platform']!.running).toBe(true));
    expect(runs.runs()['platform']!.inMemory).toBe(true);
    await run;
  });
});

describe('RdfExportRuns, with a save picker (streamed to the file)', () => {
  it('opens the picker inside the click, before the fetch, and streams every chunk to the file without a Blob', async () => {
    const { picker, log } = fakePicker();
    const { runs, open } = setup(async () => answer([BODY, BODY, ENDING]), { picker });
    const done = runs.start('platform', 'turtle', 'rdf12');
    // Nothing has been awaited since the call: this is still the click's own turn, which the browser's user-gesture rule is about.
    expect(picker).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(picker.mock.calls[0]![0]).toMatchObject({ suggestedName: 'platform.ttl' });
    await done;
    expect(log.writes.join('')).toBe(BODY + BODY + ENDING);
    expect(log.closed).toBe(true);
    expect(log.aborted).toBe(false);
    expect(saveBlob).not.toHaveBeenCalled();
    const run = runs.runs()['platform']!;
    expect(run.inMemory).toBe(false);
    expect(run.result).toMatchObject({ file: 'picked.ttl', records: 3 });
  });

  it('a reader who closes the picker starts nothing: no fetch, no failure', async () => {
    const { picker } = fakePicker({ reject: new DOMException('The user aborted a request.', 'AbortError') });
    const { runs, open } = setup(async () => answer([BODY, ENDING]), { picker });
    await runs.start('platform', 'turtle', 'rdf12');
    expect(open).not.toHaveBeenCalled();
    expect(runs.runs()['platform']!.running).toBe(false);
    expect(runs.runs()['platform']!.failure).toBeUndefined();
  });

  it('a picker the browser refuses (no user gesture) falls back to the Blob path', async () => {
    const { picker } = fakePicker({ reject: new DOMException('Must be handling a user gesture', 'SecurityError') });
    const { runs } = setup(async () => answer([BODY, ENDING]), { picker });
    await runs.start('platform', 'turtle', 'rdf12');
    expect(saveBlob).toHaveBeenCalledTimes(1);
    expect(runs.runs()['platform']!.result?.records).toBe(3);
  });

  it('a refused export discards the file it opened', async () => {
    const { picker, log } = fakePicker();
    const { runs } = setup(async () => answer([], { status: 429, json: { error: 'busy', code: 'rdf_export_busy' } }), { picker });
    await runs.start('platform', 'turtle', 'rdf12');
    expect(log.aborted).toBe(true);
    expect(log.closed).toBe(false);
    expect(log.removed).toBe(true);
    expect((runs.runs()['platform']!.failure as { status: number }).status).toBe(429);
  });

  it('a document with no ending is aborted, never committed to the file', async () => {
    const { picker, log } = fakePicker();
    const { runs } = setup(async () => answer([BODY, BODY]), { picker });
    await runs.start('platform', 'turtle', 'rdf12');
    expect(log.closed).toBe(false);
    expect(log.aborted).toBe(true);
    expect(runs.runs()['platform']!.failure).toBe('cut');
  });

  it('a write that fails (disk full) is a save failure', async () => {
    const { picker, log } = fakePicker({ failWrite: true });
    const { runs } = setup(async () => answer([BODY, ENDING]), { picker });
    await runs.start('platform', 'turtle', 'rdf12');
    expect(runs.runs()['platform']!.failure).toBe('save');
    expect(log.aborted).toBe(true);
  });

  it('keeps only the document\'s end in memory: a long export is read through a bounded tail', async () => {
    const { picker, log } = fakePicker();
    const big = 'x'.repeat(64 * 1024) + '\n';
    const chunks = Array.from({ length: 40 }, () => big);
    chunks.push(ENDING);
    const { runs } = setup(async () => answer(chunks), { picker });
    await runs.start('platform', 'turtle', 'rdf12');
    expect(runs.runs()['platform']!.result?.records).toBe(3);
    expect(log.writes.length).toBe(41);
  });
});

describe('headerList', () => {
  it('reads a view header\'s percent-encoded member list', () => {
    expect(headerList('field-notes, scratch%20pad')).toEqual(['field-notes', 'scratch pad']);
    expect(headerList(null)).toEqual([]);
  });
});
