/**
 * The first admin token of a freshly started Ythril instance: complete its first-run setup over HTTP and return the token the answer carries.
 *
 * ## What it answers
 *
 * One question: *give me an admin token for the instance at this URL, which has never been set up.* `testing/sync/setup.js` asks it for every
 * instance of the test stack, and `tools/flow-checks/_stack.mjs` asks it for every instance of a flow-check probe's scratch stack. Two
 * callers made it a module (Q-917): the request, its credentials and the refusal of an answer without a token were written once, in setup.js.
 *
 * ## What it prevents
 *
 * A setup that "succeeds" and hands back nothing. A response without a token throws here instead of returning `undefined`, so a caller can
 * never go on to send `Bearer undefined` and read the 401 as a finding about its subject. The token is returned, never printed: a caller that
 * logs it redacts it itself (the shape's `say` does).
 */

/** The label and settings password the harness instances are set up with; the stack is thrown away, so the password is not a secret. */
const SETUP_BODY = (label) => ({ label, settingsPassword: 'testpassword123!' });

/**
 * @param {string} url  Base URL of the instance, without a trailing slash.
 * @param {{ who?: string, label?: string, fetchImpl?: typeof fetch }} [opts]  `who` names the instance in an error; `fetchImpl` is the test seam.
 * @returns {Promise<string>} The plaintext first admin token.
 */
export async function firstAdminToken(url, { who = url, label = `Test Instance ${who}`, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${url}/api/setup/json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SETUP_BODY(label)),
  });
  if (!res.ok) throw new Error(`Setup failed for ${who}: ${res.status} ${await res.text()}`);
  const { plaintext } = await res.json();
  if (!plaintext) throw new Error(`Setup response for ${who} did not include a token`);
  return plaintext;
}
