/**
 * `@ythril/schema/from-typescript`: a space's type schemas read back from TypeScript declarations, for an app that keeps its space's
 * shape as types and wants the meta the server stores. One call, {@link spaceMetaFromTypeScript}, answering the meta or the reasons
 * the source cannot be read.
 *
 * ## What the source says
 *
 * One exported interface or type alias (`SpaceTypes` unless `options.map` names another): a knowledge type, then a type name written as a
 * string literal, then `{ properties: <object type> }`. That is what {@link typesOfSpaceMeta} writes, and a source of the same shape written
 * by hand reads the same. A type's `stored` entry is ignored.
 *
 * ## What is deliberate in here
 *
 * **It loads the compiler only when called, and it is the caller's own.** `typescript` is an optional peer of this package, named here by
 * one dynamic literal `import('typescript')` and nowhere else in the package (a gate holds it). The main entry never loads it, and an app that
 * never reads TypeScript never installs it. The `typescript` option hands the call a module the app loaded itself (an app on a compiler
 * this package cannot read installs one in the peer range under an alias and passes it).
 *
 * **The compile is closed.** The host serves the source it was given and the compiler's own lib files, read through the loaded module's own
 * file access for exact `lib.*.d.ts` names inside its lib directory; every other path is answered absent without a read. Nothing of the
 * machine is a way into the compile: no import resolves, no `@types` package is read, no lib is replaced.
 *
 * **Whole or nothing.** A source with one member this cannot say exactly is refused as a whole, every refusal named by a reason of
 * {@link UNREPRESENTED_REASONS}; a type is never read as one near it. What the source cannot carry of a type the call DID read (a pattern,
 * a bound, a default, a description) is named in `notRead`, by path, and never read back. The server replaces each type it is handed
 * whole, so an app merges the result over the stored meta before it writes.
 *
 * **The source is text from outside.** It is judged by size before anything is parsed, refused for imports and for the comments that
 * switch the compiler's diagnostics off, compiled with every diagnostic of the file counted against it, and every name and message that
 * reaches an answer goes through `peerText`.
 */
import type * as TS from 'typescript';
import { KNOWLEDGE_TYPES, type KnowledgeType, type TypeSchema } from './vocabulary.js';
import { validateSpaceMeta } from './validate.js';
import { ENUM_LITERAL_MAX, SPACE_TYPES, SPACE_TYPE_PROPERTIES } from './typescript.js';
import { isObjectInternalKey } from './object-internal-keys.js';
import { ownValue, setOwn } from './plain-object.js';
import { NAME_QUOTED, REFUSAL_NAMES_MAX, peerText } from './text.js';

/**
 * The most characters of source one call reads. A longer source is refused (`source-too-large`) before the compiler loads and before anything
 * is parsed: the size is the one bound that costs nothing to judge, and what scales in a read (types, members, literals) scales with it.
 */
export const SOURCE_MAX = 500_000;

/**
 * Why a source was refused, the whole list: a reason added is a deliberate edit an app's `switch` can see.
 *
 * - `imports-not-read`: an import, an `export ... from` or a `/// <reference>`; the compile resolves nothing, so the source must be whole.
 * - `directive-not-read`: a `@ts-nocheck`, `@ts-ignore` or `@ts-expect-error` comment, which switches off the diagnostics that judge the source.
 * - `source-too-large`: more than {@link SOURCE_MAX} characters.
 * - `map-not-found`: no interface or type alias of the map's name, or a type of it with no object `properties` member.
 * - `unknown-kind`: a key of the map that is not one of the four knowledge types.
 * - `internal-name`: a type or member named `__proto__`, `constructor` or `prototype`, which no plain object can carry as a key.
 * - `null-not-representable`, `never-not-representable`: a member that admits `null`, or is `never` (or only `undefined`).
 * - `untyped-not-read`: a member that is `any`, or `unknown` on an entity (an entity value is a primitive), or an index signature that is not untyped.
 * - `date-not-representable`, `object-not-representable`, `array-not-representable`, `union-not-representable`, `method-not-representable`,
 *   `generic-not-representable`, `template-not-representable`, `branded-not-representable`: a member of that shape.
 * - `enum-too-long`: a union of literals longer than {@link ENUM_LITERAL_MAX}.
 * - `source-does-not-compile`: a diagnostic of the file (`code` is the compiler's number, `detail` its text).
 * - `compiler-failed`: the compiler threw on the source (a nesting deeper than it can follow, for one).
 * - `server-refuses`: what was read is not a meta the server stores; `detail` is the server's own sentence.
 */
