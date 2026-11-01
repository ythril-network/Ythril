/**
 * No UI field may silently truncate below what the API accepts.
 *
 * ## What happened
 *
 * An operator authored **2,377 characters** of `usageNotes` for a new space, imported it, and read it back:
 * the text ended mid-word at `...Both were unbound`. Two rules after that sentence were gone. No error, no
 * warning, nothing on either side saying anything had been dropped.
 *
 * The cause is one attribute: the textarea carried `maxlength="2000"` while the API accepts **50,000** and
 * the docs say 50,000. A browser does not warn at `maxlength` — it silently refuses the rest of a paste.
 *
 * **Why this field in particular stings.** `usageNotes` is the instruction sheet an MCP client receives at
 * handshake. A truncated instruction sheet does not fail; it stops instructing — and what gets cut is the
 * END, which is where the specific rules live. The reporter lost their write-order and repair-on-defect
 * rules and only noticed because they happened to read the field back in the same session.
 *
 * ## What this gate checks
 *
 * Every `maxlength` in the client, against the server's `z.string().max()` for the same field name. A UI cap
 * **stricter** than the API is the defect: it discards input the API would have stored, with no error path.
 * A UI cap equal to the API is right, and one looser is harmless (the server rejects it loudly).
 *
 * It is written as a comparison, not a list of known-good numbers — a list would have been written to match
 * the values on the day and agreed with itself forever, which is how the 2,000 survived.
 *
 * Run: node --test testing/standalone/ui-maxlength-matches-api.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const ls = (dir) => execFileSync('git', ['ls-files', dir], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

/** Widest `z.string().max(N)` per field name across the server — what the API as a whole accepts. */
function serverCaps() {
  const caps = new Map();
  for (const f of ls('server/src').filter(x => x.endsWith('.ts'))) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    const re = /(\w+)\s*:\s*z\s*\.\s*string\(\)[^,\n]*?\.max\(\s*([\d_]+)\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const n = Number(m[2].replaceAll('_', ''));
      if (!caps.has(m[1]) || n > caps.get(m[1]).n) caps.set(m[1], { n, file: f });
    }
  }
  return caps;
}

/** Every `maxlength` in a client template, with the field it is bound to. */
function clientLimits() {
  const out = [];
  for (const f of ls('client/src').filter(x => x.endsWith('.ts') || x.endsWith('.html'))) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    const re = /<(?:input|textarea)\b[^>]*>/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const ml = /\bmaxlength\s*=\s*"(\d+)"/.exec(m[0]);
      if (!ml) continue;                       // `[attr.maxlength]="CONST"` is a binding, checked by review
      const field = (/\[\(ngModel\)\]\s*=\s*"[^"]*?\.(\w+)"/.exec(m[0])
        ?? /formControlName\s*=\s*"(\w+)"/.exec(m[0])
        ?? /\bname\s*=\s*"(\w+)"/.exec(m[0]))?.[1];
      if (!field) continue;                    // unbound input (an OTP box, a confirmation phrase)
      out.push({ file: f, field, max: Number(ml[1]), line: src.slice(0, m.index).split('\n').length });
    }
  }
  return out;
}

/**
 * Pairings the field NAME gets wrong, each with a reason that can be checked.
 *
 * The comparison matches on bare field name across the whole server, so two unrelated fields sharing a name
 * look like one. That is a real limit of the method and is exempted here rather than silently widened —
 * an exemption with no reason is how a gate becomes decorative.
 */
const AMBIGUOUS = new Set([
  // The first-run instance label. It is not the `label` of a space or a network (both capped at 200); its own
  // route caps it at 100, matching this form. Verified by the last test in this file, so the exemption cannot
  // outlive the fact that justifies it.
  'label@client/src/app/pages/setup/setup.component.ts',
  // A personal view's name (Q-531). It is not the `name` of a schema-library entry (capped at 200); the views store caps it at
  // `VIEW_NAME_MAX = 40`, matching this form. Verified by the test below, so the exemption cannot outlive its fact.
  'name@client/src/app/pages/brain/view-create-dialog.component.ts',
]);

