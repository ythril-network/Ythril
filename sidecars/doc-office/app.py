"""
Ythril office-render sidecar (F11-a) — OPTIONAL / opt-in.

Converts office documents (DOCX/DOC/ODT/RTF/EPUB/PPTX/XLSX/…) to PDF with LibreOffice (headless), then
rasterizes the PDF to page PNGs via PDFium (pypdfium2) — the exact `/render` contract the `doc-render`
sidecar speaks, so the VLM document-extraction path can read office docs too. It is heavy (LibreOffice),
so it is NOT bundled by default: enable it with the compose `office` profile. When it is absent, the Node
caller degrades office docs to OCR, exactly as before F11-a.

Untrusted input → runs isolated (non-root, internal-only network, no DB, no internet egress), resource-
limited, with input caps here as a second layer. Any conversion failure returns 4xx/5xx so the caller
falls back to OCR — a LibreOffice hiccup must never take the media worker down.

Licensing: LibreOffice is MPL-2.0 / LGPL-3.0 (**not** AGPL) and is invoked as a separate process (not
linked), so it does not affect Ythril's permissive posture. PDFium (via pypdfium2) is Apache-2.0 /
BSD-3-Clause and Pillow is HPND — all permissive. (We deliberately do NOT use PyMuPDF, which is AGPL-3.0.)
See LICENSES.md.

Endpoints:
  GET  /health                      -> {"status": "ok", "maxPixels", "maxResponseBytes"}
  POST /render  (multipart 'file')  -> {"pages": [<base64 png>...], "count", "total", "truncated",
                                        "startPage", "dpi", "dpiUsed": [<dpi per returned page>...],
                                        "skipped": [{"page", "reason"}...]}
    query: dpi (72..600), maxPages (1..RENDER_MAX_PAGES), startPage (>=0)

`startPage` mirrors doc-render so a caller can walk either sidecar the same way, taking one window of pages
at a time instead of losing everything past `maxPages`.

It honours the same caps as doc-render, with the same meaning (see its docstring, which says what each one
bounds and why): `RENDER_MAX_PIXELS` lowers a page's dpi until the page fits, and skips a page that would
need less than 72 dpi or whose size is not finite and positive; `RENDER_MAX_RESPONSE_BYTES` ends a window early
with `truncated: true`. The converted PDF is what is rendered, so its pages are clamped exactly like an
oversized PDF page. The clamp is written twice because each image is built from its own directory only; testing/standalone/
the-render-sidecars-clamp-identically.test.js holds the two equal.
"""
import base64
import io
import math
import os
import pathlib
import subprocess
import tempfile

import pypdfium2 as pdfium
from fastapi import FastAPI, File, HTTPException, Query, UploadFile

# The resolution below which a page is skipped rather than read: the `dpi` query parameter's own floor.
MIN_DPI = 72


def _positive_int_env(name: str, default: str) -> int:
    """A cap read from the environment: a positive integer, or the sidecar does not start.

    A typo that read as 0 would refuse every page, and one that read as a negative number would admit
    all of them; neither is a configuration to run with.
    """
    raw = os.environ.get(name) or default  # compose passes an unset variable through as an empty string
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive integer, got {raw!r}")
    return value


# Defensive caps (second layer — the Node caller already size/page-caps). Overridable via env.
MAX_BYTES = _positive_int_env("RENDER_MAX_BYTES", str(100 * 1024 * 1024))  # 100 MiB
MAX_PAGES_HARD = _positive_int_env("RENDER_MAX_PAGES", "500")
MAX_PIXELS = _positive_int_env("RENDER_MAX_PIXELS", "40000000")  # 40 MP
MAX_RESPONSE_BYTES = _positive_int_env("RENDER_MAX_RESPONSE_BYTES", str(128 * 1024 * 1024))  # 128 MiB
CONVERT_TIMEOUT = int(os.environ.get("OFFICE_CONVERT_TIMEOUT", "120"))  # seconds for soffice

app = FastAPI(title="ythril-doc-office", docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "maxPixels": MAX_PIXELS, "maxResponseBytes": MAX_RESPONSE_BYTES}


def _page_pixels(width: float, height: float, scale: float) -> int:
    """The pixels PDFium allocates for a page: each side is rounded UP to a whole pixel."""
    return math.ceil(width * scale) * math.ceil(height * scale)


def clamp_scale(width: float, height: float, scale: float) -> float:
    """The scale to render a width x height pt page at: `scale`, or lower so it fits `MAX_PIXELS`.

    Solves (width * s + 1) * (height * s + 1) = MAX_PIXELS for s, which is an upper bound on the rounded-up
    pixel count, so the PNG that comes back is within the cap and not a pixel row or two over it. Returns 0
    when nothing positive fits.
    """
    if _page_pixels(width, height, scale) <= MAX_PIXELS:
        return scale
    area = width * height
    half = width + height
    fitted = (math.sqrt(half * half + 4.0 * area * (MAX_PIXELS - 1)) - half) / (2.0 * area)
    while fitted > 0 and _page_pixels(width, height, fitted) > MAX_PIXELS:
        fitted *= 0.9999
    return fitted if fitted > 0 else 0.0


