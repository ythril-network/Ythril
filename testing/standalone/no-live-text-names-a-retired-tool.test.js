/**
 * Text a caller reads while USING the product must not name a tool that no longer exists.
 *
 * ## Why a rename needs its own gate
 *
 * 5.0 renames almost every public identifier, and **a rename is the one change that passes a compiler while
 * leaving a document wrong.** Nothing fails: the tool is exported under its new name, the build is green,
 * every test passes — and a schema description still tells a caller to call `find_entities_by_name` first.
 * `CLAUDE.md` puts it plainly: an MCP tool's description is what a caller reads *while constructing
 * arguments*, so a stale sentence there is invisible, because nobody reports a capability they were told to
 * get somewhere else.
 *
 * **On its first run this found twenty-four**, across five retired names, in text nobody had flagged:
 * `save_entity` told a caller to look an entity up with a tool removed at 5.0; `space_meta` told them to read
 * the shape with `er_model`, which it had absorbed; ten sentences in the chrono tools named `list_chrono`
 * after `filter` replaced it; and `16-mcp.md` — the integrator's MCP page — described what `merge_entities`
 * carries over the webhook.
 *
 * ## The set is DERIVED from the previous major's last release, never listed
 *
 * A hand-written list of retired names is the same defect one level up, and it would be missing whichever
 * name was retired most recently. So the sweep reads the tool registry out of the tagged tree — the last
 * release of the major below ours — and subtracts what is live now. The tag is what makes it a fact rather
 * than an opinion: it is what callers were actually offered.
 *
 * **`fetch-depth: 0` in CI is what makes this work**, and it is already there for the CHANGELOG diff. If the
 * tag cannot be read this fails loudly rather than concluding that nothing is retired — an empty retired set
 * passes every loop written over it, which is exactly the silent pass the gate exists to end.
 *
 * ## Two exclusions, both derived rather than listed
 *
 * **A name that is still live in ANOTHER vocabulary is ambiguous and is dropped.** `traverse` is recall's
 * body field and `reindex` is a route segment — both were deliberately not swept at 5.0, and a gate that
 * cannot tell the tool from the parameter reports the parameter. Measured: `traverse`, `query`, `reindex`
 * and `retry_embedding` fall out this way, and with them about a hundred false hits. The cost is real —
 * a sentence meaning the retired `query` TOOL is not caught — and it is the price of a gate that survives.
 *
 * **A sentence that says the thing is GONE is allowed to name it.** *"The `er-model` route and the `er_model`
 * tool are both gone"* is the most useful sentence an integrator can read, and refusing it would push the
 * migration notes towards describing a removal without naming what was removed.
 *
 * ## What it does NOT read, on purpose
 *
 * Source COMMENTS, the changelogs, and the tests. A comment saying *"this was its own tool, `er_model`"* is
 * the reason a decision was taken and belongs where it is; the changelog is history by definition. The
 * subject is what a caller is shown.
 *
 * ## Seen red
 *
 * By mutation: restoring `list_chrono` to one chrono description, and putting `merge_entities` back in
 * `16-mcp.md`.
 *
 * Run: node --test testing/standalone/no-live-text-names-a-retired-tool.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { mountedRoutes } from './_routes.mjs';

const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

/** The last release tag of the major below ours — what callers were offered before this one. */
function previousMajorTag() {
  const major = Number(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version.split('.')[0]);
  const tag = git('tag', '--sort=-v:refname').split('\n').map(t => t.trim())
    .filter(t => /^v\d+\.\d+\.\d+$/.test(t))
    .find(t => Number(t.slice(1).split('.')[0]) < major);
  assert.ok(tag,
    `no release tag below major ${major} is reachable. In CI that means the checkout lost its tags — the `
    + 'workflow sets `fetch-depth: 0` for the CHANGELOG diff and this needs the same. This fails rather '
    + 'than reporting that nothing has been retired, which is what an unreadable history would otherwise '
    + 'look like.');
  return tag;
}

/** Every MCP tool name declared in a tree, read out of the registry files rather than listed. */
function toolNamesAt(ref) {
  const files = git('ls-tree', '-r', '--name-only', ref, 'server/src/mcp/tools').split('\n').filter(Boolean);
  const names = new Set();
  for (const f of files) {
    for (const m of git('show', `${ref}:${f}`).matchAll(/^\s*name:\s*'([a-z][a-z0-9_]*)',/gm)) names.add(m[1]);
  }
  return names;
}

