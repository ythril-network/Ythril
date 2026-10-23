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
import { dictionary } from './i18n-dictionary';

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
  // Q-549: the glossary of the verbs every dialog and toolbar repeats. Polish read "Ratować" (to rescue) for Save, "Anulować" and
  // "Tworzyć" (dictionary infinitives) for Cancel and Create, "Usunąć" for Delete and "Wgrywać" for Upload - each a real word of the
  // right language and not the command a button gives. The regexes are the imperative (or, in German, the infinitive a label uses).
  save: {
    de: /(speicher)/i, // speichern, and the du-imperative "Speichere ..."
    pl: /(zapisz)/i,
  },
  cancel: {
    de: /(abbrechen)/i,
    pl: /(anuluj)/i,
  },
  create: {
    // Widened for correct sentences: "Erstellt eine ..." / "Tworzy ..." (a description in the third person), the separable
    // "Legen Sie ... an", and "Stwórz" (the other Polish verb for the same act). The bare infinitive "Tworzyć" stays wrong.
    de: /(erstellen|erstellt|anlegen|hinzufügen|\blege?n?\b[^.]*\ban\b)/i,
    pl: /(utwórz|dodaj|tworzy(?!ć)|stwórz)/i,
  },
  delete: {
    de: /(löschen|entfernen)/i,
    // Widened for correct Polish: the infinitive IS the right form of a confirmation QUESTION ("Usunąć webhook?"), so it counts
    // only before a question mark; "Usuwaj" (imperative), and the noun "Usunięcie" of a label that names the act. A bare
    // "Usunąć" on a button, and "Usuwać?", stay wrong.
    pl: /(usuń|usuwaj|usunięci|usunąć[^?]*\?)/i,
  },
  remove: {
    de: /(entfernen|löschen)/i,
    pl: /(usuń|usuwaj|usunięci|usunąć[^?]*\?)/i,
  },
  upload: {
    // "Laden Sie Dateien hoch": the separable verb is correct.
    de: /(hochladen|\blade?n?\b[^.]*\bhoch\b)/i,
    pl: /(prześlij|wgraj)/i,
  },
};

