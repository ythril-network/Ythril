/**
 * The structural-window helper is tested, because twenty gates are about to trust it.
 *
 * ## Why this file exists
 *
 * `_structural-window.mjs` replaces a character count in twenty gates. A character count fails LOUDLY when it falls
 * short — the assertion inside it stops matching and the gate goes red on correct code, which is annoying and
 * visible. A broken *structural* bound fails QUIETLY: it returns a window that is too small, every assertion inside
 * it still passes on the smaller text, and twenty gates go on reporting green while checking less than they say.
 *
 * That is a strictly worse failure than the one being fixed, and it is only worse because nobody would look. So the
 * helper is asserted directly, on inputs built to break it, before anything depends on it.
 *
 * ## The cases that matter
 *
 * Not "does it find a brace" — every naive walker does. The three that separate this from the naive versions three
 * other gates hand-rolled:
 *
 *  - a bracket inside a STRING must not count (`'}'`, `"("`, a template literal);
 *  - a bracket inside a COMMENT must not count (`// }` and the block form);
 *  - an ESCAPED quote must not end the string it is in (`'it\'s'`), or everything after it is read as code.
 *
 * Each of those is a real construct in the files these gates read.
 *
 * Run: node --test testing/standalone/structural-window-helper.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  argumentsOf,
  balancedFrom,
  bodyOf,
  docCommentBefore,
  enclosingBlockAround,
  enclosingBlockFrom,
  enclosingBlocksMatching,
  enclosingMarkupBlocksMatching,
  lineBefore,
  markdownSectionAround,
  markdownSectionFrom,
  markdownSectionWithSubsections,
  openTagAt,
  statementAround,
  statementFrom,
  statementUpTo,
  yamlItemAt,
} from './_structural-window.mjs';

describe('balancedFrom — the bound is the matching bracket', () => {
  it('reads a whole call, including nested brackets', () => {
    const src = 'const x = call(a, inner(b, c), [1, 2]);\nconst y = 1;';
    assert.equal(balancedFrom(src, src.indexOf('call(')), '(a, inner(b, c), [1, 2])');
  });

  it('a closing bracket inside a STRING does not end the window', () => {
    // The failure mode the three hand-rolled walkers all have. A message containing a brace is ordinary in this
    // codebase — every assertion failure text is one — so this is not a theoretical input.
    const src = `assert.ok(x, 'a } and a ) in a message');\nconst next = 1;`;
    const got = balancedFrom(src, src.indexOf('assert.ok('));
    assert.ok(got.includes('in a message'), 'the window stopped at a brace inside a string literal');
    assert.ok(got.endsWith(')'));
  });

  it('a bracket inside a LINE COMMENT does not end the window', () => {
    const src = 'fn(\n  a,   // }\n  b,\n);\nconst after = 1;';
    const got = balancedFrom(src, src.indexOf('fn('));
    assert.ok(got.includes('b,'), 'the window stopped at a brace inside a comment');
  });

  it('a bracket inside a BLOCK COMMENT does not end the window', () => {
    const src = 'fn(\n  a,\n  /* ) and } */\n  b,\n);\nconst after = 1;';
    const got = balancedFrom(src, src.indexOf('fn('));
    assert.ok(got.includes('b,'), 'the window stopped at a bracket inside a block comment');
  });

  it('an ESCAPED quote does not end the string', () => {
    // If it did, the rest of the file would be scanned as code and the first stray brace would close the window.
    const src = "fn('it\\'s fine, and a ) here', last);\nconst after = 1;";
    const got = balancedFrom(src, src.indexOf('fn('));
    assert.ok(got.includes('last'), 'an escaped quote ended the string and the window closed early');
  });

  it('a template literal is skipped like any other string', () => {
    const src = 'fn(`a } and a ) inside`, last);\nconst after = 1;';
    assert.ok(balancedFrom(src, src.indexOf('fn(')).includes('last'));
  });

  it('anchors on a BLOCK when pointed at its brace', () => {
    const src = 'if (!range) {\n  process.exit(1);\n}\nconst after = 1;';
    const got = balancedFrom(src, src.indexOf('{'));
    assert.ok(got.startsWith('{') && got.endsWith('}'));
    assert.ok(got.includes('process.exit(1)'));
  });

  it('says so rather than returning a short window when the group never closes', () => {
    // The whole point. An unbounded window must be an error, never a silently smaller subject.
    assert.throws(() => balancedFrom('fn(a, b', 0), /never closed/);
    assert.throws(() => balancedFrom('no brackets here', 0), /no bracket/);
  });
});