export const UNREPRESENTED_REASONS = [
  'imports-not-read', 'directive-not-read', 'source-too-large', 'map-not-found', 'unknown-kind', 'internal-name', 'null-not-representable',
  'never-not-representable', 'untyped-not-read', 'date-not-representable', 'object-not-representable', 'array-not-representable',
  'union-not-representable', 'method-not-representable', 'generic-not-representable', 'template-not-representable',
  'branded-not-representable', 'enum-too-long', 'source-does-not-compile', 'compiler-failed', 'server-refuses',
] as const;

type Reason = (typeof UNREPRESENTED_REASONS)[number];

/** One thing in the source this cannot read: `path` is where (kind, type, `propertySchemas`, member), `detail` bounded text, `code` the diagnostic's number. */
export interface Refusal {
  path: string[];
  reason: Reason;
  detail: string;
  code?: number;
}

/** One thing of a type that WAS read which the source cannot carry, so the result does not hold it: `[kind, type, 'propertySchemas', member, field]`, or `[kind, type, 'description']`. */
export interface NotRead {
  path: string[];
}

/** What {@link spaceMetaFromTypeScript} takes beside the source. */
export interface FromTypeScriptOptions {
  /** The interface or type alias that holds the map; `SpaceTypes` when absent. */
  map?: string;
  /** A loaded TypeScript module (one in the peer range) to compile with, instead of the one the call loads for itself. Never kept for a later call. */
  typescript?: object;
}

/** What {@link spaceMetaFromTypeScript} answers: the meta read and what of it the source could not carry, or every reason it was refused (at most ten, `more` counts the rest). */
export type FromTypeScriptResult =
  | { ok: true; meta: { typeSchemas: Partial<Record<KnowledgeType, Record<string, TypeSchema>>> }; notRead: NotRead[] }
  | { ok: false; refusals: Refusal[]; more: number };

/** The loaded module: the parts of the compiler's API this reads. */
type Compiler = typeof TS;

/** The compiler cannot do what this asked of it (an environment fault, never the source's): the call rejects with it. */
class EnvironmentProblem extends Error {}

// ---------------------------------------------------------------------------------------------------------------------
// Loading the compiler
// ---------------------------------------------------------------------------------------------------------------------

/** The install command every "no usable compiler" rejection names. */
const INSTALL_HINT = 'npm install typescript@6';

/**
 * The install that keeps an app's own `typescript` (a release whose package has no compiler API, such as 7.x) and adds one that has it, under an alias the
 * app then passes as the `typescript` option. The peer range has no ceiling for the same reason: npm refuses the whole package beside a typescript outside it.
 */
const ALIAS_HINT = 'npm install typescript-6@npm:typescript@6';

/** The one rejection of every "no usable compiler" path: what to install, and how to hand an installed one in. */
function installError(why: string, cause?: unknown): Error {
  return new Error(
    `@ythril/schema/from-typescript needs the TypeScript compiler (${why}): install it beside the app with \`${INSTALL_HINT}\`, or pass a loaded one as the \`typescript\` option`,
    cause === undefined ? undefined : { cause },
  );
}

/** The rejection of a loaded `typescript` with no compiler API: the plain install would replace the app's own, so it also names the alias install. */
function noCompilerApiError(): Error {
  return installError(
    `the installed typescript has no compiler API; to keep it, \`${ALIAS_HINT}\` and pass \`(await import('typescript-6')).default\` as the \`typescript\` option`,
  );
}

/** The compiler a loaded module is: its default export when it has one (the CommonJS module's namespace), else the module. Anything without `createProgram` (a compiler whose API is another package's) is refused. */
function compilerOf(loaded: unknown): Compiler {
  const holder = loaded as { default?: unknown } | null | undefined;
  const candidate = (holder?.default ?? loaded) as Partial<Compiler> | null | undefined;
  if (typeof candidate?.createProgram !== 'function') throw noCompilerApiError();
  return candidate as Compiler;
}

/** The import in flight or settled: shared by concurrent first calls, dropped when it fails so a later install is found. */
let loading: Promise<Compiler> | undefined;