def _encode_page(page, scale: float) -> str:
    """Render one page and return it as a base64 PNG; the bitmap and the image are gone when this returns."""
    bitmap = page.render(scale=scale)
    try:
        pil = bitmap.to_pil()
        buf = io.BytesIO()
        pil.save(buf, format="PNG")
    finally:
        bitmap.close()
    return base64.b64encode(buf.getvalue()).decode("ascii")


def render_window(pdf, start: int, end: int, dpi: int):
    """Render pages [start, end) of an open document within the caps.

    Returns (pages, dpi_used, skipped, next_index): the base64 PNGs, the dpi each was rendered at, the pages
    it would not render with their reasons, and the index of the first page it did not get to (== end unless
    the response cap ended the window early). One page is rendered at a time and released at once, so memory is
    bounded by the page in flight plus the encoded pages held, which RENDER_MAX_RESPONSE_BYTES bounds.
    """
    requested = dpi / 72.0  # pypdfium2 render scale is relative to 72 DPI
    pages = []
    dpi_used = []
    skipped = []
    held = 0
    index = start
    while index < end:
        page = pdf[index]
        try:
            width, height = page.get_size()
            if not (math.isfinite(width) and math.isfinite(height) and math.isfinite(width * height) and width > 0 and height > 0):
                skipped.append({"page": index, "reason": f"page size {width} x {height} pt is not a finite, positive size"})
                index += 1
                continue
            scale = clamp_scale(width, height, requested)
            if scale * 72.0 < MIN_DPI:
                needs = round(scale * 72.0, 1)
                skipped.append({
                    "page": index,
                    "reason": f"a {width:.0f} x {height:.0f} pt page needs {needs} dpi to fit RENDER_MAX_PIXELS ({MAX_PIXELS}), below the {MIN_DPI} dpi floor",
                })
                index += 1
                continue
            encoded = _encode_page(page, scale)
        finally:
            page.close()
        if pages and held + len(encoded) > MAX_RESPONSE_BYTES:
            break
        pages.append(encoded)
        dpi_used.append(dpi if scale == requested else round(scale * 72.0, 1))
        held += len(encoded)
        index += 1
    return pages, dpi_used, skipped, index


def _office_to_pdf(data: bytes, filename: str, workdir: str) -> bytes:
    """Convert office bytes → PDF via headless LibreOffice, isolated to a per-request temp dir."""
    src = pathlib.Path(workdir) / (pathlib.Path(filename).name or "input")
    if not src.suffix:  # LibreOffice picks the import filter from the extension
        src = src.with_suffix(".docx")
    src.write_bytes(data)
    # A private UserInstallation profile keeps soffice off any shared $HOME (the container is read-only
    # apart from this tmpfs), and lets concurrent requests not collide.
    profile = (pathlib.Path(workdir) / "louser").as_uri()
    try:
        proc = subprocess.run(
            [
                "soffice", "--headless", "--norestore", "--nolockcheck", "--nodefault",
                f"-env:UserInstallation={profile}",
                "--convert-to", "pdf", "--outdir", workdir, str(src),
            ],
            capture_output=True,
            timeout=CONVERT_TIMEOUT,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="office conversion timed out") from exc
    pdfs = [p for p in pathlib.Path(workdir).glob("*.pdf")]
    if proc.returncode != 0 or not pdfs:
        err = (proc.stderr or proc.stdout or b"").decode("utf-8", "replace")[:400]
        raise HTTPException(status_code=422, detail=f"office->pdf conversion failed: {err}")
    return pdfs[0].read_bytes()


@app.post("/render")
async def render(
    file: UploadFile = File(...),
    dpi: int = Query(150, ge=MIN_DPI, le=600),
    maxPages: int = Query(50, ge=1, le=MAX_PAGES_HARD),
    startPage: int = Query(0, ge=0),
) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"file exceeds {MAX_BYTES} bytes")

    with tempfile.TemporaryDirectory() as workdir:
        pdf_bytes = _office_to_pdf(data, file.filename or "input.docx", workdir)

        try:
            pdf = pdfium.PdfDocument(pdf_bytes)
        except Exception as exc:  # converted PDF unreadable
            raise HTTPException(status_code=422, detail=f"converted PDF unreadable: {exc}") from exc

        try:
            total = len(pdf)
            # Window [start, end) — see doc-render for the rationale; kept identical so a caller can walk
            # either sidecar the same way. A startPage past the end renders nothing rather than erroring.
            start = min(startPage, total)
            end = min(total, start + maxPages)
            pages, dpi_used, skipped, next_index = render_window(pdf, start, end, dpi)
        finally:
            pdf.close()

    return {
        "pages": pages,
        "count": len(pages),
        "total": total,
        # "there are pages after this window" — lets a caller loop without knowing `total` up front.
        "truncated": next_index < total,
        "startPage": start,
        "dpi": dpi,
        "dpiUsed": dpi_used,
        "skipped": skipped,
    }