describe('a regex literal is not code and not a string — it is skipped whole', () => {
  /*
   * The lexing hole that produced this: `api/files.ts` writes
   *
   *     path.basename(normalised).replace(/[\r\n"\\]/g, '')
   *
   * and the `"` inside that character class opened a phantom string. It swallowed the next 350 characters and the
   * brackets in them, so `argumentsOf` reported the route registration it was reading as never closed.
   *
   * It failed loudly there, which is luck: the same phantom string inside a `doesNotMatch` bound makes the window
   * SMALLER and the absence hold. So these are pinned per shape rather than as one case.
   */
  it('a quote inside a character class does not open a string', () => {
    const s = String.raw`f(a.replace(/["']/g, ''), guard, h)`;
    assert.deepEqual(argumentsOf(s, 1), ["a.replace(/[\"']/g, '')", 'guard', 'h']);
  });

  it('a bracket inside a regex does not change the depth', () => {
    const s = 'f(x.split(/[({[]/), last)';
    assert.deepEqual(argumentsOf(s, 1), ['x.split(/[({[]/)', 'last']);
  });

  it('a slash inside a character class does not end the pattern', () => {
    // A `/` is a legal ClassChar, so `[/x]` does not close the pattern. Read as closing it, the walk resumes
    // mid-pattern and every bracket after it counts at the wrong depth.
    const s = "f(p.replace(/[/x]/g, '_'), h)";
    const args = argumentsOf(s, 1);
    assert.equal(args.length, 2, `the pattern ended early: ${JSON.stringify(args)}`);
    assert.equal(args[1], 'h');
  });

  it('DIVISION is still division — a `/` after a value must not eat the rest of the line', () => {
    // The other direction, and the one a naive fix breaks: treating every `/` as a pattern start makes
    // `(a + b) / 2, next` one argument, silently.
    const s = 'f((a + b) / 2, next)';
    assert.deepEqual(argumentsOf(s, 1), ['(a + b) / 2', 'next']);
  });

  it('a regex after `return` or `case` is a pattern, not division', () => {
    const s = 'f(() => { return /,/.test(x); }, after)';
    assert.deepEqual(argumentsOf(s, 1), ['() => { return /,/.test(x); }', 'after']);
  });

  it('an unterminated regex stops at the newline rather than running to the end of the file', () => {
    // A `/` this heuristic mis-reads as a pattern must cost one line, never the rest of the source.
    const s = 'f(a, b)\ng(c, d)';
    assert.deepEqual(argumentsOf(s, 1), ['a', 'b']);
  });

  it('the statement bound sees a statement that follows a regex', () => {
    const src = 'const clean = raw.replace(/[")}]/g, "");\nconst next = other(1, 2);\n';
    assert.match(statementFrom(src, src.indexOf('const next'), 'the next statement'), /^const next = other\(1, 2\);$/);
  });
});

describe('argumentsOf — a claim about one argument cannot be answered by another', () => {
  const ROUTE = "router.get('/x', requireAuth, requireRights({ a: 1, b: [2, 3] }), async (req, res) => { ok(); });";

  it('splits at the call\'s OWN commas and nowhere else', () => {
    assert.deepEqual(argumentsOf(ROUTE, ROUTE.indexOf('(')), [
      "'/x'",
      'requireAuth',
      'requireRights({ a: 1, b: [2, 3] })',
      'async (req, res) => { ok(); }',
    ]);
  });

  it('a comma inside an object, an array, a string or the handler is not a boundary', () => {
    // Every one of these would split the list further if the walk ignored depth — and the middleware chain
    // would then include the two halves of the handler's own parameter list as separate entries.
    const args = argumentsOf(ROUTE, ROUTE.indexOf('('));
    assert.equal(args.length, 4, `depth-blind splitting: ${JSON.stringify(args)}`);
    assert.match(args[3], /^async \(req, res\)/, 'the handler must arrive whole');
  });

  it("a comma in a string argument doesn't split it", () => {
    const s = "t('a, b', guard, h)";
    assert.deepEqual(argumentsOf(s, s.indexOf('(')), ["'a, b'", 'guard', 'h']);
  });

  it('a single argument is one part, and an empty list is none', () => {
    assert.deepEqual(argumentsOf('f(only)', 1), ['only']);
    assert.deepEqual(argumentsOf('f()', 1), []);
  });

  it('a trailing comma does not produce an empty argument', () => {
    assert.deepEqual(argumentsOf('f(a, b,)', 1), ['a', 'b']);
  });

  it('the whole list is still bounded by the matching bracket, however long it is', () => {
    // The property the cap it replaced did not have: 6 429 characters between the path and the handler is
    // not a reason to stop reading. `GET /api/tokens/rights-catalog` is that route.
    const long = `f('/p', guard, async (req, res) => { ${'// pad\n'.repeat(400)} });`;
    const args = argumentsOf(long, 1);
    assert.equal(args.length, 3);
    assert.match(args[2], /^async \(req, res\)/);
  });
});

