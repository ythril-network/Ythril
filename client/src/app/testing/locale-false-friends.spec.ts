/**
 * A German or Polish value means what its English source means, where English spells two senses alike (`Q-115`).
 *
 * One question — "did the translation pick the wrong sense of an English word?" — answered by two tables, because
 * the fault arrives in two shapes: an ACTION translated as an adjective (below), and the product's own NOUN
 * translated as the everyday word it is spelled like (`PRODUCT_TERMS`, further down).
 *
 * ## Actions
 *
 * A label that names an ACTION in English names an action in German and Polish too.
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

/**
 * ## Product terms
 *
 * The product's nouns, and the everyday word each is spelled like in English that a translation must NOT use for
 * it. A Ythril "space" is a container of knowledge; machine translation read it as the typed whitespace character
 * — German "Leerzeichen", Polish "spacja" — in 19 values, among them "Noch keine Leerzeichen" on the Brain page and
 * "Leerzeichen erstellen/löschen" on the MFA card, while the rest of each file said "Space" / "przestrzeń".
 *
 * Derived from en: every key whose English value names the noun is checked, not a list of known keys. The en file
 * has no value where "space" means whitespace today; if one is ever added, it belongs in `WHITESPACE_KEYS` with the
 * reason, rather than weakening the rule.
 */
const PRODUCT_TERMS: { en: RegExp; wrong: { de: RegExp; pl: RegExp } }[] = [
  { en: /\bspaces?\b/i, wrong: { de: /leerzeichen/i, pl: /spacj/i } },
];
/** Keys whose English "space" genuinely means the whitespace character. None today. */
const WHITESPACE_KEYS: ReadonlySet<string> = new Set<string>();

describe('product terms are translated as the product noun, not the everyday word (Q-115)', () => {
  const en = load('en');
  const others = { de: load('de'), pl: load('pl') };

  it('no value translates a Ythril space as a whitespace character', () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const term of PRODUCT_TERMS) {
      for (const [key, value] of Object.entries(en)) {
        if (typeof value !== 'string' || !term.en.test(value) || WHITESPACE_KEYS.has(key)) continue;
        checked++;
        for (const loc of ['de', 'pl'] as const) {
          const got = others[loc][key];
          if (typeof got === 'string' && term.wrong[loc].test(got)) wrong.push(`${loc}: ${key} = ${JSON.stringify(got)}`);
        }
      }
    }
    // Floor: "space" is the product's commonest noun — over two hundred values name it.
    expect(checked).toBeGreaterThan(100);
    expect(wrong, `these values use the everyday word for a product noun:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });
});
