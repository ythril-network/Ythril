/**
 * A label that names an ACTION in English names an action in German and Polish too (`Q-115`).
 *
 * English spells the verb and the adjective the same way, and machine translation picks the wrong one: the Query
 * tab's clear button read "Klare Ergebnisse" (clear as in transparent) and the entity search's read "Klar", with
 * Polish "Jasne wyniki" / "Jasne" (bright, or "sure!"). Polish also had "Nastawić" (to set a clock) for Reset and
 * the infinitive "Zamknąć" for Close — a button that reads like a dictionary entry rather than a command.
 *
 * Nothing else can catch it. The key exists, the value is a real word in the right language, the test harness
 * echoes keys rather than values, and only a reader of that language sees the defect.
 *
 * So the rule is stated POSITIVELY and derived from en: every value whose first word is one of these imperatives
 * must, in de and pl, contain a verb that performs it. A denylist of today's bad words would pass the next wrong
 * sense. The lists are the verbs a correct translation uses; a correct synonym missing from them fails loudly and
 * is one word to add.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const I18N = resolve(__dirname, '../../../public/assets/i18n');
const load = (loc: string): Record<string, string> => JSON.parse(readFileSync(join(I18N, `${loc}.json`), 'utf8'));

/** English imperative → the verbs (lower-cased stems) that perform it, per locale. */
const ACTIONS: Record<string, { de: RegExp; pl: RegExp }> = {
  clear: {
    de: /(löschen|leeren|entfernen|zurücksetzen|aufheben)/i,
    pl: /(wyczyść|usuń|wyzeruj|zresetuj|czyści)/i,
  },
  reset: {
    de: /(zurücksetzen|zurückstellen)/i,
    // `zeruj` / `wyzerować`: reset a COUNTER to zero, which is what "Reset usage" does.
    pl: /(zresetuj|resetuj|zeruj|wyzerowa|przywróć)/i,
  },
  close: {
    de: /(schließen)/i,
    pl: /(zamknij)/i,
  },
};

describe('action labels are verbs in every locale (Q-115)', () => {
  const en = load('en');
  const others = { de: load('de'), pl: load('pl') };

  it('every value that starts with an imperative is translated as that action', () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const [key, value] of Object.entries(en)) {
      if (typeof value !== 'string') continue;
      const first = value.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
      const verbs = ACTIONS[first];
      if (!verbs) continue;
      checked++;
      for (const loc of ['de', 'pl'] as const) {
        const got = others[loc][key];
        if (typeof got !== 'string' || !verbs[loc].test(got)) {
          wrong.push(`${loc}: ${key} = ${JSON.stringify(got)} (en ${JSON.stringify(value)})`);
        }
      }
    }
    // Floor: en has well over a dozen such labels, so finding none means the scan broke, not that all is well.
    expect(checked).toBeGreaterThan(10);
    expect(wrong, `these labels do not say the action their English names:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });
});
