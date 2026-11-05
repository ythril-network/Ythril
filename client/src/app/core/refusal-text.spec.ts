/**
 * A refusal always says something true: the client's words for a code it knows, the server's sentence for one it
 * does not, and the fallback only when the answer carried neither (`Q-133`). Never the raw code, never a blank.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { refusalText } from './refusal-text';

const known: Record<string, string> = {
  'networks.refusal.join_mapping_collision': 'Two spaces would land in one.',
  'join.error.generic': 'Joining failed.',
};
const transloco = { translate: (key: string) => known[key] ?? key } as Parameters<typeof refusalText>[0];

describe('refusalText', () => {
  it('translates a code the client knows', () => {
    const err = { error: { code: 'join_mapping_collision', error: 'server sentence' } };
    expect(refusalText(transloco, err, 'join.error.generic')).toBe('Two spaces would land in one.');
  });

  it("falls back to the server's sentence for a code the client has no words for", () => {
    const err = { error: { code: 'some_future_code', error: 'The server says why.' } };
    expect(refusalText(transloco, err, 'join.error.generic')).toBe('The server says why.');
  });

  it('uses the server sentence when there is no code', () => {
    expect(refusalText(transloco, { error: { error: 'Plain refusal.' } }, 'join.error.generic')).toBe('Plain refusal.');
  });

  it('reads a code in the key family it is given, and offers the answer\'s path to the sentence', () => {
    const words: Record<string, string> = { 'files.refusal.path_blocked': 'Blocked: {{path}}' };
    const t = { translate: (key: string, p?: { path?: string }) => (words[key] ?? key).replace('{{path}}', p?.path ?? '') } as Parameters<typeof refusalText>[0];
    const err = { error: { code: 'path_blocked', path: 'a.txt/x', error: 'server sentence' } };
    expect(refusalText(t, err, 'join.error.generic', 'files.refusal')).toBe('Blocked: a.txt/x');
    // The same code in the default (network) family has no words, so the server's sentence is said.
    expect(refusalText(t, err, 'join.error.generic')).toBe('server sentence');
  });

  it('offers the answer\'s heldBy to the sentence beside the path', () => {
    const words: Record<string, string> = { 'files.refusal.held': '{{path}} is held by {{heldBy}}' };
    const t = {
      translate: (key: string, p?: { path?: string; heldBy?: string }) =>
        (words[key] ?? key).replace('{{path}}', p?.path ?? '').replace('{{heldBy}}', p?.heldBy ?? ''),
    } as Parameters<typeof refusalText>[0];
    const err = { error: { code: 'held', path: 'b.txt', heldBy: 'o/c.txt', error: 'server sentence' } };
    expect(refusalText(t, err, 'join.error.generic', 'files.refusal')).toBe('b.txt is held by o/c.txt');
  });

  it('appends the request id to a server fault, whichever sentence was chosen, and to nothing the caller caused', () => {
    const headers = { get: (n: string) => (n === 'X-Request-Id' ? 'req-9' : null) };
    const fault = { status: 500, headers, error: { code: 'some_future_code', error: 'The server says why.' } };
    expect(refusalText(transloco, fault, 'join.error.generic')).toBe('The server says why. (request req-9)');
    const known500 = { status: 500, headers, error: { code: 'join_mapping_collision' } };
    expect(refusalText(transloco, known500, 'join.error.generic')).toBe('Two spaces would land in one. (request req-9)');
    const refused = { status: 409, headers, error: { code: 'join_mapping_collision' } };
    expect(refusalText(transloco, refused, 'join.error.generic')).toBe('Two spaces would land in one.');
  });

  it('uses the fallback key only when the answer carried neither', () => {
    expect(refusalText(transloco, { error: null }, 'join.error.generic')).toBe('Joining failed.');
    expect(refusalText(transloco, undefined, 'join.error.generic')).toBe('Joining failed.');
  });
});

/**
 * A locked second factor says so, with the wait, in the reader's language and in EVERY key family (Q-694, bundle-233).
 *
 * ## The defect
 *
 * The server now answers the sixth attempt inside 15 minutes with `429 { error, code: 'MFA_LOCKED', key, retryAfterSeconds,
 * retryable: false, message }`, a correct code included. A client that reads the answer as before shows the server's English `message`
 * in German and Polish, or, on the enrolment confirm and the disable button, "Could not verify code" and nothing at all: the person
 * keeps typing codes into a lock that cannot open for `retryAfterSeconds`.
 *
 * ## What is held
 *
 * The REAL locale files are read (not a stub's words): one shared key per lock, `refusal.mfaLocked.<token|address>`, with the plural
 * forms `.one/.few/.many/.other` and the wait as `{{count}}` minutes, in en, de and pl. The code is read from `body.code` under whatever
 * key family the caller names (the default network family and the file family here: a code names a sentence only inside its family,
 * and this one must not depend on which screen asked). The wait is `ceil(retryAfterSeconds / 60)` minutes, at least one, in the
 * language's own plural form and number format; an answer with no wait still says a true sentence, never the raw code, `NaN` or a
 * blank. The server's own English `message` is the fallback for a client that has no words, never the answer in a language that has them.
 */
