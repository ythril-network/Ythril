/**
 * `scripts/enable-networks-workstation.sh` writes its secrets for its owner only, and never puts one in a process
 * argument (Q-612).
 *
 * ## What happened
 *
 * The script writes two secrets: the local-agent token (`~/.ythril-local-connector/token`, and `YTHRIL_LOCAL_AGENT_TOKEN`
 * in the repo's `.env`). It created both with whatever the caller's umask allowed — 022 on most machines, so
 * world-readable — and the one `chmod 600` it did carry ended in `|| true`: a failure was swallowed and the file stayed
 * as it was. Its token also travelled as a command-line argument (`curl -H "Authorization: Bearer ${token}"`, and
 * `awk -v v="$value"` when the `.env` was rewritten), which any local user reads from `ps` or `/proc/<pid>/cmdline` for
 * as long as the command runs.
 *
 * ## The rule
 *
 * - **One writer.** Every secret file is written through `write_private <path>` (content on stdin): a temp file made in
 *   the target's own directory, `chmod 600` BEFORE content, then `mv` over the target. It does not matter what umask the
 *   caller had, or what mode an earlier run left: the file that results is 0600, owned by the user, and a symlink
 *   standing at the target is refused rather than followed or replaced. A failed `mv` removes its temp file (`trap`).
 * - **No other door.** Nothing redirects into the `.env` or the token file by itself, and no `chmod` is allowed to fail
 *   quietly (`|| true`). The state directory is `chmod 700` and `connector.log` is `chmod 600` on every run, because an
 *   earlier run's modes survive a `>`.
 * - **No secret in an argument.** A secret reaches an external command through its environment, its stdin or a 0600
 *   file, never as one of its arguments. `printf`, `echo` and `read` are builtins and do not count.
 *
 * ## How it is tested
 *
 * The behaviour: `write_private` is extracted from wherever the repo defines it (the script itself, or a sourceable
 * lib beside it) and run in bash under `umask 022`, then `stat`ed. That needs a filesystem that keeps Unix modes, which
 * Linux CI has and an NTFS checkout does not: where a probe shows modes are not kept, the test skips locally and
 * REFUSES to skip under CI (a skipped case in CI is a rule nobody checks). The sources: the three rules above are read
 * from the script with comments removed, and each is shown to fire on a planted copy of its defect.
 *
 * Run: node --test testing/standalone/the-workstation-script-writes-secrets-private.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { runningUnderCi } from '../_shared/running-under-ci.mjs';
import { shellCommands } from '../_shared/ci-workflow.mjs';

const MAIN = 'scripts/enable-networks-workstation.sh';
const SHELL_FILES = trackedSources('scripts', { ext: ['.sh'], floor: 1 });
const readRepo = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

// ── shell text helpers (pure: the self-tests below feed them planted scripts) ─────────────────────────────────────
/** Shell source without comment lines, trailing comments and heredoc-free blank lines. */
export function shCode(src) {
  return src.split(/\r?\n/)
    .map(l => l.replace(/\s+#[^'"]*$/, ''))
    .filter(l => l.trim() !== '' && !l.trim().startsWith('#'))
    .join('\n');
}

/** The text of function `name` (`name() {` … matching `}`), or null. */
export function functionText(code, name) {
  const m = new RegExp(`(?:^|\\n)\\s*(?:function\\s+)?${name}\\s*\\(\\)\\s*\\{`).exec(code);
  if (!m) return null;
  let i = m.index + m[0].length; let depth = 1;
  for (; i < code.length && depth > 0; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
  }
  return depth === 0 ? code.slice(m.index, i).trim() : null;
}

/** The code with the body of function `name` removed (the rest of the script). */
function withoutFunction(code, name) {
  const f = functionText(code, name);
  return f ? code.replace(f, '') : code;
}

/** Logical commands: continuation lines joined, then split by the repository's one script splitter (`shellCommands`). */
export function commandSegments(code) {
  return shellCommands(code.replace(/\\\r?\n\s*/g, ' '));
}

const SECRET_VARS = ['token', 'value', 'secret', 'TOKEN'];
const EXTERNAL = ['curl', 'wget', 'awk', 'gawk', 'sed', 'grep', 'openssl', 'node', 'npm', 'npx', 'docker', 'jq', 'python', 'python3', 'ssh', 'tr', 'cut', 'xargs', 'nohup', 'env', 'sudo', 'cloudflared', 'mktemp', 'tee'];

/** Segments in which a secret variable reaches an external command as an argument. */
export function secretInArguments(code) {
  const hits = [];
  const refs = new RegExp(`\\$\\{?(?:${SECRET_VARS.join('|')})\\b`);
  for (const seg of commandSegments(code)) {
    const stripped = seg
      .replace(/<<<\s*("[^"]*"|'[^']*'|\S+)/g, '')           // a here-string is stdin
      .replace(/<<-?\s*'?\w+'?/g, '')                          // a heredoc is stdin
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, ''); // VAR="$token" cmd: the environment
    const word = stripped.split(/\s+/)[0]?.replace(/^.*\//, '') ?? '';
    if (EXTERNAL.includes(word) && refs.test(stripped)) hits.push(seg);
  }
  return hits;
}

/** Every way `code` (the whole script, comments removed) writes a secret file other than through write_private. */
export function secretFileViolations(code) {
  const rest = withoutFunction(code, 'write_private');
  const v = [];
  for (const l of rest.split('\n')) {
    if (/>>?\s*"?\$\{?(?:env_path|token_file)\b/.test(l) || />>?\s*"?\$\{?state_dir\}?\/token\b/.test(l)) {
      v.push(`writes a secret file by redirection: ${l.trim()}`);
    }
    if (/\bchmod\b[^\n]*\|\|\s*true/.test(l)) v.push(`a chmod that is allowed to fail: ${l.trim()}`);
  }
  if (!/\bchmod\s+700\s+"?\$\{?state_dir\b/.test(rest)) v.push('the state directory is not chmod 700 on every run');
  if (!/\bchmod\s+600\b[^\n]*connector\.log/.test(rest)) v.push('connector.log is not chmod 600 on every run');
  if (!/\bwrite_private\b[^\n]*(?:token_file|\$\{?state_dir\}?\/token)/.test(rest)) v.push('the token file is not written through write_private');
  if (!/\bwrite_private\b[^\n]*env_path|write_private\s+"\$env_path"/.test(rest) && !/write_private[^\n]*\$\{?env_path/.test(rest)) {
    v.push('the .env is not written through write_private');
  }
  return v;
}

/** What is wrong with the writer itself. */
export function writerViolations(code) {
  const f = functionText(code, 'write_private');
  if (!f) return ['write_private is not defined'];
  const v = [];
  if (!/\bmktemp\b/.test(f)) v.push('write_private does not make its temp file with mktemp in the target directory');
  if (!/\bchmod\s+600\b/.test(f)) v.push('write_private does not chmod 600');
  if (!/\bmv\b/.test(f)) v.push('write_private does not replace the target with mv');
  if (!/\btrap\b/.test(f)) v.push('write_private leaves its temp file behind when mv fails (no trap)');
  if (!/\[\[?\s+-L\b|\btest\s+-L\b/.test(f)) v.push('write_private does not refuse a symlink at the target');
  const idx = (re) => f.search(re);
  if (idx(/\bchmod\s+600\b/) >= 0 && idx(/\bmv\b/) >= 0 && idx(/\bchmod\s+600\b/) > idx(/\bmv\b/)) v.push('write_private chmods after the mv: the file is briefly readable');
  return v;
}

// ── where the writer is defined ───────────────────────────────────────────────────────────────────────────────────
function definer() {
  for (const f of SHELL_FILES) {
    if (functionText(shCode(readRepo(f)), 'write_private')) return f;
  }
  return null;
}

// ── behaviour, on a filesystem that keeps modes ───────────────────────────────────────────────────────────────────
const bash = (script, cwd) => spawnSync(process.env['BASH'] || 'bash', ['-c', script], { cwd, encoding: 'utf8', timeout: 30_000 });
let scratch; let modesAreKept = false; let preamble = '';

describe('write_private makes the file private whatever the umask was', () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'ythril-write-private-'));
    const posix = (p) => p.replace(/\\/g, '/');
    const probe = bash(`umask 022; cd "${posix(scratch)}" && : > p && chmod 600 p && : > q && stat -c '%a' p q`, scratch);
    modesAreKept = probe.status === 0 && probe.stdout.split(/\s+/).filter(Boolean).join(',') === '600,644';
    const file = definer();
    if (file) {
      const code = shCode(readRepo(file));
      // A sourceable lib is sourced whole; the main script has top-level work, so only the function is taken out of it.
      preamble = file === MAIN ? functionText(code, 'write_private') : code;
    }
  });
  after(() => { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ } });

  /** Run `body` in bash under umask 022 with the writer loaded; skip where modes are not kept, except in CI. */
  function run(t, body) {
    if (!definer()) assert.fail('no tracked scripts/*.sh defines write_private: the secrets are written by redirection');
    if (!modesAreKept) {
      if (runningUnderCi()) assert.fail(`this runner (${process.platform}) does not keep Unix modes, and in CI a skipped case is a rule nobody checks — run it on Linux`);
      t.skip('this filesystem does not keep Unix modes (run on Linux CI)');
      return null;
    }
    const dir = mkdtempSync(join(scratch, 'case-'));
    const d = dir.replace(/\\/g, '/');
    const stubs = 'die() { echo "$*" >&2; exit 1; }; write_step() { :; };';
    const r = bash(`umask 022; ${stubs}\n${preamble}\n d="${d}"\n${body}`, dir);
    return { r, dir };
  }

  it('a new file is 0600 and holds what was written to stdin, under umask 022', (t) => {
    const out = run(t, 'printf "%s\\n" "TOKEN=abc" | write_private "$d/.env" && stat -c "%a" "$d/.env"');
    if (!out) return t.skip('this filesystem does not keep Unix modes (run on Linux CI)');
    assert.equal(out.r.status, 0, out.r.stderr);
    assert.equal(out.r.stdout.trim(), '600');
    assert.equal(readFileSync(join(out.dir, '.env'), 'utf8'), 'TOKEN=abc\n');
  });

  it('a file an earlier run left at 0644 is replaced by a 0600 one', (t) => {
    const out = run(t, 'printf old > "$d/token"; chmod 644 "$d/token"; printf "%s" new | write_private "$d/token" && stat -c "%a" "$d/token"');
    if (!out) return t.skip('this filesystem does not keep Unix modes (run on Linux CI)');
    assert.equal(out.r.status, 0, out.r.stderr);
    assert.equal(out.r.stdout.trim(), '600', 'the earlier mode must not survive');
    assert.equal(readFileSync(join(out.dir, 'token'), 'utf8'), 'new');
  });

  it('leaves nothing but the target behind', (t) => {
    const out = run(t, 'printf x | write_private "$d/.env"');
    if (!out) return t.skip('this filesystem does not keep Unix modes (run on Linux CI)');
    assert.equal(out.r.status, 0, out.r.stderr);
    assert.deepEqual(readdirSync(out.dir).sort(), ['.env']);
  });

  it('refuses a symlink at the target, and the file it points at is not touched', (t) => {
    const out = run(t, 'printf secret > "$d/real"; ln -s "$d/real" "$d/.env" 2>/dev/null; [ -L "$d/.env" ] || { echo NOLINK; exit 0; }; printf new | write_private "$d/.env"; echo "rc=$?"; cat "$d/real"');
    if (!out) return t.skip('this filesystem does not keep Unix modes (run on Linux CI)');
    if (/NOLINK/.test(out.r.stdout)) { t.skip('this shell cannot make a symlink'); return; }
    assert.doesNotMatch(out.r.stdout, /rc=0/, `a symlinked .env must be refused, got ${JSON.stringify(out.r.stdout)}`);
    assert.match(out.r.stdout, /secret$/, 'the file behind the link is untouched');
    assert.equal(lstatSync(join(out.dir, '.env')).isSymbolicLink(), true, 'the link is still a link');
  });
});

describe('the script, read as source', () => {
  const code = shCode(readRepo(MAIN));

  it('the scan found the script and the writer is defined somewhere in scripts/', () => {
    assert.ok(SHELL_FILES.includes(MAIN), `${MAIN} is not tracked`);
    assert.deepEqual(writerViolations(shCode(readRepo(definer() ?? MAIN))), []);
  });

  it('every secret file goes through write_private, no chmod may fail quietly, the state directory and the log are locked down', () => {
    const found = secretFileViolations(code);
    assert.deepEqual(found, [], found.join('\n'));
  });

  it('no secret reaches an external command as a process argument', () => {
    const found = secretInArguments(code);
    assert.deepEqual(found, [],
      `a process argument is readable by every local user for as long as the command runs:\n  ${found.join('\n  ')}\n`
      + 'Hand the secret over in the environment (VAR="$token" cmd, read with ENVIRON), on stdin (curl -H @-), or from a 0600 file.');
  });
});

// ── the gates, held to a conforming script and to each way of losing the rule ─────────────────────────────────────
const GOOD = shCode(`
write_private() {
  local target="$1" tmp
  if [[ -L "$target" ]]; then echo "refusing to replace a symlink" >&2; return 1; fi
  tmp="$(mktemp "$(dirname "$target")/.tmp.XXXXXX")"
  trap 'rm -f "$tmp"' RETURN
  chmod 600 "$tmp"
  cat > "$tmp"
  mv "$tmp" "$target"
}
upsert_env_value() {
  V="$2" awk -v k="$1" 'BEGIN{v=ENVIRON["V"]} {print}' "$env_path" | write_private "$env_path"
}
test_helper_auth() {
  printf 'Authorization: Bearer %s\\n' "$token" | curl -fsS -H @- "http://127.0.0.1:38123/v1/status"
}
chmod 700 "$state_dir"
printf '%s\\n' "$token" | write_private "$token_file"
touch "$state_dir/connector.log"; chmod 600 "$state_dir/connector.log"
YTHRIL_CONNECTOR_TOKEN="$token" nohup npm run local-connector:dev --workspace=server >"\${state_dir}/connector.log" 2>&1 &
`);

describe('the gates themselves', () => {
  const plant = (from, to) => { assert.ok(GOOD.includes(from), `fixture lost ${from}`); return GOOD.replace(from, to); };

  it('a conforming script is clean', () => {
    assert.deepEqual(writerViolations(GOOD), []);
    assert.deepEqual(secretFileViolations(GOOD), []);
    assert.deepEqual(secretInArguments(GOOD), []);
  });

  const FILE_CASES = [
    ['the token is written by redirection', plant('printf \'%s\\n\' "$token" | write_private "$token_file"', 'printf \'%s\\n\' "$token" > "$token_file"; write_private "$token_file" </dev/null'), /by redirection/],
    ['the .env is appended to by redirection', plant('chmod 700 "$state_dir"', 'chmod 700 "$state_dir"\nprintf "K=v\\n" >> "$env_path"'), /by redirection/],
    ['a chmod may fail quietly', plant('chmod 700 "$state_dir"', 'chmod 700 "$state_dir" || true'), /allowed to fail/],
    ['the state directory is not locked down', plant('chmod 700 "$state_dir"', ':'), /chmod 700/],
    ['the log is not locked down', plant('chmod 600 "$state_dir/connector.log"', ':'), /connector\.log/],
  ];
  for (const [what, script, expected] of FILE_CASES) {
    it(`flags: ${what}`, () => {
      const found = secretFileViolations(script);
      assert.ok(found.some(m => expected.test(m)), `wanted ${expected}, got ${JSON.stringify(found)}`);
    });
  }

  const ARG_CASES = [
    ['the token is in curl\'s header argument', 'curl -fsS -H "Authorization: Bearer ${token}" "http://x"'],
    ['the value is an awk -v argument', 'awk -v k="$key" -v v="$value" \'{print}\' "$env_path"'],
    ['the token is a curl argument after a pipe', 'echo hi | curl --data "$token" http://x'],
    ['the token is an argument of a continued line', 'docker run \\\n  -e "T=$token" img'],
  ];
  for (const [what, script] of ARG_CASES) {
    it(`flags: ${what}`, () => assert.ok(secretInArguments(script).length > 0, `not flagged: ${script}`));
  }

  const OK_ARG_CASES = [
    ['the environment carries it', 'YTHRIL_CONNECTOR_TOKEN="$token" nohup npm run dev'],
    ['printf is a builtin', 'printf \'%s\\n\' "$token" | write_private "$f"'],
    ['a here-string is stdin', 'openssl dgst -sha256 <<< "$token"'],
    ['an assignment is not a command', 'token="$(get_stable_token)"'],
  ];
  for (const [what, script] of OK_ARG_CASES) {
    it(`does not flag: ${what}`, () => assert.deepEqual(secretInArguments(script), []));
  }

  const WRITER_CASES = [
    ['no temp file in the target directory', plant('tmp="$(mktemp "$(dirname "$target")/.tmp.XXXXXX")"', 'tmp="$target.new"'), /mktemp/],
    ['no chmod', plant('chmod 600 "$tmp"', ':'), /does not chmod 600/],
    ['chmod after the mv', plant('chmod 600 "$tmp"\n  cat > "$tmp"\n  mv "$tmp" "$target"', 'cat > "$tmp"\n  mv "$tmp" "$target"\n  chmod 600 "$target"'), /after the mv/],
    ['no trap', plant('trap \'rm -f "$tmp"\' RETURN', ':'), /no trap/],
    ['no symlink refusal', plant('[[ -L "$target" ]]', '[[ -z "$target" ]]'), /symlink/],
    ['the writer is gone', 'echo nothing', /not defined/],
  ];
  for (const [what, script, expected] of WRITER_CASES) {
    it(`flags the writer: ${what}`, () => {
      const found = writerViolations(script);
      assert.ok(found.some(m => expected.test(m)), `wanted ${expected}, got ${JSON.stringify(found)}`);
    });
  }
});