const live = new Set(ALL_TOOLS.map(t => t.name));

/** Names that are no longer tools but ARE still something else a caller writes. */
function ambiguous() {
  const out = new Set();
  for (const t of ALL_TOOLS) {
    const schema = t.inputSchema?.({ requiredSpace: {}, optionalSpace: {} }) ?? {};
    for (const key of Object.keys(schema.properties ?? {})) out.add(key);
  }
  for (const r of mountedRoutes()) for (const seg of r.path.split('/')) out.add(seg.replace(/-/g, '_'));
  return out;
}

const TAG = previousMajorTag();
const WAS = toolNamesAt(TAG);
const AMBIGUOUS = ambiguous();
const RETIRED = [...WAS].filter(n => !live.has(n) && !AMBIGUOUS.has(n)).sort();

/**
 * The names the docs cannot be held to, and a SCHEMA DESCRIPTION can.
 *
 * In prose `query` is a word and `reindex` is a route segment, so a gate holding a guide page to them
 * reports the sentence rather than the defect. Inside a tool's own description the question is answerable:
 * either it is that tool's parameter, or it says whose parameter it is, or it means the dead tool.
 */
const RETIRED_AMBIGUOUS = [...WAS].filter(n => !live.has(n) && AMBIGUOUS.has(n)).sort();

/** A sentence that says the thing is gone is allowed to name it. */
const OBITUARY = /\b(gone|removed|renamed|replaced|absorbed|folded|retired|no longer|used to|until 5\.0)\b/i;

/**
 * Which MCP source file declares which tool, and what parameters that tool takes.
 *
 * This is what lets the ambiguous names be checked in a SCHEMA DESCRIPTION rather than skipped there.
 * `query` and `traverse` are both retired tool names AND live parameters, and skipping them wholesale
 * cost seventeen sentences telling a caller to sort with `query` — a tool 5.0 renamed `filter`. In a
 * description the question has a precise answer: is this the parameter of the tool being described, or
 * is it the dead tool?
 */
function paramsByFile() {
  const byFile = new Map();
  for (const file of trackedSources('server/src/mcp/tools', { floor: 5 })) {
    const src = readFileSync(join(REPO_ROOT, file), 'utf8');
    const declared = new Set([...src.matchAll(/^\s*name:\s*'([a-z][a-z0-9_]*)',/gm)].map(m => m[1]));
    const params = new Set();
    for (const tool of ALL_TOOLS) {
      if (!declared.has(tool.name)) continue;
      const schema = tool.inputSchema?.({ requiredSpace: {}, optionalSpace: {} }) ?? {};
      for (const key of Object.keys(schema.properties ?? {})) params.add(key);
    }
    byFile.set(file, params);
  }
  return byFile;
}

const PARAMS_BY_FILE = paramsByFile();

/**
 * Is this mention of an ambiguous name legitimate?
 *
 * Two allowances, both derived. **The parameter of the tool being described** — `help`'s own `query`,
 * `recall`'s own `traverse`. And **a possessive naming the tool that owns it** — `` `recall`'s `traverse`
 * expansion `` is said from four other files and is right every time, because it names whose parameter it
 * is. A mention with neither is a sentence pointing at a tool that does not exist.
 */
function excusedInDescription(file, name, line) {
  if (PARAMS_BY_FILE.get(file)?.has(name)) return true;
  for (const owner of live) {
    if (new RegExp('`?' + owner + '`?(?:\\\\)?\'s\\s+(?:own\\s+)?`' + name + '`').test(line)) return true;
  }
  return false;
}

/** The text a caller is shown: the MCP surface's own strings, and every published page. */
function liveText() {
  const out = [];
  for (const f of trackedSources('server/src/mcp', { floor: 10 })) {
    // BLANKED rather than stripped, so a reported line number is the line in the file. Deleting the
    // comments shifts everything below them up — measured at ten lines in `mcp/tools/chrono.ts`, which
    // is far enough that the reader lands on an unrelated sentence and doubts the gate.
    out.push({ file: f, text: blankComments(readFileSync(join(REPO_ROOT, f), 'utf8')) });
  }
  for (const f of trackedSources('docs', { ext: ['.md'], floor: 30 })) {
    out.push({ file: f, text: readFileSync(join(REPO_ROOT, f), 'utf8') });
  }
  return out;
}

