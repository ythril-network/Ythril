/**
 * An instance is named by the label this instance knows it under, and an MFA sentence is said only to a caller who will be asked (bundle-81 drive).
 *
 * ## The defects this holds
 *
 *  1. A fork another instance resolved named that instance by the first eight characters of its id ("Resolved on bfec149d") while the same row's
 *     author line said "Written on Peer B". `instanceLabelOf` (`sync/instance-label.ts`) answers from the instance's own label, then its networks'
 *     members, then the labels stamped on the records at hand, never with an empty string, and with `undefined` for an instance nobody here knows.
 *  2. The re-read dialog said "You are asked for your MFA code when you confirm" on an instance with no second factor, which then asked nothing.
 *     `callerIsAskedForMfa` (`auth/mfa-asked.ts`) is the one answer, by the same policy the gates enforce, and `GET /api/mfa/status` publishes it as `asked`.
 *
 * Run: node --test testing/standalone/an-instance-is-named-where-it-is-known.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { instanceLabelOf } = await import('../../server/dist/sync/instance-label.js');
const { callerIsAskedForMfa } = await import('../../server/dist/auth/mfa-asked.js');

const cfg = {
  instanceId: 'self-id', instanceLabel: 'Home',
  networks: [{ members: [{ instanceId: 'peer-b', label: 'Peer B' }, { instanceId: 'blank', label: '' }] }],
};

describe('instanceLabelOf', () => {
  it('names this instance, a member of a network, and a stamped author, in that order', () => {
    assert.equal(instanceLabelOf(cfg, 'self-id'), 'Home');
    assert.equal(instanceLabelOf(cfg, 'peer-b', [{ instanceId: 'peer-b', instanceLabel: 'Stamped' }]), 'Peer B');
    assert.equal(instanceLabelOf(cfg, 'peer-c', [{ instanceId: 'peer-c', instanceLabel: 'Stamped C' }]), 'Stamped C');
  });
  it('knows nothing of an instance it has never met, and never answers with an empty label', () => {
    assert.equal(instanceLabelOf(cfg, 'stranger'), undefined);
    assert.equal(instanceLabelOf(cfg, 'blank'), undefined);
    assert.equal(instanceLabelOf(cfg, 'blank', [{ instanceId: 'blank', instanceLabel: '' }]), undefined);
    assert.equal(instanceLabelOf(cfg, ''), undefined);
  });
});

describe('callerIsAskedForMfa', () => {
  it('is false for an instance with no second factor enrolled, however the token is set (but "required")', () => {
    assert.equal(callerIsAskedForMfa({ mfa: undefined }), false);
    assert.equal(callerIsAskedForMfa({ mfa: 'inherit' }), false);
    assert.equal(callerIsAskedForMfa({ mfa: 'exempt' }), false);
  });
  it('is true for a token that requires it, false for an OIDC session and for no caller', () => {
    assert.equal(callerIsAskedForMfa({ mfa: 'required' }), true);
    assert.equal(callerIsAskedForMfa({ mfa: 'required', source: 'oidc' }), false);
    assert.equal(callerIsAskedForMfa(undefined), false);
  });
  it('is what GET /api/mfa/status answers as `asked`', () => {
    const src = readFileSync(new URL('../../server/src/api/mfa.ts', import.meta.url), 'utf8');
    assert.match(src, /asked:\s*callerIsAskedForMfa\(/);
  });
});
