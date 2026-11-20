/**
 * Takes the root object of a JSON-LD document apart far enough to read its `@graph` array one node at a time (bundle-270, slice S1).
 *
 * ## What it prevents
 *
 * The JSON-LD library keeps the whole value of the root object it is given (its tokenizer, `@bergos/jsonparse`, assigns every child to its
 * parent), and holds every statement of a root `@graph` array that has no `@id` until the root closes (`EntryHandlerPredicate` buffers them in
 * `unidentifiedGraphsBuffer`, `JsonLdParser.flushBuffer` releases them: the graph's name may still come). The memory of a reader that gave it the
 * product's own export, `{"@context": ..., "@graph": [ node, node, ... ]}`, followed the document, and over `RDF_MAX_UNPARSED_CHARS` it was
 * refused. This scanner reads the root's keys itself and hands the caller the array's nodes as text, one by one, so the caller can give the
 * library a document of its own for a few nodes at a time, with the root's `@context` and `@id`.
 *
 * ## What it takes, and what it leaves to the library
 *
 * It engages only for a root object whose keys before `@graph` are none, `@context`, `@id`, or `@context` then `@id`, and whose `@graph` is an
 * array (`mode` is `graph`). Any other document (a root array, a root with properties of its own, an alias for `@graph`, an `@id` before the
 * `@context`, a `@graph` that is not an array) is `library`: the caller reads it as it always did, whole, under its bounds.
 *
 * Once engaged it owns the grammar of the root and of the array (the nodes' insides are the library's): a bracket that closes the wrong thing, a
 * missing or doubled comma, text after the root, and a document that ends open are refused with their place. A key after the array is refused as
 * `not-streamable`: it may name the graph the array is in (`@id`) or add statements about it, which a stream cannot take back. One node over
 * `maxChars` is refused (`too-long`) before it is held whole.
 *
 * Characters are UTF-16 units, lines end at a line feed, and the place of a character is 1-based, as every reader of this module counts.
 */

/** Where in the document: 1-based. */
export interface GraphPlace { line: number; column: number }

export type GraphEvent =
  /** The root's keys before the array: their values as written (`@context`, `@id`), and where the context starts. Once, first. */
  | { kind: 'head'; context: string | undefined; id: string | undefined; place: GraphPlace }
  /** One element of the array as written, and where it starts. */
  | { kind: 'node'; text: string; place: GraphPlace }
  /** The root closed. */
  | { kind: 'end' };

export type GraphRefusalKind = 'malformed' | 'not-streamable' | 'too-long' | 'content-after';

/** What the scanner refuses: the caller turns it into its own refusal. */
export class GraphScanRefusal extends Error {
  constructor(readonly kind: GraphRefusalKind, reason: string, readonly place: GraphPlace) { super(reason); }
}

/** The place `chars` characters of `text` after `start`. */
export function placeAfter(start: GraphPlace, text: string, chars: number): GraphPlace {
  let { line, column } = start;
  for (let i = 0; i < chars; i += 1) {
    if (text.charCodeAt(i) === LINE_FEED) { line += 1; column = 1; } else column += 1;
  }
  return { line, column };
}

const LINE_FEED = 0x0a;
/** The longest key kept to be named or matched: `@graph`, `@context` and `@id` are shorter; a longer key is only ever "another key". */
const KEY_CHARS = 64;
const isSpace = (c: string): boolean => c === ' ' || c === '\n' || c === '\r' || c === '\t';

type Step = 'skip' | 'in' | 'done' | 'before' | 'bad';

/** Follows one JSON value (a string, a bracketed value, or a bare token) character by character, balancing its brackets by kind. */
class ValueSpan {
  private readonly open: string[] = [];
  private inString = false;
  private escaped = false;
  private begun = false;
  private bare = false;

  /** `skip`: white space before the value; `in`: the character is part of it; `done`: it ended with this character; `before`: a bare token ended before this one; `bad`: not JSON. */
  step(c: string): Step {
    if (!this.begun) {
      if (isSpace(c)) return 'skip';
      this.begun = true;
      if (c === '"') { this.inString = true; return 'in'; }
      if (c === '{' || c === '[') { this.open.push(c); return 'in'; }
      if (c === ',' || c === ':' || c === ']' || c === '}') return 'bad';
      this.bare = true;
      return 'in';
    }
    if (this.bare) return isSpace(c) || c === ',' || c === ']' || c === '}' ? 'before' : 'in';
    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (c === '\\') this.escaped = true;
      else if (c === '"') { this.inString = false; return this.open.length === 0 ? 'done' : 'in'; }
      return 'in';
    }
    if (c === '"') { this.inString = true; return 'in'; }
    if (c === '{' || c === '[') { this.open.push(c); return 'in'; }
    if (c === '}' || c === ']') {
      const top = this.open.pop();
      if (top === undefined || (c === '}') !== (top === '{')) return 'bad';
      return this.open.length === 0 ? 'done' : 'in';
    }
    return 'in';
  }
}