describe('no UI field truncates below the API limit', () => {
  const caps = serverCaps();
  const limits = clientLimits();

  it('found both sides to compare', () => {
    // Floors both enumerations: either one coming back empty would make the check below pass over nothing,
    // which is precisely how a silent truncation survives.
    assert.ok(caps.size >= 10, `only found ${caps.size} server string caps`);
    assert.ok(limits.length >= 5, `only found ${limits.length} client maxlength attributes`);
  });

  it('no client cap is stricter than the API cap for the same field', () => {
    const offenders = [];
    for (const l of limits) {
      const s = caps.get(l.field);
      if (!s) continue;                         // no same-named server field; nothing to compare against
      if (AMBIGUOUS.has(`${l.field}@${l.file}`)) continue;
      if (s.n > l.max) {
        offenders.push(`${l.field}: UI ${l.max} < API ${s.n}  (${l.file}:${l.line} vs ${s.file})`);
      }
    }
    assert.deepEqual(offenders, [],
      'these fields discard input the API would have stored. A browser does not warn at `maxlength`; it '
      + 'silently refuses the rest of a paste, so the operator\'s copy and the stored copy differ and nothing '
      + 'says so. Raise the UI cap to the API\'s, and show a counter.');
  });

  it('the field the incident was reported on is bound to the API limit, with a counter', () => {
    // Named explicitly: the comparison above cannot see `[attr.maxlength]="CONST"`, which is what the fix
    // uses, so without this the fixed field would drop out of the check entirely.
    const src = readFileSync(join(ROOT, 'client/src/app/pages/settings/space-settings-tab.component.ts'), 'utf8');
    assert.match(src, /USAGE_NOTES_MAX = 50_000/, 'the usageNotes cap must match the API\'s 50 000');
    assert.match(src, /\[attr\.maxlength\]="USAGE_NOTES_MAX"/, 'and the textarea must use it');
    assert.match(src, /char-count/, 'and the length must be visible — a cap you cannot see is one you lose work to');
  });

  it('the setup label exemption is justified — its own route caps it at the same 100', () => {
    /*
     * The exemption above is only honest while this holds. Before the cap was added the route had NO length
     * check at all, so the form's `maxlength` was the only bound and applied only to a browser.
     *
     * The bound is asserted on the TRIMMED value, which is what changed in 4.0 and is the correct form:
     * `instanceLabel` is stored as `label.trim()`, so checking the untrimmed string would refuse a label
     * that fits once its whitespace is gone. It also moved handlers — the check lived in the
     * server-rendered form's POST, which was deleted with the form, and `POST /json` had never had it
     * despite being the only reachable path since the `/setup` mount went.
     */
    const src = readFileSync(join(ROOT, 'server/src/setup/routes.ts'), 'utf8');
    assert.match(src, /const SETUP_LABEL_MAX = 100;/, 'the setup route must declare its own cap');
    assert.match(src, /label\.trim\(\)\.length > SETUP_LABEL_MAX/,
      'the cap must be enforced server-side on the value that is STORED, not only in the form');
    assert.match(src, /setupRouter\.post\('\/json'/, 'and on the path that actually runs');
  });

  it('the view name exemption is justified — the views store caps a name at the form\'s 40, and refuses beyond it', () => {
    const shape = readFileSync(join(ROOT, 'server/src/config/view-shape.ts'), 'utf8');
    assert.match(shape, /export const VIEW_NAME_MAX = 40;/, 'the view name cap moved; update the dialog\'s maxlength and this gate together');
    assert.match(shape, /name\.length <= VIEW_NAME_MAX/, 'the cap is declared and no longer enforced on a view name');
    const dialog = readFileSync(join(ROOT, 'client/src/app/pages/brain/view-create-dialog.component.ts'), 'utf8');
    assert.match(dialog, /name="name"[^>]*maxlength="40"/, 'the dialog\'s name field no longer caps at 40');
  });

  it('the API really does allow 50 000 there — or the fix is aimed at nothing', () => {
    // The space meta body is `@ythril/schema`'s (`schema/src/space-meta.ts`), re-exported by `spaces/body-schemas.ts`.
    const src = readFileSync(join(ROOT, 'schema/src/space-meta.ts'), 'utf8');
    assert.match(src, /usageNotes:\s*z\.string\(\)\.max\(50_000\)/,
      'the server cap moved; update the UI constant and this gate together');
  });
});