describe('action labels are verbs in every locale (Q-115)', () => {
  const en = dictionary('en');
  const others = { de: dictionary('de'), pl: dictionary('pl') };

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
  const en = dictionary('en');
  const others = { de: dictionary('de'), pl: dictionary('pl') };

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

/**
 * ## Record kinds (Q-573)
 *
 * The product has seven nouns for what it holds - entity, fact, edge, link, file, chrono entry, space - and every one of them had two or three
 * words in German and in Polish: a fact was "Erinnerung", "Tatsache" and "Speicher" in German and "wspomnienie", "pamięć" and "fakt" in Polish;
 * an entity was "Entität" / "Entity" and "podmiot" / "encja" / "jednostka"; a file was "Akta" on one tab and "pliki" everywhere else; a space was
 * "Raum", "Bereich", "Platz" and "Speicherplatz". Each word is a fair translation of its English and each key is right on its own page, so
 * no per-key check can see it: it is the SET of words that makes a reader wonder whether "Erinnerungen" and "Fakten" are two things.
 *
 * One word per kind is pinned (`RECORD_TERMS`), as a stem so every case and number of it matches, and checked three ways, derived from en and
 * never from a list of keys:
 *
 *  - positively: every de / pl value whose en value names the kind contains the pinned stem, unless it is in `STEM_EXEMPT` with the reason
 *    (a sentence that names the kind by a pronoun has no noun to pin);
 *  - negatively: no value naming the kind carries a stem the kind is known to be mistranslated as (`wrong`);
 *  - tab names: the keys of sibling tabs (the shape `sibling-tabs-have-distinct-names` derives, plus `nav.*`) use the pinned stem too, because
 *    a menu says the kind before any sentence does.
 *
 * "Names the kind" is read on the PROSE of an en value: placeholders (`{{space}}`), brace blocks (JSON samples) and dotted or slashed
 * identifiers (`entity.name`, `entity/edge/fact/chrono`) are blanked first, because a schema key name stays English in every language and
 * is not a sentence about the kind. A chrono label standing alone ("Chrono", "Chrono ({{count}})") keeps its name, as the tab does; a
 * chrono entry in a sentence is "Chrono-Eintrag" / "wpis chronologiczny".
 *
 * The pins are the ticket's decisions, not a survey of what the files say today: the point of the gate is to make the files agree.
 */
interface RecordTerm {
  kind: string;
  /** The en marker, on word boundaries, read on the prose of the value. */
  en: RegExp;
  /** The pinned stem per locale. */
  stem: { de: RegExp; pl: RegExp };
  /** The stem a bare label of the kind takes (the tab, a column head), where it differs from the sentence stem. */
  label?: { de: RegExp; pl: RegExp };
  /** Stems the kind is known to be mistranslated as; null where none is pinned. */
  wrong: { de: RegExp | null; pl: RegExp | null };
  /** Far below the real count of en values naming the kind: it tells "found" from "none found". */
  floor: number;
  /** The kind has a sibling tab or menu entry, and its name is checked. */
  hasTab: boolean;
}

const RECORD_TERMS: readonly RecordTerm[] = [
  { kind: 'entity', en: /\bentit(?:y|ies)\b/i, stem: { de: /entität/i, pl: /podmiot/i }, wrong: { de: null, pl: /encj|jednost/i }, floor: 30, hasTab: true },
  { kind: 'fact', en: /\bfacts?\b/i, stem: { de: /fakt/i, pl: /fakt/i }, wrong: { de: /erinnerung|tatsache/i, pl: /wspomnie/i }, floor: 20, hasTab: true },
  { kind: 'edge', en: /\bedges?\b/i, stem: { de: /kante/i, pl: /krawęd/i }, wrong: { de: /beziehung/i, pl: /relacj/i }, floor: 20, hasTab: true },
  // The word most values already use. A key naming a link is outside the edge check: an edge is a record, a link is a reference.
  { kind: 'link', en: /\blinks?\b/i, stem: { de: /verknüpf/i, pl: /powiąz/i }, wrong: { de: null, pl: null }, floor: 8, hasTab: false },
  { kind: 'file', en: /\bfiles?\b/i, stem: { de: /datei/i, pl: /plik/i }, wrong: { de: null, pl: /\bakt(?:a|ach|ami)?\b/i }, floor: 60, hasTab: true },
  {
    kind: 'chrono', en: /\bchrono\b/i, stem: { de: /chrono-?eintr/i, pl: /chronologiczn/i }, label: { de: /chrono/i, pl: /chrono/i },
    wrong: { de: /zeitleiste|zeitachse|timeline/i, pl: /osi czasu/i }, floor: 8, hasTab: true,
  },
  // The PRODUCT_TERMS row above keeps guarding the whitespace sense ("Leerzeichen", "spacja"); this one pins the product noun itself.
  { kind: 'space', en: /\bspaces?\b/i, stem: { de: /space/i, pl: /przestrze/i }, wrong: { de: /\bräum|\braum\b/i, pl: null }, floor: 150, hasTab: true },
];

/**
 * A key whose de / pl value is allowed to lack the pinned stem of a kind its en value names, with the reason. Keyed `<kind>:<key>`. None
 * today: every value that lacked a stem when this gate was written was a word to fix, none names the kind by a pronoun.
 */
const STEM_EXEMPT: Readonly<Record<string, string>> = {};

/** The en value with what is not a sentence about the kind blanked: placeholders, brace blocks, dotted and slashed identifiers. */
function prose(value: string): string {
  let v = value.replace(/\{\{[^}]*\}\}/g, ' ');
  for (let i = 0; i < 4; i++) v = v.replace(/\{[^{}]*\}/g, ' ');
  return v.replace(/\b[a-z]+(?:\.[a-z]+)+\b/g, ' ').replace(/\b[a-z]+(?:\/[a-z]+)+\b/g, ' ');
}

/** Whether the value is only the kind's own name: "Chrono", "chrono", "Chrono ({{count}})", "Facts:". */
const isBareLabel = (value: string, kind: string): boolean => prose(value).replace(/[^a-z]/gi, '').toLowerCase().replace(/s$/, '') === kind;

/** The stem a translated value must carry for an en value that names the kind. */
const stemFor = (term: RecordTerm, enValue: string, loc: 'de' | 'pl'): RegExp => (term.label && isBareLabel(enValue, term.kind) ? term.label[loc] : term.stem[loc]);

/** The keys of sibling tabs and menu entries, by the shape `sibling-tabs-have-distinct-names` uses. */
const isTabKey = (key: string): boolean => (/^(.*\.tabs?)\.[^.]+$/.test(key) && !/(Title|Hint|Section)$/.test(key)) || key.startsWith('nav.');

describe('one word per record kind in every locale (Q-573)', () => {
  const en = dictionary('en');
  const others = { de: dictionary('de'), pl: dictionary('pl') };
  const naming = (term: RecordTerm): string[] =>
    Object.keys(en).filter(key => typeof en[key] === 'string' && term.en.test(prose(en[key]!)));

  for (const term of RECORD_TERMS) {
    it(`${term.kind}: finds the en values that name it (a floor, so a changed marker cannot pass by finding none)`, () => {
      expect(naming(term).length).toBeGreaterThanOrEqual(term.floor);
    });
  }

  it('every STEM_EXEMPT entry says why, and still lacks the stem it is exempt from', () => {
    for (const [entry, reason] of Object.entries(STEM_EXEMPT)) {
      const [kind, key] = [entry.slice(0, entry.indexOf(':')), entry.slice(entry.indexOf(':') + 1)];
      const term = RECORD_TERMS.find(t => t.kind === kind);
      expect(term, `${entry}: no such kind`).toBeTruthy();
      expect(reason.trim().length, `${entry}: an exemption needs its reason written`).toBeGreaterThan(20);
      const lacking = (['de', 'pl'] as const).some(loc => !stemFor(term!, en[key] ?? '', loc).test(others[loc][key] ?? ''));
      expect(lacking, `${entry} now carries the stem - remove its exemption`).toBe(true);
    }
  });

  for (const term of RECORD_TERMS) {
    for (const loc of ['de', 'pl'] as const) {
      it(`${loc}: every value whose en value names the ${term.kind} kind says it with the one pinned word`, () => {
        const missing = naming(term)
          .filter(key => !(`${term.kind}:${key}` in STEM_EXEMPT))
          .filter(key => !stemFor(term, en[key]!, loc).test(others[loc][key] ?? ''))
          .map(key => `${key} = ${JSON.stringify(others[loc][key])}  (en ${JSON.stringify(en[key])})`);
        expect(missing, `${loc}: ${missing.length} values name the ${term.kind} kind without ${stemFor(term, '', loc)}:\n  ${missing.join('\n  ')}`).toEqual([]);
      });

      if (term.wrong[loc]) {
        it(`${loc}: no value naming the ${term.kind} kind uses ${term.wrong[loc]}, the word it was mistranslated as`, () => {
          const wrong = naming(term)
            .filter(key => term.wrong[loc]!.test(others[loc][key] ?? ''))
            .map(key => `${key} = ${JSON.stringify(others[loc][key])}  (en ${JSON.stringify(en[key])})`);
          expect(wrong, `${loc}: ${wrong.length} values call the ${term.kind} kind by its wrong word:\n  ${wrong.join('\n  ')}`).toEqual([]);
        });
      }
    }
  }

  describe('tab and menu names', () => {
    const tabKeys = Object.keys(en).filter(isTabKey);

    it('finds the sibling tabs of each kind that has one (a floor per kind)', () => {
      for (const term of RECORD_TERMS.filter(t => t.hasTab)) {
        const named = tabKeys.filter(key => typeof en[key] === 'string' && term.en.test(prose(en[key]!)));
        expect(named.length, `no tab or menu key names the ${term.kind} kind`).toBeGreaterThanOrEqual(1);
      }
    });

    for (const loc of ['de', 'pl'] as const) {
      it(`${loc}: a tab or menu entry that names a record kind uses the pinned word for it`, () => {
        const wrong: string[] = [];
        for (const term of RECORD_TERMS) {
          for (const key of tabKeys) {
            if (typeof en[key] !== 'string' || !term.en.test(prose(en[key]!))) continue;
            const got = others[loc][key] ?? '';
            if (!stemFor(term, en[key]!, loc).test(got) || term.wrong[loc]?.test(got)) wrong.push(`${key} = ${JSON.stringify(got)}  (en ${JSON.stringify(en[key])}; ${term.kind})`);
          }
        }
        expect(wrong, `${loc}: ${wrong.length} tab or menu names use another word than the sentences do:\n  ${wrong.join('\n  ')}`).toEqual([]);
      });
    }
  });

  // The gate is its patterns. A pattern that has never seen a wrong value is a claim, so each is shown one, and what it must leave alone.
  it('the patterns accept the pinned word, refuse the known wrong one, and read prose rather than code', () => {
    const term = (kind: string): RecordTerm => RECORD_TERMS.find(t => t.kind === kind)!;
    expect(term('file').stem.pl.test('Pliki')).toBe(true);
    expect(term('file').wrong.pl!.test('Akta')).toBe(true);
    expect(term('file').wrong.pl!.test('Pliki aktualne')).toBe(false);
    expect(term('fact').stem.de.test('Fakten')).toBe(true);
    expect(term('fact').wrong.de!.test('Erinnerungen')).toBe(true);
    expect(term('edge').stem.pl.test('Krawędzie')).toBe(true);
    expect(term('edge').stem.pl.test('Krawędzi')).toBe(true);
    expect(term('space').wrong.de!.test('Räume')).toBe(true);
    expect(term('space').wrong.de!.test('Space-Einstellungen')).toBe(false);
    expect(term('space').stem.pl.test('Przestrzeń')).toBe(true);
    expect(term('entity').stem.pl.test('Podmiotów')).toBe(true);
    expect(term('entity').wrong.pl!.test('Encje')).toBe(true);
    expect(term('chrono').stem.de.test('Chrono-Einträge')).toBe(true);

    expect(term('entity').en.test(prose('{"kind":"entity","record":{"name":"Ada"}}'))).toBe(false);
    expect(term('entity').en.test(prose('regex for entity.name'))).toBe(false);
    expect(term('chrono').en.test(prose('keys entity/edge/fact/chrono'))).toBe(false);
    expect(term('space').en.test(prose('{{space}} is now in the network'))).toBe(false);
    expect(term('space').en.test(prose('Create a space'))).toBe(true);
    expect(isBareLabel('Chrono ({{count}})', 'chrono')).toBe(true);
    expect(isBareLabel('Search chrono…', 'chrono')).toBe(false);
    expect(stemFor(term('chrono'), 'Chrono', 'de').test('Chrono')).toBe(true);
    expect(stemFor(term('chrono'), 'Also return chrono entries', 'de').test('Chrono')).toBe(false);
  });
});