/** A value being collected: its text so far (in pieces), and where it started. */
interface Capture { span: ValueSpan; parts: string[]; length: number; from: number; started: boolean; place: GraphPlace }

type State =
  | 'start' | 'key-or-end' | 'key' | 'colon' | 'value' | 'prefix-value' | 'prefix-end'
  | 'node-start' | 'node' | 'node-end' | 'after-array' | 'trailing-key' | 'done';

export class GraphArrayScanner {
  /** `undecided` until the keys before `@graph` are read; then `graph` (this scanner reads on) or `library` (it reads nothing more). */
  mode: 'undecided' | 'library' | 'graph' = 'undecided';
  private state: State = 'start';
  private line = 1;
  private column = 1;
  private keyText = '';
  private keyEscape = false;
  private keyPlace: GraphPlace = { line: 1, column: 1 };
  private keyIsTrailing = false;
  private key: string | undefined;
  private readonly seen: string[] = [];
  private context: string | undefined;
  private contextPlace: GraphPlace = { line: 1, column: 1 };
  private id: string | undefined;
  private afterComma = false;
  private cap: Capture | undefined;

  constructor(private readonly maxChars: number) {}

  /** The events `piece` completes, in order; nothing once the document is `library`. */
  feed(piece: string): GraphEvent[] {
    const events: GraphEvent[] = [];
    for (let i = 0; i < piece.length && !this.isLibrary; i += 1) {
      const c = piece.charAt(i);
      while (!this.consume(c, i, piece, events) && !this.isLibrary) { /* the same character, read again under the state it moved to */ }
      if (c === '\n') { this.line += 1; this.column = 1; } else this.column += 1;
    }
    const cap = this.cap;
    if (cap?.started && !this.isLibrary) {
      cap.parts.push(piece.slice(cap.from));
      cap.length += piece.length - cap.from;
    }
    if (cap) cap.from = 0;
    return events;
  }

  /** At the end of the document: refuses one that ends inside its root. */
  finish(): void {
    if (this.mode === 'graph' && this.state !== 'done') throw new GraphScanRefusal('malformed', 'the JSON-LD document ends before its value is closed', this.here());
  }

  private get isLibrary(): boolean { return this.mode === 'library'; }

  private here(): GraphPlace { return { line: this.line, column: this.column }; }

  private toLibrary(): boolean { this.mode = 'library'; this.cap = undefined; return true; }

  private malformed(what: string): GraphScanRefusal { return new GraphScanRefusal('malformed', what, this.here()); }

  /** Reads `c` in the current state; false asks for the same character to be read again in the state it left. */
  private consume(c: string, i: number, piece: string, events: GraphEvent[]): boolean {
    switch (this.state) {
      case 'start':
        if (isSpace(c)) return true;
        if (c !== '{') return this.toLibrary();
        this.state = 'key-or-end';
        return true;
      case 'key-or-end':
        if (isSpace(c)) return true;
        if (c !== '"') return this.toLibrary();
        return this.beginKey(false);
      case 'key': return this.keyChar(c);
      case 'colon':
        if (isSpace(c)) return true;
        if (c !== ':') return this.toLibrary();
        this.state = 'value';
        return true;
      case 'value': return this.prefixValue(c, events);
      case 'prefix-value': return this.prefixChar(c, i, piece);
      case 'prefix-end':
        if (isSpace(c)) return true;
        if (c !== ',') return this.toLibrary();
        this.state = 'key-or-end';
        return true;
      case 'node-start':
        if (isSpace(c)) return true;
        if (c === ',') throw this.malformed('a comma where a node of the @graph array was expected');
        if (c === ']') {
          if (this.afterComma) throw this.malformed('a comma, then the end of the @graph array: a node is missing');
          this.state = 'after-array';
          return true;
        }
        this.cap = { span: new ValueSpan(), parts: [], length: 0, from: i, started: false, place: this.here() };
        this.state = 'node';
        return false;
      case 'node': return this.nodeChar(c, i, piece, events);
      case 'node-end':
        if (isSpace(c)) return true;
        if (c === ',') { this.afterComma = true; this.state = 'node-start'; return true; }
        if (c === ']') { this.state = 'after-array'; return true; }
        throw this.malformed(`"${c}" after a node of the @graph array, where a comma or the end of the array was expected`);
      case 'after-array':
        if (isSpace(c)) return true;
        if (c === '}') { this.state = 'done'; events.push({ kind: 'end' }); return true; }
        if (c !== ',') throw this.malformed(`"${c}" after the @graph array, where a comma or the end of the document was expected`);
        this.state = 'trailing-key';
        return true;
      case 'trailing-key':
        if (isSpace(c)) return true;
        if (c !== '"') throw this.malformed(`"${c}" where a key was expected`);
        return this.beginKey(true);
      case 'done':
        if (isSpace(c)) return true;
        throw new GraphScanRefusal('content-after', 'content follows the end of the JSON-LD document', this.here());
    }
  }

