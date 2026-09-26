/**
 * NetworkJoinDialogComponent — characterization tests for the join flow, relocated from
 * networks.component.spec.ts when the Join dialog was extracted into its own child component (PR-U3).
 * Pins the bundle validation (invalid JSON / incomplete bundle / missing my-URL), the space-id
 * collision detection + hold-for-resolution, the alias validation in confirmJoin, and the immediate
 * join path. `myUrl` is a one-way input from the host; success emits `joined`.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { NetworksApi } from '../../core/networks-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { NetworkJoinDialogComponent } from './network-join-dialog.component';

describe('NetworkJoinDialogComponent (characterization)', () => {
  let api: { joinRemote: ReturnType<typeof vi.fn>; joinByKey: ReturnType<typeof vi.fn> };

  function make(myUrl = 'https://me.example') {
    api = { joinRemote: vi.fn(() => of({ status: 'joined', networkLabel: 'X' })), joinByKey: vi.fn(() => of({ status: 'joined', networkLabel: 'P' })) };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [NetworkJoinDialogComponent, getTranslocoModule()],
      providers: [{ provide: NetworksApi, useValue: api }],
    });
    const fixture = TestBed.createComponent(NetworkJoinDialogComponent);
    fixture.componentRef.setInput('myUrl', myUrl);
    return fixture;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('rejects invalid JSON, an incomplete bundle, and a missing "my URL" without calling the API', () => {
    let c = make().componentInstance;
    c.joinBundle = 'not json';
    c.joinNetwork();
    expect(c.joinError()).toBeTruthy();
    expect(api.joinRemote).not.toHaveBeenCalled();

    c.joinBundle = JSON.stringify({ handshakeId: 'h' }); // missing inviteUrl/rsaPublicKeyPem/networkId
    c.joinNetwork();
    expect(c.joinError()).toBeTruthy();
    expect(api.joinRemote).not.toHaveBeenCalled();

    c = make('').componentInstance; // no my-URL
    c.joinBundle = JSON.stringify({ handshakeId: 'h', inviteUrl: 'u', rsaPublicKeyPem: 'k', networkId: 'n1' });
    c.joinNetwork();
    expect(c.joinError()).toBeTruthy();
    expect(api.joinRemote).not.toHaveBeenCalled();
  });

  // F-38.2: EVERY invited space waits for a target, not only one whose id collides — the operator may want a
  // non-colliding space to land on a space they already have.
  it('holds every invited space for a target instead of joining straight away', () => {
    const f = make();
    f.componentRef.setInput('availableSpaces', [{ id: 'general', label: 'General' }] as never);
    const c = f.componentInstance;
    c.joinBundle = JSON.stringify({ handshakeId: 'h', inviteUrl: 'u', rsaPublicKeyPem: 'k', networkId: 'n1', spaces: ['general', 'remote-only'] });
    c.joinNetwork();
    expect(c.joinMapSpaces()).toEqual(['general', 'remote-only']);
    expect(api.joinRemote).not.toHaveBeenCalled();
  });

  it('a pasted pub/sub key joins by key with the publisher URL, with no mapping step (F-41)', () => {
    const f = make();
    const c = f.componentInstance;
    const joined = vi.fn();
    c.joined.subscribe(joined);
    c.joinBundle = '  ythril_invite_abcdefghijklmnopqrstuvwxyz0123456789  ';
    expect(c.isPublishedKey()).toBe(true);
    c.publisherUrl = ' https://publisher.example ';
    c.joinNetwork();
    expect(api.joinRemote).not.toHaveBeenCalled();
    expect(api.joinByKey).toHaveBeenCalledWith({ publisherUrl: 'https://publisher.example', inviteKey: 'ythril_invite_abcdefghijklmnopqrstuvwxyz0123456789', myUrl: 'https://me.example' });
    expect(joined).toHaveBeenCalled();
  });

  it('an invite code or bundle is not mistaken for a published key', () => {
    const c = make().componentInstance;
    for (const text of ['ythril1_abc', '{"handshakeId":"h"}', '']) { c.joinBundle = text; expect(c.isPublishedKey()).toBe(false); }
  });

  it('keeping every name joins with no map, and emits "joined" on success', () => {
    const f = make();
    f.componentRef.setInput('availableSpaces', [{ id: 'general', label: 'General' }] as never);
    const c = f.componentInstance;
    const joined = vi.fn();
    c.joined.subscribe(joined);
    c.joinBundle = JSON.stringify({ handshakeId: 'h', inviteUrl: 'u', rsaPublicKeyPem: 'k', networkId: 'n1', spaces: ['remote-only'] });
    c.joinNetwork();
    c.confirmJoin();
    expect(api.joinRemote).toHaveBeenCalledWith(expect.objectContaining({ handshakeId: 'h', myUrl: 'https://me.example', networkId: 'n1' }));
    expect(api.joinRemote.mock.calls[0][0].spaceMap).toBeUndefined();
    expect(joined).toHaveBeenCalled();
  });

  it('a space mapped onto an existing local space joins with that mapping, and must name one', () => {
    const f = make();
    f.componentRef.setInput('availableSpaces', [{ id: 'team-flows', label: 'Team flows' }] as never);
    const c = f.componentInstance;
    c.joinBundle = JSON.stringify({ handshakeId: 'h', inviteUrl: 'u', rsaPublicKeyPem: 'k', networkId: 'n1', spaces: ['flows'] });
    c.joinNetwork();
    c.onCollisionActionChange('flows', 'mapToExisting');
    c.confirmJoin();                                   // no space picked yet
    expect(c.joinError()).toContain('pickExisting');
    expect(api.joinRemote).not.toHaveBeenCalled();
    c.joinSpaceTargets['flows'] = 'team-flows';
    c.confirmJoin();
    expect(api.joinRemote).toHaveBeenCalledWith(expect.objectContaining({ spaceMap: { flows: 'team-flows' } }));
  });

  it('confirmJoin() validates alias inputs, then joins with a spaceMap', () => {
    const f = make();
    f.componentRef.setInput('availableSpaces', [{ id: 'general' }] as never);
    const c = f.componentInstance;
    c.joinBundle = JSON.stringify({ handshakeId: 'h', inviteUrl: 'u', rsaPublicKeyPem: 'k', networkId: 'n1', spaces: ['general'] });
    c.joinNetwork(); // → holds for a target
    expect(c.joinMapSpaces()).toEqual(['general']);

    c.onCollisionActionChange('general', 'alias');
    c.joinSpaceAliases['general'] = ''; // blank alias → error, no join
    c.confirmJoin();
    expect(c.joinError()).toBeTruthy();
    expect(api.joinRemote).not.toHaveBeenCalled();

    c.joinSpaceAliases['general'] = 'general-local'; // valid alias → joins with spaceMap
    c.confirmJoin();
    expect(api.joinRemote).toHaveBeenCalledWith(expect.objectContaining({ spaceMap: { general: 'general-local' } }));
  });

  /*
   * The one-line invite code (`F-18`). The old JSON bundle keeps working above -- an invite generated
   * before the upgrade must not become unusable by upgrading the joiner, and operators have them in flight.
   */
  it('accepts a one-line invite code, and joins with what it decodes to', () => {
    const f = make();
    const joined = vi.fn();
    f.componentInstance.joined.subscribe(joined);
    const bundle = { handshakeId: 'h-code', inviteUrl: 'https://inviter.example/api/invite/apply',
      rsaPublicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
      networkId: 'n-code', spaces: ['remote-only'] };
    const code = 'ythril1_' + btoa(JSON.stringify(bundle))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    // Pasted with the whitespace a selection picks up, because that is how one arrives.
    f.componentInstance.joinBundle = `  ${code}\n`;
    f.componentInstance.joinNetwork();
    f.componentInstance.confirmJoin();   // the space mapping step, keeping the name

    expect(f.componentInstance.joinError()).toBe('');
    expect(api.joinRemote).toHaveBeenCalledWith(expect.objectContaining({
      handshakeId: 'h-code', networkId: 'n-code', myUrl: 'https://me.example',
    }));
    expect(joined).toHaveBeenCalled();
  });

  it('a damaged code fails as a CODE, not as invalid JSON', () => {
    // The two mistakes are different, and so are their fixes: "invalid JSON" sent to somebody who pasted a
    // code points them at the wrong thing entirely.
    const c = make().componentInstance;
    c.joinBundle = 'ythril1_not-base64-at-all!!';
    c.joinNetwork();
    // The KEY, not the sentence: the testing harness does not translate, and pinning English text here
    // would break on a wording improvement while proving nothing about which failure was reported.
    expect(c.joinError()).toContain('invalidCode');
    expect(api.joinRemote).not.toHaveBeenCalled();
  });
});
