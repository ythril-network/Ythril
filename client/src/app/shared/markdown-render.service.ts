/**
 * Markdown → sanitized HTML, with ```mermaid fences rendered to inline SVG.
 *
 * Extracted from the Files preview when the Help page needed the same thing. There is exactly one
 * markdown pipeline in the app on purpose: the sanitization rules below are a security boundary, and a
 * second copy is a second place for them to drift. Both callers bind the result with
 * `bypassSecurityTrustHtml` — Angular's own sanitizer would strip the mermaid SVG — which is precisely
 * why the sanitizing has to be right here rather than at each call site.
 *
 * mermaid is heavy and lazy-imported: a document with no diagram never pays for it.
 */
import { Injectable } from '@angular/core';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { headingIdFor, headingSlug, headingTextOf, makeSlugger } from './heading-slug';

// Where the slug rule lives, so the Help gate can run it; kept exported here for the callers that read it from the renderer.
export { headingSlug };


/** Escapes a string for safe interpolation into HTML. Used for the invalid-diagram fallback. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

@Injectable({ providedIn: 'root' })
export class MarkdownRenderService {
  /**
   * Render markdown to sanitized HTML.
   *
   * A ```mermaid fence becomes an inline SVG diagram; an invalid one falls back to showing its source
   * rather than breaking the whole document, and a mermaid that fails to load leaves the surrounding
   * prose intact. Failure here degrades the page, it never blanks it.
   */
  async render(text: string): Promise<string> {
    const mermaidSources: string[] = [];
    const slug = makeSlugger();
    const md = new Marked({
      renderer: {
        code({ text: code, lang }) {
          if ((lang ?? '').trim().toLowerCase() === 'mermaid') {
            const i = mermaidSources.length;
            mermaidSources.push(code);
            return `<div class="mermaid-slot" data-idx="${i}"></div>`;
          }
          return false; // fall through to marked's default code renderer
        },
        // marked stopped emitting heading ids in v10. Without them every `](#anchor)` in a document —
        // including its own table of contents — points at nothing, and a deep link into a specific
        // section is impossible. `this.parser.parseInline` keeps inline markup inside the heading.
        heading({ tokens, depth }) {
          const inner = this.parser.parseInline(tokens);
          return `<h${depth} id="${escapeHtml(headingIdFor(slug(headingTextOf(inner))))}">${inner}</h${depth}>\n`;
        },
      },
    });
    let html = md.parse(text, { async: false }) as string;

    if (mermaidSources.length) {
      try {
        const mermaid = (await import('mermaid')).default;
        // htmlLabels:false → labels render as native SVG <text>, not <foreignObject> HTML. That keeps the
        // labels through DOMPurify's SVG sanitization (which strips foreignObject) and removes the
        // foreignObject XSS surface entirely.
        mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', theme: 'dark', htmlLabels: false,
          flowchart: { htmlLabels: false },
        });
        for (let i = 0; i < mermaidSources.length; i++) {
          const slot = `<div class="mermaid-slot" data-idx="${i}"></div>`;
          try {
            const { svg } = await mermaid.render(`md-mmd-${Date.now()}-${i}`, mermaidSources[i]);
            html = html.replace(slot, `<div class="mermaid-diagram">${svg}</div>`);
          } catch {
            // Invalid diagram → show its source rather than breaking the whole document.
            html = html.replace(slot, `<pre class="preview-code"><code>${escapeHtml(mermaidSources[i])}</code></pre>`);
          }
        }
      } catch {
        // mermaid failed to load — leave the empty slots; the surrounding prose still renders.
      }
    }

    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'] });
  }
}
