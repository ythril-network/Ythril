/**
 * The members of the client's components, services and directives that no template and no product source reads: the ONE reader, for the gate that holds
 * the client to "nothing is computed only for its spec".
 *
 * ## The question it answers
 *
 * *"Which public or protected member of an `@Component`, `@Directive` or `@Injectable` class is read by no template and by no non-spec source?"* The
 * project's unused check (`noUnusedLocals`) sees only private and local names, so a member that a spec alone reads stays green: bundle-231's Q-64 set the
 * Validate step's warning in `MediaProcessingStateService.stageClass`, a member no template had read since 6.4.0, its spec passed, and the live page
 * showed Validate green (Q-703).
 *
 * ## What counts as a read
 *
 * 1. **Source.** The TypeScript checker resolves every identifier of every non-spec `client/src` source to its symbol, so `state.stageClass`, an inherited
 *    member read through a subclass, and a destructured `const { stageClass } = state` all count, and a same-named member of another class does not.
 * 2. **The class's own template** (inline `template`, or the `templateUrl` file) and its `host` entries: any name in them. A template is a string to the
 *    compiler, so this is a token read; a name in markup text also counts, which can only hide a member, never flag one that is read.
 * 3. **A dotted name in any template or `host` entry** (`state.stageClass()`, `ref.focus()`): the receiver's type is not known to a token read, so the
 *    name counts for every member that carries it.
 *
 * Members read through a framework door nothing here can see are not candidates: a decorated member (`@Input`, `@Output`, `@HostListener`, `@ViewChild`...),
 * one initialised by `input()`, `output()`, `model()` or a query function, a lifecycle hook, an `override`, and a member the class's `implements` or `extends`
 * clause already declares (`writeValue`, `canDeactivate`...). Private members are `noUnusedLocals`'s.
 *
 * ## What it does not see
 *
 * A member reached by a computed key (`svc[name]`), by a string handed to a decorator, or read only to be written. A member in an allow-list entry is
 * skipped with its reason; the gate holds those.
 *
 * Specs and `client/src/app/testing/` are never a read and never a declaration: a member only they read is exactly the finding.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { REPO_ROOT, trackedSources } from './_sources.mjs';

/** Framework-called names, declared to be CALLED by Angular and never by us. */
const LIFECYCLE = new Set([
  'constructor', 'ngOnInit', 'ngOnChanges', 'ngDoCheck', 'ngOnDestroy', 'ngAfterViewInit', 'ngAfterViewChecked', 'ngAfterContentInit', 'ngAfterContentChecked',
]);
/** An initialiser that makes a member an input, an output or a query: its reader is a parent's template or the framework. */
const SIGNAL_API = new Set(['input', 'output', 'model', 'viewChild', 'viewChildren', 'contentChild', 'contentChildren', 'outputFromObservable']);
/** An initialiser that registers work for its side effect (`readonly paint = effect(...)`): the field is never meant to be read. */
const SIDE_EFFECT_API = new Set(['effect', 'afterRenderEffect', 'afterNextRender', 'afterEveryRender']);
const CLASS_DECORATORS = new Set(['Component', 'Directive', 'Injectable']);

const clientFiles = (root) => trackedSources('client/src', { floor: 150, specs: false, root }).filter(f => !f.startsWith('client/src/app/testing/'));

/** The identifier names of one template or host-binding text, as `{ plain, dotted }`: names read bare or after `this.`, and names read after another dot. */
function templateNames(text) {
  const plain = new Set();
  const dotted = new Set();
  const markup = text.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const m of markup.matchAll(/(?<before>\.\s*)?(?<name>[A-Za-z_$][\w$]*)/g)) {
    const before = markup.slice(Math.max(0, m.index - 5), m.index);
    if (m.groups.before && !/this\s*$/.test(before)) dotted.add(m.groups.name);
    else plain.add(m.groups.name);
  }
  // `this.name` also reads as a dotted name in another template's reference: the plain set already holds it.
  return { plain, dotted };
}

function decoratorCall(node, names) {
  for (const d of ts.getDecorators?.(node) ?? []) {
    const e = d.expression;
    const id = ts.isCallExpression(e) ? e.expression : e;
    if (ts.isIdentifier(id) && names.has(id.text)) return { decorator: d, call: ts.isCallExpression(e) ? e : null };
  }
  return null;
}