describe('statementFrom — the bound is the terminator', () => {
  it('reaches the semicolon past nested calls and strings', () => {
    const src = "const s = z.object({ a: 1 }).strict();\nconst t = 2;";
    const got = statementFrom(src, src.indexOf('z.object('));
    assert.ok(got.includes('.strict()'), 'a nested object hid the end of the statement');
    assert.ok(got.endsWith(';'));
  });

  it('a semicolon inside a string is not the end', () => {
    const src = "fn('a ; here');\nconst after = 1;";
    assert.ok(statementFrom(src, 0).includes('here'));
  });

  it('works from the MIDDLE of an expression, where depth goes negative', () => {
    /*
     * The case that made this unusable. The walk starts at the anchor, so brackets opened BEFORE it close into
     * negative depth: `endsAt` inside `{ endsAt: z.string() }` reaches its `;` at relative depth -2. Requiring
     * exactly 0 reported "no statement terminator" on ordinary code, and a gate converted to use it failed.
     */
    const src = 'const S = z.object({ endsAt: z.string().optional() });\nconst after = 1;';
    const got = statementFrom(src, src.indexOf('endsAt'));
    assert.ok(got.endsWith(';'));
    assert.ok(!got.includes('const after'), 'it ran past the end of the statement');
  });

  it('and from inside a nested block', () => {
    const src = 'fn(() => {\n  if (a.endsAt < a.startsAt) throw new Error("no");\n});\n';
    const got = statementFrom(src, src.indexOf('endsAt'));
    assert.ok(got.includes('startsAt'), 'the rest of the comparison is outside the window');
    assert.ok(got.endsWith(';'));
  });

  it('a missing terminator is an error, not a short window', () => {
    assert.throws(() => statementFrom('const x = 1', 0), /no statement terminator/);
  });
});

describe('statementUpTo — the bound behind an anchor is where its statement starts', () => {
  it('THE case that broke the first version: an options object is not a statement boundary', () => {
    /*
     * Taking the nearest `;`, `{` or `}` at any depth makes the closing brace of the options object the boundary,
     * so the window starts at `) : await ` — and the gate that asks "is this fetch behind a locality test?"
     * answers no about a fetch that plainly is. Found by running the converted gate, not by reasoning.
     */
    const src = [
      '  let res;',
      '  try {',
      '    res = endpoint.external',
      '      ? await ssrfSafeFetch(url, init, { allowPrivate: allowPrivateForSlot(endpoint.slot) })',
      '      : await fetch(url, init);',
      '  } catch (err) { throw err; }',
    ].join('\n');
    const at = src.lastIndexOf('fetch(url, init)');
    const got = statementUpTo(src, at);
    assert.ok(got.includes('endpoint.external'), 'the locality test is outside the window');
    assert.ok(!got.includes('let res'), 'the window ran back past the start of the statement');
  });

  it('a preceding statement ends the window', () => {
    const src = 'const a = 1;\nconst b = choose ? one() : two();';
    const got = statementUpTo(src, src.indexOf('two()'));
    assert.ok(got.includes('choose'));
    assert.ok(!got.includes('const a'), 'the previous statement is inside the window');
  });

  it('a semicolon inside a nested arrow does not end the outer statement', () => {
    const src = 'const f = flag\n  ? (x) => { return g(x); }\n  : (x) => h(x);';
    const got = statementUpTo(src, src.indexOf('h(x)'));
    assert.ok(got.includes('flag'), 'a nested block ended the statement early');
  });

  it('a semicolon in a string is not a boundary', () => {
    const src = "const msg = 'a ; here';\nconst v = flag ? a() : b();";
    assert.ok(statementUpTo(src, src.indexOf('b()')).includes('flag'));
  });

  it('grows with the statement, which is the whole point', () => {
    const base = 'const v = someVeryLongCondition\n  ? a()\n  : b();';
    const grown = base.replace('someVeryLongCondition', 'someVeryLongCondition /* ' + 'x'.repeat(800) + ' */');
    assert.ok(statementUpTo(grown, grown.lastIndexOf('b()')).includes('someVeryLongCondition'));
  });
});