describe('the sweep works before anything is concluded from it', () => {
  it('reads a real registry out of the previous major', () => {
    assert.ok(WAS.size >= 30, `only ${WAS.size} tool(s) found at ${TAG}; the registry parse is broken, and a `
      + 'thin set makes every assertion below pass about names it never looked for');
    assert.ok(live.size >= 30, `only ${live.size} live tool(s); the built registry is not being read`);
  });

  it('and something really was retired, so the comparison is doing work', () => {
    assert.ok(RETIRED.length > 0,
      `nothing is retired between ${TAG} and now, which would make this gate vacuous. If that is genuinely `
      + 'true it can be deleted — but check the registry parse first.');
  });

  it('the ambiguity exclusion is derived from the live surface, not from a list', () => {
    // If this stops resolving, every retired name becomes unambiguous and the gate starts reporting
    // parameters as dead tools — the failure mode that got two earlier sweeps of this kind abandoned.
    assert.ok(AMBIGUOUS.has('traverse'),
      'recall\'s `traverse` body field is not being seen, so the exclusion is not working');
    assert.ok(AMBIGUOUS.size > 50, `only ${AMBIGUOUS.size} live names found for the exclusion`);
  });

  it('the subject is text, and there is some of it', () => {
    const files = liveText();
    assert.ok(files.length > 50, `only ${files.length} file(s) of caller-facing text found`);
  });
});

describe('a schema description names a live tool, even when the name is also a parameter', () => {
  it('the ambiguous set is real and the parameter map resolved', () => {
    assert.ok(RETIRED_AMBIGUOUS.length > 0,
      'nothing is both retired and still live as a parameter, which would make the cases below vacuous');
    assert.ok([...PARAMS_BY_FILE.values()].some(s => s.size > 0),
      'no file resolved to any tool parameter — the declaration scan broke, and every mention would be '
      + 'reported as a dead tool');
  });

  it('no description sends a caller to one', () => {
    /*
     * Seventeen did. `sortable by `query``, `filterable by `query` on the `files` collection`, `as
     * `recall` and `query` report it` — all naming the tool 5.0 renamed `filter`, in the text a caller
     * reads while constructing the call. The audit that found them could not gate them, because the
     * exclusion that keeps recall's `traverse` FIELD from being reported also hid these.
     */
    const offenders = [];
    for (const file of trackedSources('server/src/mcp', { floor: 10 })) {
      const lines = blankComments(readFileSync(join(REPO_ROOT, file), 'utf8')).split(/\r?\n/);
      for (const name of RETIRED_AMBIGUOUS) {
        const hit = new RegExp('`' + name + '`');
        lines.forEach((line, i) => {
          if (!hit.test(line) || OBITUARY.test(line) || excusedInDescription(file, name, line)) return;
          offenders.push(`${file}:${i + 1} names \`${name}\`, retired since ${TAG}`);
        });
      }
    }
    assert.deepEqual(offenders, [],
      'a tool description names something that is not a live tool:\n  ' + offenders.join('\n  ')
      + '\n\nIf it is the parameter of the tool being described, it is fine as it is. If it is another '
      + "tool's parameter, say whose — `recall`'s `traverse` — and this accepts it. Otherwise it is a "
      + 'dead tool name, and a caller sent to one concludes the capability is missing.');
  });
});

describe('no live text names a retired tool', () => {
  it('not a schema description, not a guide page, not a use-case example', () => {
    const offenders = [];
    for (const { file, text } of liveText()) {
      const lines = text.split(/\r?\n/);
      for (const name of RETIRED) {
        const hit = new RegExp('`' + name + '`');
        lines.forEach((line, i) => {
          if (!hit.test(line) || OBITUARY.test(line)) return;
          offenders.push(`${file}:${i + 1} names \`${name}\`, retired since ${TAG}`);
        });
      }
    }
    assert.deepEqual(offenders, [],
      'text a caller reads while using the product names a tool that no longer exists:\n  '
      + offenders.join('\n  ')
      + '\n\nA rename passes the compiler and leaves the sentence wrong, and a caller sent to a tool that is '
      + 'not there does not report it — they conclude the capability is missing. Name the live tool, or say '
      + 'in the same sentence that the old one is gone.');
  });
});