function objectProperty(obj, name) {
  return obj.properties.find(p => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
}

/**
 * Every unread member of the client's decorated classes, as `[{ file, line, cls, member }]`, sorted.
 *
 * @param {object}  [opts]
 * @param {Record<string,string>} [opts.overrides] repo-relative path -> source, read in place of the file, or added to the program when the path is not a client source (a planted defect)
 * @param {string}  [opts.root] the checkout to read, default this repository
 */
export function unreadClientMembers(opts = {}) {
  const { overrides = {}, root = REPO_ROOT } = opts;
  const tracked = clientFiles(root);
  const files = [...tracked, ...Object.keys(overrides).filter(f => !tracked.includes(f))];
  const abs = (f) => resolve(root, f).replace(/\\/g, '/');
  const overridden = new Map(Object.entries(overrides).map(([f, text]) => [abs(f), text]));

  const config = ts.readConfigFile(join(root, 'client/tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(root, 'client'));
  const host = ts.createCompilerHost({ ...parsed.options, noEmit: true });
  // The planted text is served through the host's reads, so the compiler parses it as it parses any file (no parse of this gate's own).
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (name) => overridden.get(name.replace(/\\/g, '/')) ?? readFile(name);
  host.fileExists = (name) => overridden.has(name.replace(/\\/g, '/')) || fileExists(name);
  const program = ts.createProgram(files.map(abs), { ...parsed.options, noEmit: true, types: [] }, host);
  const checker = program.getTypeChecker();
  const sources = files.map(f => program.getSourceFile(abs(f))).filter(Boolean);

  // Pass 1: the classes that are candidates, and every template text.
  const classes = [];
  const anyDotted = new Set();
  for (const sf of sources) {
    const visit = (node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        const dec = decoratorCall(node, CLASS_DECORATORS);
        if (dec) classes.push({ node, sf, dec, plain: new Set() });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  for (const c of classes) {
    const arg = c.dec.call?.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
    const texts = [];
    const template = objectProperty(arg, 'template');
    if (template) texts.push(template.initializer.getText(c.sf));
    const url = objectProperty(arg, 'templateUrl');
    if (url && ts.isStringLiteralLike(url.initializer)) texts.push(readFileSync(join(dirname(c.sf.fileName), url.initializer.text), 'utf8'));
    const hostBindings = objectProperty(arg, 'host');
    if (hostBindings) texts.push(hostBindings.initializer.getText(c.sf));
    for (const text of texts) {
      const { plain, dotted } = templateNames(text);
      for (const n of plain) c.plain.add(n);
      for (const n of dotted) anyDotted.add(n);
    }
  }

  // A base class's members are read by every subclass's template (`RecordTabBase.requestDelete` from each tab).
  const baseOf = (node) => {
    const clause = node.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
    const decl = clause && checker.getTypeAtLocation(clause.types[0]).symbol?.declarations?.find(ts.isClassDeclaration);
    return decl;
  };
  const own = new Map(classes.map(c => [c.node, new Set(c.plain)]));
  for (const c of classes) {
    for (let base = baseOf(c.node); base; base = baseOf(base)) {
      const baseClass = classes.find(k => k.node === base);
      if (baseClass) for (const n of own.get(c.node)) baseClass.plain.add(n);
    }
  }

  // Pass 2: every symbol a non-spec source resolves an identifier to, except at a member's own declaration.
  const read = new Set();
  const declarationNames = new Set();
  for (const c of classes) for (const m of c.node.members) if (m.name) declarationNames.add(m.name);
  // Keyed by declaration: a member read through an instantiated type (`inject(Svc)`) resolves to a transient copy of its symbol, never the symbol itself.
  const note = (symbol) => { for (const d of symbol?.declarations ?? []) read.add(d); };
  for (const sf of sources) {
    const visit = (node) => {
      if (ts.isIdentifier(node) && !declarationNames.has(node)) note(checker.getSymbolAtLocation(node));
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        const pattern = node.parent.parent;
        const source = ts.isVariableDeclaration(pattern) && pattern.initializer ? pattern.initializer : pattern;
        if (ts.isIdentifier(key)) note(checker.getTypeAtLocation(source).getProperty(key.text));
      }
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
        note(checker.getTypeAtLocation(node.expression).getProperty(node.argumentExpression.text));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const found = [];
  for (const c of classes) {
    const bases = [...(c.node.heritageClauses ?? [])].flatMap(h => h.types.map(t => checker.getTypeAtLocation(t)));
    for (const m of c.node.members) {
      if (!m.name || !(ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m))) continue;
      if (!ts.isIdentifier(m.name)) continue;
      const name = m.name.text;
      const flags = ts.getCombinedModifierFlags(m);
      if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Override)) continue;
      if (LIFECYCLE.has(name) || (ts.getDecorators?.(m) ?? []).length > 0) continue;
      if (ts.isPropertyDeclaration(m) && m.initializer) {
        let init = m.initializer;
        while (ts.isCallExpression(init) || ts.isPropertyAccessExpression(init)) init = ts.isCallExpression(init) ? init.expression : init.expression;
        if (ts.isIdentifier(init) && (SIGNAL_API.has(init.text) || SIDE_EFFECT_API.has(init.text))) continue;
      }
      if (bases.some(t => t.getProperty(name))) continue;
      if (c.plain.has(name) || anyDotted.has(name)) continue;
      if (read.has(m)) continue;
      const rel = c.sf.fileName.replace(/\\/g, '/').replace(`${abs('.')}/`, '');
      found.push({ file: rel, line: c.sf.getLineAndCharacterOfPosition(m.name.getStart(c.sf)).line + 1, cls: c.node.name.text, member: name });
    }
  }
  return found.sort((a, b) => (a.file + a.member).localeCompare(b.file + b.member));
}

/** The client sources the reader covers, for the gate's floor. */
export const clientSourceFiles = (root = REPO_ROOT) => clientFiles(root);