describe('statementAround — safe when the anchor is inside a string', () => {
  it('THE case that broke the composed version: a quoted FIELD NAME', () => {
    /*
     * `statementUpTo(at) + statementFrom(at)` looks equivalent and is not. `statementFrom` starts walking AT the
     * anchor, so when the anchor is inside `'endsAt'` it reads that string's own closing quote as an OPENING one,
     * desynchronises quote parity for the rest of the file, and reports "no statement terminator" on ordinary code.
     *
     * This is not a contrived input: any gate matching an identifier that also appears as a quoted field name hits
     * it, and one did — the chrono source lists `'startsAt', 'endsAt'` in an array of updatable fields.
     */
    const src = "const FIELDS = [\n  'title', 'startsAt', 'endsAt', 'status',\n];\nconst after = 1;";
    const got = statementAround(src, src.indexOf("endsAt"));
    assert.ok(got.includes('FIELDS'), 'it did not reach the start of the statement');
    assert.ok(got.trimEnd().endsWith(';'), 'it did not reach the end of the statement');
    assert.ok(!got.includes('const after'), 'it ran past the statement');
  });

  it('returns the whole statement from an anchor in the middle of real code', () => {
    const src = 'const a = 1;\nif (rec.endsAt < rec.startsAt) throw new Error("out of order");\nnext();';
    const got = statementAround(src, src.indexOf('endsAt'));
    assert.ok(got.includes('startsAt'));
    assert.ok(!got.includes('const a'), 'it ran back past the statement');
    assert.ok(!got.includes('next()'), 'it ran forward past the statement');
  });
});

describe('enclosingBlockFrom — the bound is the brace that closes what you are inside', () => {
  it('returns the rest of the branch the anchor sits in', () => {
    const src = 'if (deep) {\n  counter++;\n  log.warn(`DROPPED ${id}`);\n}\nnext();';
    const got = enclosingBlockFrom(src, src.indexOf('counter++'));
    assert.ok(got.includes('DROPPED'), 'the rest of the branch was not covered');
    assert.ok(!got.includes('next()'), 'the window ran past the end of the branch');
  });

  it('nested blocks inside the branch do not end it early', () => {
    const src = 'if (a) {\n  if (b) { inner(); }\n  tail();\n}\nafter();';
    const got = enclosingBlockFrom(src, src.indexOf('if (b)'));
    assert.ok(got.includes('tail()'), 'a nested block closed the window');
    assert.ok(!got.includes('after()'));
  });

  it('a brace in a message does not end the branch', () => {
    const src = "if (a) {\n  fail('} not real');\n  tail();\n}\nafter();";
    assert.ok(enclosingBlockFrom(src, src.indexOf('fail(')).includes('tail()'));
  });
});

describe('openTagAt — the bound for an assertion about attributes', () => {
  it('returns exactly the opening tag', () => {
    const src = '<div class="tabs" role="tablist" aria-label="Brain views">\n  <button>x</button>\n</div>';
    const got = openTagAt(src, src.indexOf('<div'));
    assert.ok(got.startsWith('<div') && got.endsWith('>'));
    assert.ok(got.includes('aria-label'), 'a long attribute list was cut');
    assert.ok(!got.includes('<button'), 'the window ran into the children');
  });

  it('an attribute added at the end is still inside the window', () => {
    // The Space Admin failure in one line: a fifth column pushed the subject past a character count. Here the
    // subject grows and the bound grows with it.
    const grown = '<div class="tabs" role="tablist" aria-label="x" data-extra="' + 'y'.repeat(500) + '">';
    assert.ok(openTagAt(grown, 0).includes('data-extra'));
  });
});

