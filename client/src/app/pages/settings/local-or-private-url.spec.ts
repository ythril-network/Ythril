import { describe, it, expect } from 'vitest';
import { isLocalOrPrivateUrl } from './local-or-private-url';

describe('isLocalOrPrivateUrl: an address only this machine or its own network reaches', () => {
  it.each([
    'http://localhost:3200', 'http://[::1]:3200', 'http://127.0.0.1', 'http://10.1.2.3', 'http://192.168.1.5', 'http://169.254.1.1',
    'http://172.16.0.1', 'http://172.21.0.5', 'http://[fd12:3456::1]', 'http://[fe80::1]',
  ])('%s is local or private', (url) => expect(isLocalOrPrivateUrl(url)).toBe(true));

  it.each(['https://brain.example.com', 'http://8.8.8.8', 'http://172.15.0.1', 'http://172.32.0.1'])('%s is public', (url) => expect(isLocalOrPrivateUrl(url)).toBe(false));

  it('an address that does not parse is answered local: no peer can reach it', () => {
    expect(isLocalOrPrivateUrl('not a url')).toBe(true);
    expect(isLocalOrPrivateUrl('')).toBe(true);
  });
});
