/**
 * A token minted for one test file (or one case), and removed when that file's run ends: the only way a stack-suite file that
 * makes a heavy call gets its token.
 *
 * ## What it prevents
 *
 * The heavy-call limit is five a minute per token (`server/src/rate-limit/heavy-tool.ts`), counted across every door that shares it:
 * the stored-data schema check, the conversion start, ingest, the file stamp report and the tools declared `heavy`. Every file of a
 * suite reads the same setup token from `testing/sync/configs/<x>/token.txt`, so whether one file's call is refused depends on which
 * files ran in the minute before it. Main run 44736302108 was red on `schema-validation.test.js` (a 429 where it expected 200): the
 * two files before it had paid five slots on that token. The limit is right; the files must not share its budget.
 * `testing/standalone/a-heavy-call-in-a-stack-test-spends-its-own-tokens-budget.test.js` holds that no such file does.
 *
 * ## The forgettable parts are inside
 *
 * - Removal: `ownTokens()` registers its `after` hook itself, so a test that fails, or a file that forgets cleanup, leaves no token
 *   behind. Call it at the top of the file, BEFORE the file's first `before(...)` (a file-level `before` runs the moment it is registered,
 *   so a `const own` below it is still uninitialised when the hook reads it: Full run 44753447026), or inside the `describe` whose cases
 *   it serves. A cleanup that uses a minted token is registered as `own.after(fn)`, so it runs before the token is removed.
 * - Minting is not rate limited on instances A and B (`SKIP_AUTH_RATE_LIMIT`). Instance C keeps the real `authRateLimit` (ten token
 *   creates a minute per address) because its tests probe it: a file on C mints in its first hook, before it bursts.
 * - A refused mint throws with the answer in the message, never a token that is `undefined` and fails three tests later.
 *
 * One question: "give me a token of my own". The rights are a parameter (default: the instance admin's, which is what the shared setup
 * token is), so a file that needs a narrower token mints that one and still pays from its own budget.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { INSTANCES } from '../sync/helpers.js';

const CONFIGS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sync', 'configs');
const AREAS = ['knowledge', 'files', 'schema', 'dataQuality', 'networks'];

/** What the shared setup token holds: administers the instance and every space, may create spaces. */
export const INSTANCE_ADMIN_RIGHTS = Object.freeze({
  instanceAdmin: true,
  createSpaces: true,
  perSpace: {},
  floor: Object.freeze(Object.fromEntries(AREAS.map(a => [a, 'admin']))),
});

/**
 * @param {{ instance?: 'a'|'b'|'c'|'d' }} [opts] the instance the tokens are minted on and removed from
 * @returns {{ mint: (label: string, rights?: object) => Promise<string> }} `mint` answers the plaintext of a new token named after `label`
 */
export function ownTokens({ instance = 'a' } = {}) {
  const base = INSTANCES[instance];
  if (!base) throw new Error(`ownTokens: no instance ${JSON.stringify(instance)}`);
  const ids = [];
  const cleanups = [];
  const authority = () => fs.readFileSync(path.join(CONFIGS, instance, 'token.txt'), 'utf8').trim();
  // ONE hook, so the order is the helper's and not the file's: the file's own cleanups (they use the token) run first, the tokens go last, and
  // they go even when a cleanup throws. Node runs a file-level `after` in registration order, so a token hook registered before the file's
  // cleanup would remove the token its cleanup still needs.
  after(async () => {
    try {
      for (const fn of cleanups) await fn();
    } finally {
      const admin = authority();
      for (const id of ids) {
        await fetch(`${base}/api/tokens/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin}` } }).catch(() => {});
      }
    }
  });
  return {
    /** Register a cleanup that uses a minted token: it runs before the tokens are removed. */
    after(fn) { cleanups.push(fn); },
    async mint(label, rights = INSTANCE_ADMIN_RIGHTS) {
      const res = await fetch(`${base}/api/tokens`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authority()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${label}-${Date.now()}`, rights }),
      });
      const body = await res.json().catch(() => null);
      if (res.status !== 201 || typeof body?.plaintext !== 'string') {
        throw new Error(`ownTokens: minting ${label} on instance ${instance} answered ${res.status}: ${JSON.stringify(body)}`);
      }
      const id = body.id ?? body.token?.id;
      if (id) ids.push(id);
      return body.plaintext;
    },
  };
}