describe('markdownSectionFrom — prose is bounded by the next heading', () => {
  const doc = '# Title\n\nWorks fully offline. Enforced with HF_HUB_OFFLINE=1.\n\n## Next\n\nSomething else.\n';

  it('covers the claim and everything said about it', () => {
    const got = markdownSectionFrom(doc, doc.indexOf('Works fully offline'));
    assert.ok(got.includes('HF_HUB_OFFLINE'));
    assert.ok(!got.includes('Something else'), 'the window ran into the next section');
  });

  it('a section at the end of the document is not cut', () => {
    const got = markdownSectionFrom(doc, doc.indexOf('Something else'));
    assert.ok(got.includes('Something else'));
  });

  it('grows with the prose', () => {
    const padded = doc.replace('Enforced', 'Padding. '.repeat(300) + 'Enforced');
    assert.ok(markdownSectionFrom(padded, padded.indexOf('Works fully offline')).includes('HF_HUB_OFFLINE'));
  });
});

describe('yamlItemAt — a workflow step is bounded by the next step', () => {
  const wf = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          fetch-depth: 0',
    '      - name: next step',
    '        run: echo hi',
  ].join('\n');

  it('covers the whole step, not a count of it', () => {
    const got = yamlItemAt(wf, wf.indexOf('actions/checkout@v4'));
    assert.ok(got.includes('fetch-depth: 0'));
    assert.ok(!got.includes('next step'), 'the window ran into the following step');
  });

  it('an anchor on a LATER line of the step still bounds the whole step', () => {
    const got = yamlItemAt(wf, wf.indexOf('fetch-depth'));
    assert.ok(got.includes('actions/checkout@v4'), 'it did not walk back to the start of the item');
  });

  it('grows when the step gains keys', () => {
    const grown = wf.replace('          fetch-depth: 0', '          fetch-depth: 0\n          persist-credentials: false');
    const got = yamlItemAt(grown, grown.indexOf('actions/checkout@v4'));
    assert.ok(got.includes('persist-credentials'));
    assert.ok(!got.includes('next step'));
  });

  it('a blank line inside a step does not end it', () => {
    const spaced = wf.replace('        with:', '\n        with:');
    assert.ok(yamlItemAt(spaced, spaced.indexOf('actions/checkout@v4')).includes('fetch-depth'));
  });
});

