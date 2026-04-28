/**
 * Passthrough converters for formats that require no conversion.
 *   MarkdownPassthrough — returns file bytes as UTF-8 (used for .md)
 *   PlainTextPassthrough — returns file bytes as UTF-8 (used for .txt)
 */

import type { FileConverter } from './types.js';

export class MarkdownPassthrough implements FileConverter {
  async convert(fileBytes: Buffer, _fileName: string): Promise<string> {
    return fileBytes.toString('utf8');
  }
}

export class PlainTextPassthrough implements FileConverter {
  async convert(fileBytes: Buffer, _fileName: string): Promise<string> {
    return fileBytes.toString('utf8');
  }
}