  private beginKey(trailing: boolean): boolean {
    this.keyText = '';
    this.keyEscape = false;
    this.keyIsTrailing = trailing;
    this.keyPlace = this.here();
    this.key = undefined;
    this.state = 'key';
    return true;
  }

  private keyChar(c: string): boolean {
    if (!this.keyEscape && c === '"') {
      const raw = this.keyText;
      let name: string | undefined = raw.length > KEY_CHARS ? undefined : raw;
      if (name !== undefined && name.includes('\\')) { try { name = JSON.parse(`"${name}"`) as string; } catch { name = undefined; } }
      if (this.keyIsTrailing) throw this.afterArrayKey(name ?? `${raw.slice(0, KEY_CHARS)}…`);
      this.key = name;
      this.state = 'colon';
      return true;
    }
    this.keyEscape = !this.keyEscape && c === '\\';
    if (this.keyText.length <= KEY_CHARS) this.keyText += c;
    return true;
  }

  private afterArrayKey(name: string): GraphScanRefusal {
    const reason = name === '@context'
      ? 'a @context must be the first key of its object, but one follows the @graph array, which is read as a stream and cannot be read again under it'
      : `the key "${name}" follows the @graph array; it may name the graph the array is in or add statements about it, which an array read as a stream cannot take back: put it before @graph`;
    return new GraphScanRefusal('not-streamable', reason, this.keyPlace);
  }

  /** The first character of a root key's value: `@graph` opens the array (this is where the document is decided); `@context` and `@id` are collected; any other key is the library's. */
  private prefixValue(c: string, events: GraphEvent[]): boolean {
    const key = this.key;
    if (key === '@graph') {
      if (isSpace(c)) return true;
      const before = this.seen.join(',');
      if (c !== '[' || !['', '@context', '@id', '@context,@id'].includes(before)) return this.toLibrary();
      this.mode = 'graph';
      this.state = 'node-start';
      this.afterComma = false;
      events.push({ kind: 'head', context: this.context, id: this.id, place: this.contextPlace });
      return true;
    }
    if ((key === '@context' && !this.seen.includes('@context') && !this.seen.includes('@id')) || (key === '@id' && !this.seen.includes('@id'))) {
      this.cap = { span: new ValueSpan(), parts: [], length: 0, from: 0, started: false, place: this.here() };
      this.state = 'prefix-value';
      return false;
    }
    return this.toLibrary();
  }

  /** A character of the value of `@context` or `@id`; one too long, or not JSON, leaves the document to the library (which refuses it by its own bound or its own parse). */
  private prefixChar(c: string, i: number, piece: string): boolean {
    const done = this.stepCapture(c, i, piece);
    if (done === 'skip' || done === 'in') return true;
    if (done === 'bad' || done === 'long') return this.toLibrary();
    if (this.key === '@context') { this.context = done.text; this.contextPlace = done.place; } else this.id = done.text;
    this.seen.push(this.key!);
    this.state = 'prefix-end';
    return done.step === 'done';
  }

  private nodeChar(c: string, i: number, piece: string, events: GraphEvent[]): boolean {
    const done = this.stepCapture(c, i, piece);
    if (done === 'skip' || done === 'in') return true;
    if (done === 'bad') throw this.malformed(`"${c}" in the @graph array, where a node was expected`);
    if (done === 'long') throw new GraphScanRefusal('too-long', 'a node of the @graph array is too long', this.cap?.place ?? this.here());
    events.push({ kind: 'node', text: done.text, place: done.place });
    this.state = 'node-end';
    return done.step === 'done';
  }

  /** Reads `c` into the value being collected: the value's text once it ends (`step` says whether `c` was its last character), or what is still going on. */
  private stepCapture(c: string, i: number, piece: string): 'skip' | 'in' | 'bad' | 'long' | { text: string; place: GraphPlace; step: 'done' | 'before' } {
    const cap = this.cap!;
    const step = cap.span.step(c);
    if (step === 'skip') return 'skip';
    if (!cap.started) { cap.started = true; cap.from = i; cap.place = this.here(); }
    if (step === 'bad') return 'bad';
    const length = cap.length + (i - cap.from) + (step === 'before' ? 0 : 1);
    if (length > this.maxChars) return 'long';
    if (step === 'in') return 'in';
    const end = step === 'done' ? i + 1 : i;
    const text = cap.parts.length ? cap.parts.join('') + piece.slice(cap.from, end) : piece.slice(cap.from, end);
    this.cap = undefined;
    return { text, place: cap.place, step };
  }
}