describe('enclosingBlockAround — the block you are in, plus the line that let you in', () => {
  it('includes the CONDITION, not just the braces', () => {
    // The question is "what guarded this?", and the guard is the condition. Bounding at the brace would answer a
    // different question and answer it correctly, which is the worst kind of wrong.
    const src = 'fn();\nif (failed.length === 0) {\n  log.info("readiness confirmed for all");\n}\nafter();';
    const got = enclosingBlockAround(src, src.indexOf('readiness confirmed'));
    assert.ok(got.includes('failed.length === 0'), 'the condition is outside the window');
    assert.ok(!got.includes('after()'), 'the window ran past the block');
    assert.ok(!got.includes('fn()'), 'the window ran back past the block');
  });

  it('finds a try/catch wrapping a call', () => {
    const src = 'a();\ntry {\n  chmodSync(target, mode);\n} catch { /* best effort */ }\nb();';
    const got = enclosingBlockAround(src, src.indexOf('chmodSync'));
    assert.ok(/try\s*\{/.test(got), 'the try is outside the window');
  });

  it('a nested block does not become the answer', () => {
    const src = 'if (outer) {\n  if (inner) { x(); }\n  target();\n}\n';
    const got = enclosingBlockAround(src, src.indexOf('target()'));
    assert.ok(got.includes('outer'), 'it picked a sibling block instead of the enclosing one');
  });

  it('grows with the block, which a count cannot', () => {
    const pad = '  filler();\n'.repeat(200);
    const src = `if (guardCondition) {\n${pad}  target();\n}\n`;
    assert.ok(enclosingBlockAround(src, src.indexOf('target()')).includes('guardCondition'));
  });
});

describe('enclosingBlocksMatching — containment, which is NOT proximity', () => {
  const OPENER = /@if\s*\(/;

  it('THE case a backwards window gets wrong: a guard that already CLOSED does not count', () => {
    /*
     * This is why the nine backwards windows were not swept blind. `src.slice(at - 600, at)` finds the text of a
     * guard that opened and closed above the control and calls the control guarded. It is not — the guard contains
     * nothing. A proximity measurement cannot answer a containment question, and here the false answer is "this
     * form control is locked when the instance is managed" about one that is not.
     */
    const src = [
      '@if (!(s.faceLocked("x") || s.managed)) {',
      '  <input id="guarded" [(ngModel)]="a" />',
      '}',
      '<input id="exposed" [(ngModel)]="b" />',
    ].join('\n');

    const guarded = enclosingBlocksMatching(src, src.indexOf('id="guarded"'), OPENER);
    assert.equal(guarded.length, 1, 'the control inside the guard was not seen as contained');
    assert.match(guarded[0], /managed/);

    const exposed = enclosingBlocksMatching(src, src.indexOf('id="exposed"'), OPENER);
    assert.deepEqual(exposed, [], 'a guard that closed above the control was counted as containing it');
  });

  it('reports nesting outermost first', () => {
    const src = '@if (a) {\n  @if (b) {\n    <input id="deep" />\n  }\n}';
    const got = enclosingBlocksMatching(src, src.indexOf('id="deep"'), OPENER);
    assert.equal(got.length, 2);
    assert.match(got[0], /\(a\)/);
    assert.match(got[1], /\(b\)/);
  });

  it('a condition containing its own parens is not truncated', () => {
    // `[^)]*` stopped at the first `)`, so `s.faceLocked('…')` closed before `managed` was reached and the guard
    // read as absent. The whole opening line is returned, so there is nothing to truncate.
    const src = '@if (!(s.faceLocked("personEntityTypes") || s.managed)) {\n  <input id="x" />\n}';
    const got = enclosingBlocksMatching(src, src.indexOf('id="x"'), OPENER);
    assert.equal(got.length, 1);
    assert.ok(got[0].includes('managed'), 'the condition was cut at an inner paren');
  });
});

describe('lineBefore — for a marker whose rule is literally "immediately above"', () => {
  it('returns the last non-empty line, skipping blanks', () => {
    const doc = '**Response**\n\n```json\n{"tokens": []}\n```\n';
    assert.equal(lineBefore(doc, doc.indexOf('```json')), '**Response**');
  });

  it('does not reach past it to an earlier marker', () => {
    const doc = '**Response**\n\nSome prose.\n\n```json\n{}\n```\n';
    assert.equal(lineBefore(doc, doc.indexOf('```json')), 'Some prose.');
  });

  it('mid-line, answers what precedes on that line without its trailing space; orEmpty answers the start', () => {
    const src = 'const f = (x) => {\n  return x;\n}';
    assert.equal(lineBefore(src, src.indexOf('{')), 'const f = (x) =>');
    assert.equal(lineBefore(src, 0, 'start', { orEmpty: true }), '');
    assert.throws(() => lineBefore(src, 0, 'start'), /nothing precedes/);
  });
});

describe('docCommentBefore — the comment block above a declaration', () => {
  const src = '/** Machine-managed: not meant to be hand-edited. */\n  sync?: SyncConfig;\n';

  it('returns the comment', () => {
    const got = docCommentBefore(src, src.indexOf('sync?:'));
    assert.ok(got.includes('hand-edited'));
    assert.ok(got.startsWith('/*') && got.endsWith('*/'));
  });

  it('returns EMPTY when code separates the comment from the anchor', () => {
    // An absent doc comment is an answer a gate asserts on. Throwing would make it look like a broken anchor.
    const other = '/** About something else. */\nconst x = 1;\n  sync?: SyncConfig;\n';
    assert.equal(docCommentBefore(other, other.indexOf('sync?:')), '');
  });

  it('returns EMPTY when there is no comment at all', () => {
    assert.equal(docCommentBefore('  sync?: SyncConfig;\n', 2), '');
  });

  it('grows with the comment', () => {
    const grown = src.replace('Machine-managed', 'Machine-managed. ' + 'More prose. '.repeat(200));
    assert.ok(docCommentBefore(grown, grown.indexOf('sync?:')).includes('hand-edited'));
  });
});

describe('markdownSectionAround — the section a MENTION belongs to', () => {
  const notice = '## A\n\nLicence: MIT\n\nwhisper-small is bundled.\n\n## B\n\nNo licence here.\n';

  it('reaches backwards to the section heading, which is where the licence is', () => {
    // The half `markdownSectionFrom` cannot see: the model is mentioned after the licence line, so bounding
    // forward from the mention finds nothing and reports an attributed model as unattributed.
    const got = markdownSectionAround(notice, notice.indexOf('whisper-small'));
    assert.ok(/Licen[cs]e:/.test(got), 'the licence above the mention is outside the window');
    assert.ok(!got.includes('No licence here'), 'the window ran into the next section');
  });

  it('does not leak the PREVIOUS section in', () => {
    const got = markdownSectionAround(notice, notice.indexOf('No licence here'));
    assert.ok(!/Licen[cs]e: MIT/.test(got), 'a licence from another section would be read as this one\'s');
  });
});

describe('markdownSectionWithSubsections — the section a heading names, its subsections included', () => {
  const doc = '# Guide\n\n## Rolling Back Someday\n\nWrong one.\n\n## Rolling Back\n\nIntro.\n\n### Detail\n\nUnder the detail.\n\n#### Deeper\n\nDeepest.\n\n## Next\n\nOther.\n';

  it('runs through its own subsections and stops at the next heading of its level', () => {
    const got = markdownSectionWithSubsections(doc, 'Rolling Back');
    assert.ok(got.startsWith('## Rolling Back\n'), 'it did not start at the heading line');
    assert.ok(got.includes('Under the detail') && got.includes('Deepest'), 'a subsection is outside the window');
    assert.ok(!got.includes('Other.') && !got.includes('Wrong one'), 'the window left its section');
  });

  it('matches the WHOLE heading line, so a longer title does not stand in for it', () => {
    // "## Rolling Back Someday" is still in the document; with the real heading renamed away, nothing is found.
    assert.equal(markdownSectionWithSubsections(doc.replace('## Rolling Back\n', '## Rolling Forward\n'), 'Rolling Back'), null);
  });

  it('is null when the heading is absent, never an empty section', () => {
    assert.equal(markdownSectionWithSubsections(doc, 'Nothing'), null);
    assert.equal(markdownSectionWithSubsections(doc, 'Detail'), null, 'a ### heading is not a level-2 one');
  });

  it('reads a level-3 section, which ends at the next ### or ##', () => {
    const got = markdownSectionWithSubsections(doc, 'Detail', 3);
    assert.ok(got.includes('Deepest') && !got.includes('Other.'));
  });

  it('tolerates CRLF and a section at the end of the document', () => {
    const crlf = doc.replace(/\n/g, '\r\n');
    assert.ok(markdownSectionWithSubsections(crlf, 'Rolling Back').includes('Deepest'));
    assert.ok(markdownSectionWithSubsections(crlf, 'Next').includes('Other.'));
  });

  it('reads the title as text, not as a pattern', () => {
    assert.equal(markdownSectionWithSubsections('## A (b)\n\nx\n', 'A (b)'), '## A (b)\n\nx\n');
    assert.equal(markdownSectionWithSubsections('## Ab\n\nx\n', 'A.'), null);
  });

  it('a `# comment` inside a fenced code block neither ends the section nor stands in for a heading', () => {
    const withFence = '## Rolling Back\n\n```bash\n# restore the copy\ncp a b\n```\n\nAfter the fence.\n\n## Next\n\nOther.\n';
    const got = markdownSectionWithSubsections(withFence, 'Rolling Back');
    assert.ok(got.includes('After the fence.') && !got.includes('Other.'), 'the section ended at a comment line in the fence');
    assert.equal(markdownSectionWithSubsections('```\n## Hidden\n```\n', 'Hidden'), null, 'a heading inside a fence was found');
  });
});

describe('bodyOf still behaves, since the new code shares its module', () => {
  it('bounds a declaration by the next one', () => {
    const src = 'export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n';
    const got = bodyOf(src, 'a');
    assert.ok(got.includes('return 1'));
    assert.ok(!got.includes('return 2'));
  });

  it('an OVERLOADED function is read at its implementation, the last of its consecutive declarations', () => {
    const src = [
      'export function a(x: string): string;',
      'export function a(x: number): number;',
      'export function a(x: unknown): unknown {',
      '  return x;',
      '}',
      'export function b() {',
      '  return 2;',
      '}',
    ].join('\n');
    const got = bodyOf(src, 'a');
    assert.ok(got.includes('return x'), 'the window stopped at an overload signature');
    assert.ok(!got.includes('return 2'));
    // A function followed by a declaration of another name is bounded by it, as before.
    assert.ok(bodyOf('function c() {\n  return 3;\n}\nfunction d() {}\n', 'c').includes('return 3'));
  });
});

/**
 * enclosingMarkupBlocksMatching — and the apostrophe in a comment that shifted every quote after it.
 *
 * The walk lexes attribute values with a code rule: `'` opens a string and runs to the next `'`. Markup comments
 * are PROSE, and prose is full of apostrophes. Each one opened a phantom string that swallowed everything to the
 * next apostrophe, braces included — so the walk depended on the PARITY of every apostrophe earlier in the
 * template.
 *
 * Fragile in the worst direction: editing a comment anywhere above a control could silently change what the walk
 * believed contained it. Measured 2026-08-28 — a change that removed two apostrophes from an attribute re-paired
 * every apostrophe after it, and `infra-managed-locks-every-field` lost both `@if` guards around a control it had
 * always seen guarded, then reported that control as a defect. Nothing about the control had changed.
 */
describe('enclosingMarkupBlocksMatching — prose in a comment is not a string', () => {
  const withComment = (comment) => [
    '@if (!(s.locked() || s.managed)) {',
    `  <!-- ${comment} -->`,
    '  <select [ngModel]="x" id="target"></select>',
    '}',
  ].join('\n');

  /** Shared, so the cases below cannot drift on the opener they are asking about. */
  const OPENER = /@if\s*\(/;
  const guardsAt = (tpl) => enclosingMarkupBlocksMatching(tpl, tpl.indexOf('id="target"'), OPENER);

  it('finds the guard when the comment has NO apostrophe', () => {
    // The baseline. If this ever fails the walk is broken for a reason that has nothing to do with quoting.
    assert.equal(guardsAt(withComment('a plain comment')).length, 1);
  });

  it('and still finds it with ONE apostrophe', () => {
    assert.equal(guardsAt(withComment('the card\'s own flag')).length, 1,
      'an unpaired apostrophe in prose must not consume the markup after it');
  });

  it('TWO apostrophes STRADDLING A BRACE — the shape that actually reproduces it', () => {
    /*
     * My first fixtures did NOT reproduce the failure, and mutation testing said so: removing the comment skip
     * left them green. An unpaired apostrophe swallows text to the end of the walk, and if that text holds no
     * braces the depth is unchanged — so the bug never showed.
     *
     * What breaks the walk is a phantom string that eats an ODD number of braces. Two apostrophes in two
     * comments with exactly one brace between them does it: the pair spans that brace, so the level is never
     * pushed and a control inside it reports one guard fewer than encloses it.
     */
    const tpl = [
      '@if (s.outer()) {',
      '  <!-- the card\'s flag -->',
      '  @if (s.inner()) {',
      '  <!-- the operator\'s note -->',
      '    <select [ngModel]="x" id="target"></select>',
      '  }',
      '}',
    ].join('\n');
    const guards = enclosingMarkupBlocksMatching(tpl, tpl.indexOf('id="target"'), OPENER);
    assert.equal(guards.length, 2, 'both blocks are open at the target');
    assert.match(guards[0], /s\.outer\(\)/, 'outermost first');
    assert.match(guards[1], /s\.inner\(\)/);
  });

  it('and the same shape must not LOSE the only guard there is', () => {
    // The consumer gate's failure, reduced: the swallowed brace is the OPENING of the block the control sits
    // in, so the walk reports zero guards for a control that is plainly guarded — and the gate then calls it
    // a defect.
    const tpl = [
      '  <!-- the card\'s flag -->',
      '@if (s.outer()) {',
      '  <!-- the operator\'s note -->',
      '  <select [ngModel]="x" id="target"></select>',
      '}',
    ].join('\n');
    const guards = enclosingMarkupBlocksMatching(tpl, tpl.indexOf('id="target"'), OPENER);
    assert.equal(guards.length, 1, 'the guard opens between the two apostrophes and must still be seen');
  });

  it('a brace inside the comment is not structure either', () => {
    // The stronger claim: a comment is skipped WHOLE, so even a stray brace in prose cannot push a level.
    assert.equal(guardsAt(withComment('see the {a: 1} shape and the operator\'s note')).length, 1);
  });

  it('an UNCLOSED comment does not hang or swallow the guard silently', () => {
    // Malformed input must degrade, not loop. The walk stops at `at` when it finds no terminator.
    const tpl = '@if (s.x()) {\n  <!-- never closed\n  <select [ngModel]="x" id="target"></select>\n}';
    assert.doesNotThrow(() => guardsAt(tpl));
  });

  it('a real attribute value is STILL treated as a string', () => {
    // The behaviour the comment skip must not have broken: a brace in an attribute is data, and counting it
    // would push a level that never closes and put every later control inside a phantom block.
    const tpl = [
      '@if (s.guard()) {',
      '  <input [ngModel]="{a: 1}" id="target" />',
      '}',
    ].join('\n');
    assert.equal(guardsAt(tpl).length, 1, 'a brace in an attribute value must not push a level');
  });
});
