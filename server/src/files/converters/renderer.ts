/**
 * Client for the document-render sidecars (F11) — turns a document into per-page PNG images so the VLM
 * extraction path can read pages. Two trusted, internal-only sidecars, routed by format:
 *
 *   - **`doc-render`** (`RENDER_SIDECAR_URL`) — PDFs. Tiny, always-bundled.
 *   - **`doc-office`** (`RENDER_OFFICE_SIDECAR_URL`) — office docs (DOCX/EPUB/…): LibreOffice converts to
 *     PDF, then rasterizes. Heavy (LibreOffice), so it is **opt-in** (a compose profile); when it is not
 *     running, office docs simply fall back to OCR, exactly as before F11-a.
 *
 * Both speak the same `/render` contract and return the same `{ pages }` shape. Their URLs come from
 * compose, so — like the OCR sidecar client — this uses a plain `fetch`, not the SSRF-guarded one (that
 * guard is for operator-supplied *external* model endpoints).
 */
import { log } from '../../util/log.js';
import { boundedJson, boundedErrorText } from '../../util/bounded-read.js';
import { sidecarHealthy, resetSidecarHealth } from '../../util/sidecar-health.js';

const RENDER_URL = (process.env['RENDER_SIDECAR_URL'] ?? 'http://localhost:8100').replace(/\/$/, '');
const OFFICE_URL = (process.env['RENDER_OFFICE_SIDECAR_URL'] ?? 'http://localhost:8101').replace(/\/$/, '');

/** Office formats LibreOffice can convert → PDF for rasterization (the `doc-office` sidecar). */
const OFFICE_EXTS = new Set(['docx', 'doc', 'odt', 'rtf', 'epub', 'pptx', 'ppt', 'odp', 'xlsx', 'xls', 'ods']);

/** Whether a file needs the office (LibreOffice) rasterizer rather than the plain PDF one. */
export function isOfficeDocument(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return OFFICE_EXTS.has(ext);
}

/** Whether the PDF render sidecar is reachable. Cached — see `util/sidecar-health.ts`. */
export async function isRenderAvailable(): Promise<boolean> { return sidecarHealthy(RENDER_URL); }

/** Whether the (opt-in) office render sidecar is reachable. */
export async function isOfficeRenderAvailable(): Promise<boolean> { return sidecarHealthy(OFFICE_URL); }

/** The right rasterizer availability for a given file — the PDF sidecar, or the office one. */
export async function isRenderAvailableFor(fileName: string): Promise<boolean> {
  return isOfficeDocument(fileName) ? isOfficeRenderAvailable() : isRenderAvailable();
}

/** Reset the cached health probes (tests). */
export function _resetRenderHealthCache(): void { resetSidecarHealth(); }

/** Rendered document pages (PNG bytes per page). */
export interface RenderedPages {
  pages: Buffer[];
  /** Total pages in the document (may exceed `pages.length` when only a window was rendered). */
  total: number;
  /** True when there are pages AFTER this window — i.e. keep going, or stop and say you truncated. */
  truncated: boolean;
  /** First page index of the returned window. Echoed by the sidecar; 0 for a from-the-start render. */
  startPage: number;
}

/**
 * Render a document's pages to PNG images, routing PDFs to `doc-render` and office docs to `doc-office`
 * (by `fileName` extension). `dpi` and `maxPages` bound cost/latency; each sidecar enforces its own hard
 * caps as a second layer. Throws when the target sidecar is unreachable or errors — the caller degrades
 * to OCR.
 */
export async function renderDocumentPages(
  bytes: Buffer,
  opts: { fileName: string; dpi?: number; maxPages?: number; timeoutMs?: number; startPage?: number },
): Promise<RenderedPages> {
  const dpi = opts.dpi ?? 150;
  const maxPages = opts.maxPages ?? 50;
  const startPage = Math.max(0, Math.trunc(opts.startPage ?? 0));
  const office = isOfficeDocument(opts.fileName);
  const base = office ? OFFICE_URL : RENDER_URL;

  const form = new FormData();
  // Pass the real filename so LibreOffice picks the correct import filter (a hardcoded name would be
  // treated as PDF); the PDF sidecar ignores it.
  form.append('file', new Blob([new Uint8Array(bytes)]), opts.fileName || (office ? 'document' : 'document.pdf'));

  const url = `${base}/render?dpi=${dpi}&maxPages=${maxPages}&startPage=${startPage}`;
  const which = office ? 'doc-office' : 'doc-render';
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
  } catch (err) {
    throw new Error(`${which} sidecar unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const detail = await boundedErrorText(res);
    throw new Error(`${which} sidecar error ${res.status}: ${detail}`);
  }

  // The largest JSON body in the server: `pages` is an array of base64 PNGs, and every one of them is
  // decoded below. Bounded because renderDpi accepts up to 600 and maxPages up to 2000 from the UI.
  const body = await boundedJson<{ pages?: string[]; total?: number; truncated?: boolean; startPage?: number }>(
    res, `${which} sidecar`);
  const pages = (body.pages ?? []).map(b64 => Buffer.from(b64, 'base64'));
  if (body.truncated) log.debug(`render: pages ${startPage}–${startPage + pages.length} of ${body.total}; more follow`);
  // `startPage` falls back to what we asked for: an older sidecar that does not echo it still windows
  // correctly, it just cannot confirm the offset.
  return {
    pages,
    total: body.total ?? pages.length,
    truncated: body.truncated ?? false,
    startPage: body.startPage ?? startPage,
  };
}
