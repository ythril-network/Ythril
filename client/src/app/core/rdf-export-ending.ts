/**
 * What an RDF records export says about itself at its end (Q-942): how many records it holds, whether it is whole, and the property values
 * it left out, read from the document the browser saved.
 *
 * ## Why it reads the document
 *
 * The server says the left-out values in the HTTP trailers too, but a browser's `fetch` never hands trailers to a page. The document is
 * the one place the page can read them: Turtle, TriG and N-Quads end with the `# ythril-export:` comment line, and JSON-LD (which has no
 * comments) with the report node `ythril:ExportReport`, written as the last item of its `@graph` on one line.
 *
 * ## What it prevents
 *
 * - **A cut-off file reported as saved.** An export that could not finish ends in a line no grammar allows (`!ythril-export-incomplete`);
 *   a document whose ending is missing was cut on the way. Both are `complete: false`, never a result with counts.
 * - **A left-out value said in the server's English.** Each value's reason is handed back as a {@link LeftOutReason}, which the screen words
 *   in the reader's language; a reason this client has no word for is kept as written, never dropped.
 */

/** Why a value was left out, as the server's `REASON_WORDS` say it. */
export type LeftOutReason = 'notPlain' | 'notFit' | 'noAddress' | 'other';

export interface LeftOutValue { record: string; key: string; reason: LeftOutReason; reasonText: string }

export interface RdfExportEnding {
  complete: boolean;
  records: number;
  leftOutCount: number;
  /** The values named (the server names at most 100). */
  leftOut: LeftOutValue[];
}

const REASONS: Readonly<Record<string, LeftOutReason>> = {
  'not a plain value': 'notPlain',
  'does not fit its declared type': 'notFit',
  'a key with no address': 'noAddress',
};

const reasonOf = (text: string): LeftOutReason => REASONS[text.trim()] ?? 'other';

/** The line an export that could not finish ends with. */
const INCOMPLETE_MARK = '!ythril-export-incomplete';
const COMMENT = '# ythril-export: ';
/** A JSON-LD export's last lines: the report item, the `@graph` list's `]`, the document's `}`. */
const JSONLD_ENDING_LINES = 3;

/** The ending of a Turtle, TriG or N-Quads document, from its last lines. */
function endingOfText(tail: string): RdfExportEnding | null {
  const lines = tail.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.length > 0);
  if (lines.at(-1) === INCOMPLETE_MARK) return { complete: false, records: 0, leftOutCount: 0, leftOut: [] };
  const line = [...lines].reverse().find(l => l.startsWith(COMMENT));
  if (!line || line !== lines.at(-1)) return null;
  const parts = line.slice(COMMENT.length).split('; ');
  const records = Number(/^(\d+) records/.exec(parts[0] ?? '')?.[1] ?? NaN);
  const left = parts.find(p => /^\d+ property values left out/.test(p)) ?? '';
  const leftOutCount = Number(/^(\d+)/.exec(left)?.[1] ?? 0);
  const words = left.includes(': ') ? left.slice(left.indexOf(': ') + 2) : '';
  const leftOut: LeftOutValue[] = [];
  // Each value is `<record> (<key>: <reason>)`, the list closed by `and N more` when more were left out than named.
  for (const m of words.matchAll(/(?:^|, )(?<record>.+?) \((?<key>[^():]*): (?<why>[^()]*)\)(?=, |$)/g)) {
    const { record = '', key = '', why = '' } = m.groups ?? {};
    leftOut.push({ record, key, reason: reasonOf(why), reasonText: why });
  }
  return { complete: Number.isFinite(records) && !parts.some(p => p.startsWith('INCOMPLETE')), records: Number.isFinite(records) ? records : 0, leftOutCount, leftOut };
}

/** A node's value under a key that ends in `name` (compacted `ythril:name` or the whole address). */
function valueOf(node: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(node).find(k => k === name || k.endsWith(`:${name}`) || k.endsWith(`/${name}`) || k.endsWith(`#${name}`));
  const v = key === undefined ? undefined : node[key];
  const one = Array.isArray(v) ? v[0] : v;
  return one !== null && typeof one === 'object' ? ((one as Record<string, unknown>)['@value'] ?? (one as Record<string, unknown>)['@id']) : one;
}

const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** The ending of a JSON-LD document: its report node, the last item of its `@graph`. */
function endingOfJsonLd(tail: string): RdfExportEnding | null {
  const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
  // The writer closes with `]` and `}` on lines of their own, after the report item's one line.
  const [last, closeList, closeDoc] = lines.slice(-JSONLD_ENDING_LINES);
  if (closeDoc !== '}' || closeList !== ']' || !last?.startsWith('{')) return null;
  let item: { '@graph'?: Record<string, unknown>[] };
  try { item = JSON.parse(last.replace(/,$/, '')) as typeof item; } catch { return null; }
  const nodes = item['@graph'] ?? [];
  const report = nodes.find(n => valueOf(n, 'recordCount') !== undefined);
  if (!report) return null;
  const byId = new Map(nodes.map(n => [String(n['@id'] ?? ''), n]));
  const leftKey = Object.keys(report).find(k => k.endsWith('leftOutValue'));
  const leftOut = listOf(leftKey ? report[leftKey] : undefined).map(ref => {
    const node = byId.get(String((ref as Record<string, unknown>)?.['@id'] ?? '')) ?? {};
    const reasonText = String(valueOf(node, 'leftOutReason') ?? '');
    return { record: String(valueOf(node, 'leftOutRecord') ?? ''), key: String(valueOf(node, 'leftOutKey') ?? ''), reason: reasonOf(reasonText), reasonText };
  });
  return {
    complete: String(valueOf(report, 'complete')) === 'true',
    records: Number(valueOf(report, 'recordCount') ?? 0),
    leftOutCount: Number(valueOf(report, 'leftOutCount') ?? 0),
    leftOut,
  };
}

/**
 * The ending of a saved export, from its last bytes (`tail`, the document's last 256 KiB is plenty: the server names at most 100 values).
 * `null` when the document has no ending: it was cut off on the way, and the screen says so.
 */
export function rdfExportEnding(tail: string, format: 'turtle' | 'trig' | 'nquads' | 'jsonld'): RdfExportEnding | null {
  return format === 'jsonld' ? endingOfJsonLd(tail) : endingOfText(tail);
}

/** A header's list of space ids (`Ythril-View-Members-Without-Rdf`), [] when absent. */
export function headerList(value: string | null): string[] {
  // Each id is percent-encoded by the server (a header value is Latin-1).
  return (value ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
}