const LOCALES = ['en', 'de', 'pl'] as const;
const FORMS = ['one', 'few', 'many', 'other'] as const;
const KEYS = ['token', 'address'] as const;
const FAMILIES = ['networks.refusal', 'files.refusal'] as const;
const words = (language: string): Record<string, string> =>
  JSON.parse(readFileSync(`public/assets/i18n/${language}.json`, 'utf8')) as Record<string, string>;
const translatorFor = (language: string) => {
  const dictionary = words(language);
  return {
    translate: (key: string, params?: Record<string, unknown>) => {
      const text = dictionary[key];
      return text === undefined ? key : text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(params?.[name] ?? ''));
    },
    getActiveLang: () => language,
  } as Parameters<typeof refusalText>[0];
};
const SERVER_SENTENCE = 'Too many wrong codes for this token; wait before trying again.';
const lockAnswer = (key: 'token' | 'address', retryAfterSeconds?: number) => ({
  status: 429,
  headers: { get: (_name: string) => null },
  error: {
    error: 'MFA_LOCKED', code: 'MFA_LOCKED', key, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }), retryable: false, message: SERVER_SENTENCE,
  },
});
/** The sentence the locale file gives for `minutes`, computed here from the file and `Intl`, not from the module under test. */
const expectedLock = (language: string, key: string, minutes: number): string => {
  const dictionary = words(language);
  const form = new Intl.PluralRules(language).select(minutes);
  const template = dictionary[`refusal.mfaLocked.${key}.${form}`] ?? dictionary[`refusal.mfaLocked.${key}.other`];
  expect(template, `${language}.json has no refusal.mfaLocked.${key}.${form} (nor .other): the lock has no words`).toBeTruthy();
  return template.replace('{{count}}', new Intl.NumberFormat(language).format(minutes));
};

describe('refusalText: a locked second factor (429 MFA_LOCKED)', () => {
  for (const language of LOCALES) {
    it(`${language}: the locale file has one sentence per plural form for each key, and each says the wait`, () => {
      const dictionary = words(language);
      for (const key of KEYS) {
        for (const form of FORMS) {
          const text = dictionary[`refusal.mfaLocked.${key}.${form}`];
          expect(text, `${language}.json has no refusal.mfaLocked.${key}.${form}`).toBeTruthy();
          expect(text, `refusal.mfaLocked.${key}.${form} must carry the wait as {{count}}`).toContain('{{count}}');
        }
      }
      expect(dictionary['refusal.mfaLocked.token.other']).not.toBe(dictionary['refusal.mfaLocked.address.other']);
    });
  }

  for (const language of LOCALES) {
    for (const family of FAMILIES) {
      for (const key of KEYS) {
        for (const [seconds, minutes] of [[45, 1], [60, 1], [61, 2], [120, 2], [300, 5]] as const) {
          it(`${language} / ${family} / ${key} lock, ${seconds} s: says ${minutes} minute${minutes === 1 ? '' : 's'} in the language's own plural form`, () => {
            const text = refusalText(translatorFor(language), lockAnswer(key, seconds), 'join.error.generic', family);
            expect(text).toBe(expectedLock(language, key, minutes));
            expect(text).toContain(new Intl.NumberFormat(language).format(minutes));
            expect(text, 'the server\'s English sentence stands in for words the client has').not.toBe(SERVER_SENTENCE);
            expect(text).not.toContain('MFA_LOCKED');
            expect(text).not.toContain('{{');
          });
        }
      }
    }
  }

  for (const language of LOCALES) {
    it(`${language}: an answer with no wait (no retryAfterSeconds, no Retry-After header) still says a true sentence`, () => {
      for (const key of KEYS) {
        const text = refusalText(translatorFor(language), lockAnswer(key), 'join.error.generic');
        expect(text.trim(), 'a lock with no wait said nothing').not.toBe('');
        expect(text).not.toContain('MFA_LOCKED');
        expect(text).not.toContain('{{');
        expect(text).not.toMatch(/NaN|undefined|Infinity/);
        if (language !== 'en') expect(text, 'the server\'s English sentence was shown in a language that has words').not.toBe(SERVER_SENTENCE);
      }
    });
  }

  it('the two keys say different things: a lock on the token is not a lock on the address', () => {
    for (const language of LOCALES) {
      expect(refusalText(translatorFor(language), lockAnswer('token', 300), 'x'))
        .not.toBe(refusalText(translatorFor(language), lockAnswer('address', 300), 'x'));
    }
  });

  it('a lock is not a server fault: no request id is appended', () => {
    const answer = { ...lockAnswer('token', 300), headers: { get: (n: string) => (n === 'X-Request-Id' ? 'req-1' : null) } };
    expect(refusalText(translatorFor('en'), answer, 'x')).not.toContain('req-1');
  });
});