/** The compiler the call loads for itself, once; a failed load is not kept, and only "not found" is taken for a missing install. */
function loadCompiler(): Promise<Compiler> {
  loading ??= import('typescript').then(compilerOf).catch((error: unknown) => {
    loading = undefined;
    const e = error as { code?: unknown; message?: unknown } | null;
    const notFound = e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND';
    if (notFound && /['"]typescript['"]/.test(String(e?.message))) throw installError('it cannot be found', error);
    throw error;
  });
  return loading;
}

/** The compiler this call uses: the `typescript` option when given (never kept), else the one loaded once. */
async function compilerFor(options: unknown): Promise<Compiler> {
  const given = ownValue(options, 'typescript');
  return given === undefined ? loadCompiler() : compilerOf(given);
}

// ---------------------------------------------------------------------------------------------------------------------
// The closed host
// ---------------------------------------------------------------------------------------------------------------------

/** What one loaded compiler module has been asked for: where its lib is, and the lib files already parsed. */
interface LibSession {
  libDir: string;
  files: Map<string, TS.SourceFile>;
}

/** Per loaded module, so a second read with the same module reads no lib and a new module starts empty. */
const sessions = new WeakMap<object, LibSession>();

/** The name the source is compiled under. Any other path the compiler asks for is the lib's or absent. */
const ROOT = '/source.ts';

/** An exact lib file name: `lib.es5.d.ts`, `lib.es2015.core.d.ts`. */
const LIB_NAME = /^lib\.[a-z0-9.]{1,60}\.d\.ts$/i;

/** True when `path` is exactly a `lib.*.d.ts` file directly inside `libDir`: no `..`, no subdirectory, no sibling directory that shares the prefix. */
function isLibPath(path: unknown, libDir: string): path is string {
  return typeof path === 'string' && path.startsWith(`${libDir}/`) && LIB_NAME.test(path.slice(libDir.length + 1));
}

/** The options of every compile: the closed set. `libReplacement: false` is the one that keeps a package from answering a lib name. */
function closedOptions(c: Compiler): TS.CompilerOptions {
  return {
    strict: true, noEmit: true, types: [], noResolve: true, lib: ['lib.es2022.d.ts'], skipLibCheck: true, libReplacement: false,
    target: c.ScriptTarget.ES2022, module: c.ModuleKind.ESNext, moduleResolution: c.ModuleResolutionKind.Bundler,
  };
}

/**
 * A compiler host that serves the source and the lib and nothing else. Lib text comes through the module's own file access, for exact
 * names inside the lib directory only; every other path is answered absent WITHOUT a read, so no path the compiler (or a source) names
 * is ever asked of the machine. A lib file that cannot be read is noted in `unreadable`: it is the environment's fault, never the source's.
 */
function closedHost(c: Compiler, session: LibSession, source: string): { host: TS.CompilerHost; unreadable: () => string | undefined } {
  let unreadable: string | undefined;
  let sourceFile: TS.SourceFile | undefined;
  const readLib = (path: string): string | undefined => {
    const text = c.sys.readFile(path);
    if (text === undefined) unreadable ??= path.slice(session.libDir.length + 1);
    return text;
  };
  const host: TS.CompilerHost = {
    getSourceFile: (path, languageVersionOrOptions) => {
      if (path === ROOT) return (sourceFile ??= c.createSourceFile(path, source, languageVersionOrOptions, true));
      if (!isLibPath(path, session.libDir)) return undefined;
      let file = session.files.get(path);
      if (file === undefined) {
        const text = readLib(path);
        if (text === undefined) return undefined;
        file = c.createSourceFile(path, text, languageVersionOrOptions);
        session.files.set(path, file);
      }
      return file;
    },
    getDefaultLibFileName: options => c.getDefaultLibFilePath(options),
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    directoryExists: () => false,
    getCanonicalFileName: path => path,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: path => path === ROOT || (isLibPath(path, session.libDir) && c.sys.fileExists(path)),
    readFile: path => (path === ROOT ? source : isLibPath(path, session.libDir) ? readLib(path) : undefined),
  };
  return { host, unreadable: () => unreadable };
}

// ---------------------------------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------------------------------

/** A name of the source as a path segment of a refusal: escaped and bounded, never raw. */
const quoted = (name: string): string => peerText(name, { max: NAME_QUOTED });

/** The refusals of one call: the first {@link REFUSAL_NAMES_MAX} kept, the rest counted, so a source with thousands is one bounded answer. */
class Refusals {
  private readonly kept: Refusal[] = [];
  private total = 0;

  add(path: readonly string[], reason: Reason, detail: string, code?: number): void {
    this.total++;
    if (this.kept.length >= REFUSAL_NAMES_MAX) return;
    this.kept.push({ path: path.map(quoted), reason, detail: peerText(detail), ...(code === undefined ? {} : { code }) });
  }

  get count(): number {
    return this.total;
  }

  result(): FromTypeScriptResult {
    return { ok: false, refusals: this.kept, more: this.total - this.kept.length };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The source's text, before a program
// ---------------------------------------------------------------------------------------------------------------------

/** A comment that switches the compiler's diagnostics off. Looked for anywhere in the text, so no spelling of the comment (or a string that holds one) gets past. */
const DIRECTIVE = /@ts-(?:nocheck|ignore|expect-error)/g;

/** What the parsed `file` asks the compile to resolve: an import, an `export ... from`, an `import x = require()`, a reference directive. */
function importsOf(c: Compiler, file: TS.SourceFile): string[] {
  const found: string[] = [];
  for (const s of file.statements) {
    if (c.isImportDeclaration(s) || c.isImportEqualsDeclaration(s)) found.push('an import');
    else if (c.isExportDeclaration(s) && s.moduleSpecifier !== undefined) found.push('an export from another module');
  }
  found.push(...file.referencedFiles.map(() => 'a reference path directive'));
  found.push(...file.typeReferenceDirectives.map(() => 'a reference types directive'));
  found.push(...file.libReferenceDirectives.map(() => 'a reference lib directive'));
  if (file.hasNoDefaultLib) found.push('a no-default-lib directive');
  return found;
}

/** The refusals of the source's own text (what a parse and the comments say before a program exists), added to `refusals`. */
function refuseText(c: Compiler, source: string, refusals: Refusals): void {
  for (const _match of source.matchAll(DIRECTIVE)) refusals.add([], 'directive-not-read', 'a comment that switches off the diagnostics that judge the source');
  const parsed = c.createSourceFile(ROOT, source, c.ScriptTarget.ES2022, false, c.ScriptKind.TS);
  for (const what of importsOf(c, parsed)) refusals.add([], 'imports-not-read', `${what}: the compile resolves nothing, so the source must be whole`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a member
// ---------------------------------------------------------------------------------------------------------------------

/** A property as the result holds it: the kind, whether it is required, the enum in source order; nothing else. */
interface ReadProperty {
  type?: 'string' | 'number' | 'boolean';
  required?: true;
  enum?: (string | number)[];
}

/** A member read: its property and the fields the source could not carry, or the reason it is refused. */
type Member = { ok: true; property: ReadProperty; lost: string[] } | { ok: false; reason: Reason; detail: string };

/** The notes the forward direction writes above a property, in the order it writes them, each with the line that starts it. */
const NOTE_FIELDS: readonly { field: string; note: RegExp }[] = [
  { field: 'type', note: /^type (?:string|number|boolean|date)$/ },
  { field: 'pattern', note: /^pattern(?: |$)/ },
  { field: 'minimum', note: /^minimum(?: |$)/ },
  { field: 'maximum', note: /^maximum(?: |$)/ },
  { field: 'default', note: /^default(?: |$)/ },
  { field: 'mergeFn', note: /^mergeFn(?: |$)/ },
  { field: 'required', note: /^required:/ },
];

/** What a reading of one source needs of it: the compiler, the checker, the source file and the flags of the compiler's own numbering. */
class Reader {
  readonly checker: TS.TypeChecker;
  private readonly flags: Record<'undefined' | 'null' | 'never' | 'any' | 'unknown' | 'string' | 'number' | 'stringLiteral' | 'numberLiteral' | 'booleanLiteral' | 'template' | 'intersection' | 'object', number>;

  constructor(private readonly c: Compiler, program: TS.Program, private readonly file: TS.SourceFile) {
    this.checker = program.getTypeChecker();
    const f = c.TypeFlags;
    // A flag's number is the loaded compiler's, never this file's.
    this.flags = {
      undefined: f.Undefined | f.Void, null: f.Null, never: f.Never, any: f.Any, unknown: f.Unknown, string: f.String, number: f.Number,
      stringLiteral: f.StringLiteral, numberLiteral: f.NumberLiteral, booleanLiteral: f.BooleanLiteral, template: f.TemplateLiteral,
      intersection: f.Intersection, object: f.Object,
    };
  }

  /** The interface or type alias named `name`, declared at the top level of the source. */
  findMap(name: string): TS.InterfaceDeclaration | TS.TypeAliasDeclaration | undefined {
    for (const s of this.file.statements) if ((this.c.isInterfaceDeclaration(s) || this.c.isTypeAliasDeclaration(s)) && s.name.text === name) return s;
    return undefined;
  }

  /** `type` without the `undefined` an optional member adds, when that leaves one type. */
  withoutUndefined(type: TS.Type): TS.Type {
    if (!type.isUnion()) return type;
    const rest = type.types.filter(t => (t.flags & this.flags.undefined) === 0);
    return rest.length === 1 ? rest[0]! : type;
  }

  /** Whether `type` is an object type its members can be listed from (an interface or a literal), not a primitive whose apparent type has members. */
  isObject(type: TS.Type): boolean {
    return (type.flags & this.flags.object) !== 0;
  }

  /** The lines of the JSDoc block that leads `node` (the next token follows it within one line break), the comment markers off; empty when there is none. */
  private docLines(node: TS.Node): string[] {
    const sf = node.getSourceFile() as TS.SourceFile | undefined;
    if (sf === undefined || sf.fileName !== ROOT) return [];
    const text = sf.text;
    const ranges = this.c.getLeadingCommentRanges(text, node.pos) ?? [];
    const block = ranges.filter(r => r.kind === this.c.SyntaxKind.MultiLineCommentTrivia && text.startsWith('/**', r.pos)).at(-1);
    if (block === undefined || (text.slice(block.end, node.getStart(sf)).match(/\n/g)?.length ?? 0) > 1) return [];
    const lines = text.slice(block.pos + 3, block.end - 2).split(/\r?\n/);
    if (lines[0]?.trim() === '') lines.shift();
    if (lines.at(-1)?.trim() === '') lines.pop();
    return lines.map(l => l.replace(/^\s*\*? ?/, '')).filter(l => l !== '');
  }

  /** Whether the interface or type alias that declares `type` carries a description (a JSDoc block of its own). */
  hasDescription(type: TS.Type): boolean {
    const declaration = type.symbol?.declarations?.find(d => this.c.isInterfaceDeclaration(d) || this.c.isTypeAliasDeclaration(d));
    return declaration !== undefined && this.docLines(declaration).length > 0;
  }

  /**
   * The fields of a member the source states only as a note, in the order the forward direction writes them. The notes are read from the END
   * (a description that happens to look like a note is still the description); `type` counts only as a date (any other type is the member's own),
   * and `required` only for an optional member (a required member's note is its own).
   */
  notedFields(member: TS.Symbol, optional: boolean): string[] {
    const declaration = member.declarations?.find(d => this.c.isPropertySignature(d));
    const lines = declaration === undefined ? [] : this.docLines(declaration);
    const noted = new Set<string>();
    let order = NOTE_FIELDS.length;
    let i = lines.length - 1;
    for (; i >= 0; i--) {
      const line = lines[i]!.trimEnd();
      const at = NOTE_FIELDS.findIndex(f => f.note.test(line));
      if (at < 0 || at >= order) break;
      if (NOTE_FIELDS[at]!.field !== 'type' || line === 'type date') noted.add(NOTE_FIELDS[at]!.field);
      order = at;
    }
    const out = i >= 0 ? ['description'] : [];
    for (const { field } of NOTE_FIELDS) if (noted.has(field) && (field !== 'required' || optional)) out.push(field);
    return out;
  }

  /** The literals of a type node in the order the source writes them, through parentheses, unions and aliases (bounded in depth). */
  private literalsInSourceOrder(root: TS.Node | undefined): (string | number)[] {
    const c = this.c;
    const out: (string | number)[] = [];
    const visit = (node: TS.Node, depth: number): void => {
      if (depth > 8) return;
      if (c.isParenthesizedTypeNode(node)) visit(node.type, depth);
      else if (c.isUnionTypeNode(node)) for (const t of node.types) visit(t, depth);
      else if (c.isLiteralTypeNode(node)) {
        const lit = node.literal;
        if (c.isStringLiteral(lit) || c.isNoSubstitutionTemplateLiteral(lit)) out.push(lit.text);
        else if (c.isNumericLiteral(lit)) out.push(Number(lit.text));
        else if (c.isPrefixUnaryExpression(lit) && lit.operator === c.SyntaxKind.MinusToken && c.isNumericLiteral(lit.operand)) out.push(-Number(lit.operand.text));
      } else if (c.isTypeReferenceNode(node)) {
        let symbol = this.checker.getSymbolAtLocation(node.typeName);
        if (symbol !== undefined && (symbol.flags & c.SymbolFlags.Alias) !== 0) symbol = this.checker.getAliasedSymbol(symbol);
        const alias = symbol?.declarations?.find(c.isTypeAliasDeclaration);
        if (alias !== undefined) visit(alias.type, depth + 1);
      }
    };
    if (root !== undefined) visit(root, 0);
    return out;
  }

  /** The enum of a union of literals: the checker's values, in the source's order when the source's own literals are exactly those values (they are, unless a computed type hid some). */
  private enumValues(parts: readonly TS.Type[], declaration: TS.Declaration | undefined): (string | number)[] {
    const checked = parts.map(p => (p as TS.LiteralType).value as string | number);
    const typeNode = declaration !== undefined && this.c.isPropertySignature(declaration) ? declaration.type : undefined;
    const written = [...new Set(this.literalsInSourceOrder(typeNode))];
    return written.length === checked.length && written.every(v => checked.includes(v)) ? written : checked;
  }

  /** The reason an object type is refused, by its shape. */
  private objectReason(type: TS.Type): { reason: Reason; detail: string } {
    const c = this.c;
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return { reason: 'method-not-representable', detail: 'a function type' };
    if (type.symbol?.name === 'Date') return { reason: 'date-not-representable', detail: 'a Date' };
    const reference = ((type as TS.ObjectType).objectFlags & c.ObjectFlags.Reference) !== 0 ? (type as TS.TypeReference) : undefined;
    const target = reference?.target;
    if (target !== undefined && ((target.objectFlags & c.ObjectFlags.Tuple) !== 0 || target.symbol?.name === 'Array' || target.symbol?.name === 'ReadonlyArray')) {
      return { reason: 'array-not-representable', detail: 'an array or tuple' };
    }
    const named = peerText(this.checker.typeToString(type), { max: NAME_QUOTED });
    if (reference !== undefined && this.checker.getTypeArguments(reference).length > 0) return { reason: 'generic-not-representable', detail: `a generic type, ${named}` };
    if (type.aliasTypeArguments !== undefined && type.aliasTypeArguments.length > 0) return { reason: 'generic-not-representable', detail: `a generic alias, ${named}` };
    return { reason: 'object-not-representable', detail: `an object type, ${named}` };
  }

  /**
   * One type read as a property: what it is, or the reason it is refused. Everything is read from the checker's type, so an alias, an
   * interface reference or a union written through either reads as what it is; only the ORDER of an enum's values is read from the
   * source's own nodes, because the checker keeps a union's members in the order it met them.
   */
  classify(full: TS.Type, optionalMember: boolean, kind: KnowledgeType, declaration: TS.Declaration | undefined): Member {
    const flags = this.flags;
    const all = full.isUnion() ? full.types : [full];
    const parts = all.filter(p => (p.flags & flags.undefined) === 0);
    const optional = optionalMember || parts.length !== all.length;
    const lost: string[] = [];
    const read = (property: ReadProperty): Member => {
      if (!optional) property.required = true;
      return { ok: true, property, lost };
    };
    const refuse = (reason: Reason, detail: string): Member => ({ ok: false, reason, detail });
    const has = (p: TS.Type, flag: number): boolean => (p.flags & flag) !== 0;

    if (parts.some(p => has(p, flags.null))) return refuse('null-not-representable', 'a type that admits null');
    if (parts.length === 0) return refuse('never-not-representable', 'a type with no value but undefined');
    if (parts.length === 1) {
      const only = parts[0]!;
      if (has(only, flags.never)) return refuse('never-not-representable', 'never');
      if (has(only, flags.any)) return refuse('untyped-not-read', 'any');
      if (has(only, flags.unknown)) return kind === 'entity' ? refuse('untyped-not-read', 'unknown, on an entity (an entity value is a primitive)') : read({});
      if (has(only, flags.string)) return read({ type: 'string' });
      if (has(only, flags.number)) return read({ type: 'number' });
      if (has(only, flags.booleanLiteral)) { lost.push('enum'); return read({ type: 'boolean' }); }
      if (has(only, flags.stringLiteral)) return read({ type: 'string', enum: this.enumValues(parts, declaration) });
      if (has(only, flags.numberLiteral)) return read({ type: 'number', enum: this.enumValues(parts, declaration) });
      if (has(only, flags.template)) return refuse('template-not-representable', 'a template literal type');
      if (has(only, flags.intersection)) return refuse('branded-not-representable', 'an intersection (a branded type)');
      if (has(only, flags.object)) { const { reason, detail } = this.objectReason(only); return refuse(reason, detail); }
      return refuse('object-not-representable', `a type this does not read, ${peerText(this.checker.typeToString(only), { max: NAME_QUOTED })}`);
    }
    if (parts.every(p => has(p, flags.booleanLiteral))) return read({ type: 'boolean' });
    if (parts.every(p => has(p, flags.stringLiteral | flags.numberLiteral))) {
      if (parts.length > ENUM_LITERAL_MAX) return refuse('enum-too-long', `a union of ${parts.length} literals; at most ${ENUM_LITERAL_MAX} are read as an enum`);
      const type = parts.every(p => has(p, flags.stringLiteral)) ? 'string' : parts.every(p => has(p, flags.numberLiteral)) ? 'number' : undefined;
      return read({ ...(type === undefined ? {} : { type }), enum: this.enumValues(parts, declaration) });
    }
    // The forward direction's untyped entity value, string | number | boolean (the boolean is its two literals).
    const untypedEntity = parts.length === 4 && parts.filter(p => has(p, flags.string)).length === 1 && parts.filter(p => has(p, flags.number)).length === 1
      && parts.filter(p => has(p, flags.booleanLiteral)).length === 2;
    if (kind === 'entity' && untypedEntity) return read({});
    return refuse('union-not-representable', 'a union that is not literals of one base type');
  }

  /** One declared member of a `properties` type, read. */
  member(symbol: TS.Symbol, kind: KnowledgeType, anchor: TS.Node): Member {
    const declaration = symbol.declarations?.[0];
    if (declaration !== undefined && (this.c.isMethodSignature(declaration) || this.c.isMethodDeclaration(declaration))) {
      return { ok: false, reason: 'method-not-representable', detail: 'a method' };
    }
    const type = this.checker.getTypeOfSymbolAtLocation(symbol, declaration ?? anchor);
    return this.classify(type, (symbol.flags & this.c.SymbolFlags.Optional) !== 0, kind, declaration);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The space meta a TypeScript source declares, or every reason it cannot be read: the call the entry is for.
 *
 * `source` is the text of one TypeScript file with no import (a source {@link typesOfSpaceMeta} wrote reads as written). The answer is
 * whole or nothing: `{ ok: true, meta: { typeSchemas }, notRead }`, or `{ ok: false, refusals, more }` with no meta. `notRead` names, by
 * path, what a type the call read carried that the source cannot say (a pattern, a bound, a default, a description, a date's kind); the
 * server replaces each type it is handed whole, so merge the result over the stored meta before writing it.
 *
 * Rejects (never answers a refusal) when no compiler can be used (`npm install typescript@6`, or the `typescript` option), when the
 * compiler's own lib cannot be read, and for any load error other than "not found": none of those is the source's fault. A source over
 * {@link SOURCE_MAX} is refused before the compiler is even loaded.
 */
export async function spaceMetaFromTypeScript(source: string, options: FromTypeScriptOptions = {}): Promise<FromTypeScriptResult> {
  if (typeof source !== 'string') throw new TypeError('spaceMetaFromTypeScript reads a source text');
  const mapOption = ownValue(options, 'map');
  if (mapOption !== undefined && typeof mapOption !== 'string') throw new TypeError('the map option names an interface or type alias');
  const mapName = mapOption ?? SPACE_TYPES;

  const refusals = new Refusals();
  if (source.length > SOURCE_MAX) {
    refusals.add([], 'source-too-large', `${source.length} characters; at most ${SOURCE_MAX} are read`);
    return refusals.result();
  }
  const c = await compilerFor(options);
  let session = sessions.get(c);
  if (session === undefined) {
    const lib = c.getDefaultLibFilePath({});
    session = { libDir: lib.slice(0, lib.lastIndexOf('/')), files: new Map() };
    sessions.set(c, session);
  }
  const { host, unreadable } = closedHost(c, session, source);
  const unreadableLib = (): EnvironmentProblem => new EnvironmentProblem(`the TypeScript compiler's lib file ${unreadable()} could not be read`);

  try {
    refuseText(c, source, refusals);
    if (refusals.count > 0) return refusals.result();

    const program = c.createProgram([ROOT], closedOptions(c), host);
    if (unreadable() !== undefined) throw unreadableLib();
    const problems = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
    if (problems.length > 0) {
      throw new EnvironmentProblem(`the TypeScript compiler reports a problem with its own setup: ${peerText(c.flattenDiagnosticMessageText(problems[0]!.messageText, ' '))}`);
    }
    const file = program.getSourceFile(ROOT)!;
    let diagnostics: readonly TS.Diagnostic[] = program.getSyntacticDiagnostics(file);
    if (diagnostics.length === 0) diagnostics = program.getSemanticDiagnostics(file);
    if (unreadable() !== undefined) throw unreadableLib();
    for (const d of diagnostics) {
      const line = d.file !== undefined && d.start !== undefined ? `line ${d.file.getLineAndCharacterOfPosition(d.start).line + 1}: ` : '';
      refusals.add([], 'source-does-not-compile', `${line}${c.flattenDiagnosticMessageText(d.messageText, ' ')}`, d.code);
    }
    if (refusals.count > 0) return refusals.result();
    return readMap(new Reader(c, program, file), mapName, refusals);
  } catch (error) {
    if (error instanceof EnvironmentProblem) throw error;
    if (unreadable() !== undefined) throw unreadableLib();
    refusals.add([], 'compiler-failed', peerText(error));
    return refusals.result();
  }
}

/** The map's types read into a meta: the compile succeeded, so what is left is the shape of the map and of each member. */
function readMap(reader: Reader, mapName: string, refusals: Refusals): FromTypeScriptResult {
  const { checker } = reader;
  const map = reader.findMap(mapName);
  if (map === undefined) {
    refusals.add([], 'map-not-found', `no interface or type alias named ${peerText(mapName, { max: NAME_QUOTED })} is declared in the source`);
    return refusals.result();
  }
  const typeSchemas: Partial<Record<KnowledgeType, Record<string, TypeSchema>>> = {};
  const notRead: NotRead[] = [];
  const kinds = new Set<string>(KNOWLEDGE_TYPES);

  for (const kindSymbol of checker.getPropertiesOfType(checker.getTypeAtLocation(map.name))) {
    const kind = kindSymbol.name;
    if (!kinds.has(kind)) { refusals.add([kind], 'unknown-kind', 'a key of the map that is not one of the four knowledge types'); continue; }
    const types: Record<string, TypeSchema> = {};
    for (const typeSymbol of checker.getPropertiesOfType(reader.withoutUndefined(checker.getTypeOfSymbolAtLocation(kindSymbol, map)))) {
      const typeName = typeSymbol.name;
      if (isObjectInternalKey(typeName)) { refusals.add([kind, typeName], 'internal-name', 'a type named for an object\'s internals'); continue; }
      const propertiesSymbol = checker.getPropertyOfType(checker.getTypeOfSymbolAtLocation(typeSymbol, map), SPACE_TYPE_PROPERTIES);
      const properties = propertiesSymbol === undefined ? undefined : reader.withoutUndefined(checker.getTypeOfSymbolAtLocation(propertiesSymbol, map));
      if (properties === undefined || !reader.isObject(properties)) {
        refusals.add([kind, typeName], 'map-not-found', `the type has no object \`${SPACE_TYPE_PROPERTIES}\` member`);
        continue;
      }
      if (reader.hasDescription(properties)) notRead.push({ path: [kind, typeName, 'description'] });
      const members = checker.getPropertiesOfType(properties);
      const indexes = checker.getIndexInfosOfType(properties);
      const definition: TypeSchema = {};
      setOwn(types, typeName, definition);
      if (members.length > 0 && indexes.length > 0) {
        refusals.add([kind, typeName], 'object-not-representable', 'an index signature beside declared members');
      } else if (members.length === 0) {
        // No members: an open type. An index signature is the forward direction's spelling of one and must be untyped, as it writes it.
        for (const index of indexes) {
          const read = reader.classify(index.type, true, kind as KnowledgeType, undefined);
          if (!read.ok) refusals.add([kind, typeName], read.reason, read.detail);
          else if (read.property.type !== undefined || read.property.enum !== undefined) refusals.add([kind, typeName], 'untyped-not-read', 'an index signature that is typed: only an untyped one is an open type');
        }
      } else {
        const propertySchemas: NonNullable<TypeSchema['propertySchemas']> = {};
        for (const symbol of members) {
          const key = symbol.name;
          const at = [kind, typeName, 'propertySchemas', key];
          if (isObjectInternalKey(key)) { refusals.add(at, 'internal-name', 'a member named for an object\'s internals'); continue; }
          const read = reader.member(symbol, kind as KnowledgeType, map);
          if (!read.ok) { refusals.add(at, read.reason, read.detail); continue; }
          setOwn(propertySchemas, key, read.property);
          for (const field of [...reader.notedFields(symbol, read.property.required !== true), ...read.lost]) notRead.push({ path: [...at, field] });
        }
        definition.propertySchemas = propertySchemas;
      }
    }
    if (Object.keys(types).length > 0) setOwn(typeSchemas, kind, types);
  }
  if (refusals.count > 0) return refusals.result();

  const valid = validateSpaceMeta({ typeSchemas });
  if (!valid.ok) {
    for (const failed of valid.failed.length > 0 ? valid.failed : [valid.message]) refusals.add([], 'server-refuses', failed);
    return refusals.result();
  }
  return { ok: true, meta: { typeSchemas }, notRead };
}
