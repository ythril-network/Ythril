/**
 * Launching a bundled entry point, in a build and in a checkout: `util/entry-path.ts`.
 *
 * ## Why it is a module (Q-99 part 1, CLAUDE.md "reuse, or build one worth reusing")
 *
 * `api/local-agent.ts` already knew how to start one of the server's own entry points: use the compiled `.js` when
 * it exists, otherwise in a development checkout run the `.ts` through the hoisted `tsx` command line, and say
 * clearly when neither is there. The inference host is the SECOND place that needs exactly that, and a second copy
 * is one place to get the tsx path wrong in a way only developers notice. So it is one function whose answer is a
 * command and its arguments, and both callers use it (`local-inference-structure.test.js` holds that, derived).
 *
 * ## What it refuses, and why that is part of the contract
 *
 * It takes a NAME and resolves it under the server's own tree. A name is a compile-time constant at every call site,
 * but a helper that turns a string into "a program this server will execute" must not take the string's word for
 * it: names with `..`, an absolute path, a drive letter, an extension or unexpected characters are refused, so the
 * day somebody passes it something derived from input the function fails instead of launching it.
 *
 * `resolveEntry(name, { root?, tsxCli? })` returns `{ cmd, args }` and THROWS when it cannot; `root` and `tsxCli`
 * exist for this test and default to the tree the module sits in and the hoisted tsx.
 *
 * Run: node --test testing/standalone/entry-path.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let resolveEntry;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-entry-path-'));
const tsxCli = path.join(tmp, 'tsx', 'cli.mjs');

const touch = (rel) => {
  const p = path.join(tmp, 'tree', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '// entry');
  return p;
};

before(async () => {
  ({ resolveEntry } = await import('../../server/dist/util/entry-path.js'));
  fs.mkdirSync(path.dirname(tsxCli), { recursive: true });
  fs.writeFileSync(tsxCli, '// tsx');
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const root = () => path.join(tmp, 'tree');

describe('resolveEntry in a build', () => {
  it('runs the compiled entry with the current node, and prefers it when a source entry is beside it', () => {
    const js = touch('brain/a-entry.js');
    touch('brain/a-entry.ts');
    assert.deepEqual(resolveEntry('brain/a-entry', { root: root(), tsxCli }), { cmd: process.execPath, args: [js] });
  });
});

describe('resolveEntry in a development checkout', () => {
  it('runs the source entry through the tsx command line when there is no compiled one', () => {
    const ts = touch('brain/dev-only.ts');
    assert.deepEqual(resolveEntry('brain/dev-only', { root: root(), tsxCli }), { cmd: process.execPath, args: [tsxCli, ts] });
  });

  it('refuses, naming the missing tsx, when only a source entry exists and tsx is not installed', () => {
    touch('brain/needs-tsx.ts');
    const missing = path.join(tmp, 'no', 'such', 'tsx', 'cli.mjs');
    assert.throws(() => resolveEntry('brain/needs-tsx', { root: root(), tsxCli: missing }),
      e => e instanceof Error && e.message.includes(missing) && /tsx/i.test(e.message));
  });
});

describe('resolveEntry when there is nothing to run', () => {
  it('refuses with a message naming both places it looked', () => {
    assert.throws(() => resolveEntry('brain/not-there', { root: root(), tsxCli }), (e) => {
      assert.ok(e instanceof Error);
      assert.ok(e.message.includes(path.join(root(), 'brain', 'not-there.js')), e.message);
      assert.ok(e.message.includes(path.join(root(), 'brain', 'not-there.ts')), e.message);
      return true;
    });
  });
});

describe('resolveEntry refuses a name that is not a plain relative entry name', () => {
  for (const bad of [
    '../outside', 'brain/../../outside', '/etc/passwd', 'C:\\Windows\\x', 'C:/x', '\\\\host\\share\\x',
    'brain/entry.js', 'brain/entry.ts', 'brain/entry with space', 'brain/entry;rm', '', 'brain//entry', './brain/entry',
    'brain/entry\u0000', 'brain\\entry',
  ]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      touch('brain/entry.js');
      assert.throws(() => resolveEntry(bad, { root: root(), tsxCli }), /entry name|not a valid|refus/i);
    });
  }

  it('accepts the names the server actually uses', () => {
    touch('brain/embed-process.js');
    touch('local-agent-connector/index.js');
    for (const ok of ['brain/embed-process', 'local-agent-connector/index']) {
      assert.doesNotThrow(() => resolveEntry(ok, { root: root(), tsxCli }), ok);
    }
  });
});

describe('resolveEntry against the real tree', () => {
  it('finds the inference child and the local-agent connector in this build', () => {
    for (const name of ['brain/embed-process', 'local-agent-connector/index']) {
      const r = resolveEntry(name);
      assert.equal(r.cmd, process.execPath);
      const target = r.args.at(-1);
      assert.ok(fs.existsSync(target), `${name} resolved to ${target}, which does not exist`);
      assert.match(target.replace(/\\/g, '/'), new RegExp(`${name}\\.(js|ts)$`));
    }
  });
});
