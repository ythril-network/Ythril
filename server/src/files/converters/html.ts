/**
 * HtmlConverter — converts HTML to Markdown via jsdom + @mozilla/readability + turndown.
 * No network call; purely in-process.
 */

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import type { FileConverter } from './types.js';
import { ConversionUnavailableError } from './types.js';

// jsdom builds the full DOM in-process — parsing cost is highly non-linear in
// input size, so HTML gets a tighter cap than the sidecar-backed formats.
const MAX_HTML_BYTES = 25 * 1024 * 1024;

export class HtmlConverter implements FileConverter {
  async convert(fileBytes: Buffer, _fileName: string): Promise<string> {
    if (fileBytes.length > MAX_HTML_BYTES) {
      throw new ConversionUnavailableError(
        'too_large',
        `HTML input is ${fileBytes.length} bytes; in-process conversion is capped at ${MAX_HTML_BYTES} bytes`,
      );
    }
    const html = fileBytes.toString('utf8');

    const dom = new JSDOM(html, { url: 'http://localhost/' });
    const article = new Readability(dom.window.document).parse();

    if (!article || !article.content?.trim()) {
      throw new ConversionUnavailableError('no_content', 'Readability could not extract article content');
    }

    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    const md = td.turndown(article.content);

    if (!md.trim()) {
      throw new ConversionUnavailableError('no_content', 'Turndown produced empty Markdown');
    }

    return md;
  }
}
