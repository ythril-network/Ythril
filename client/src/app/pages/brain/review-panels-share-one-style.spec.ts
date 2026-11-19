/**
 * The Review panels draw the segmented control and the card from one style (bundle-285 slice S9, Q-747; handover item 6).
 *
 * The Unconverted panel was built by copying the segmented control (`.sg`, `.sg-opt`, `.sg-n`) out of the Forks panel and the finding card
 * (`.dup-grid`, `.dup-card`, `.dup-rec`, ...) out of the Contradictions panel, so the same queue would not look like two products. A copy keeps
 * that promise only until one of the three is touched: a padding changed in one panel and not the others is two products again, and no spec of a
 * single panel sees it. The rules live once in `review-panel.styles.ts`; a panel lists them in its `styles` and keeps only what is its own (a
 * margin, its breakpoint, a rule for something only it draws).
 *
 * What this holds, at the source (the encapsulated styles of three heavy panels are not worth mounting for a rule that is text):
 *
 *  - The shared file defines the control and the card, each rule once, and in the theme's tokens (no colour of its own).
 *  - None of the three panels defines one of those rules itself, and each lists the shared style it draws with.
 *
 * Known fourth copy, not moved here: the Duplicates and Suggestions cards in `review-tab.component.ts` carry the card rules too (they are the
 * origin of the Contradictions copy). The handover bounds this item to the three panels.
 *
 * ## Seen red
 *
 * Red at the unchanged base: `./review-panel.styles` does not exist.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT } from '../../testing/tracked-sources';
import { REVIEW_CARD_STYLES, REVIEW_SEGMENTED_STYLES } from './review-panel.styles';

const BRAIN = resolve(CLIENT_ROOT, 'src/app/pages/brain');
const read = (file: string): string => readFileSync(resolve(BRAIN, file), 'utf8');

/** Which shared style each panel draws with. */
const PANELS: { file: string; uses: ('REVIEW_SEGMENTED_STYLES' | 'reviewSegmentedPhone' | 'REVIEW_CARD_STYLES')[] }[] = [
  { file: 'review-forks.component.ts', uses: ['REVIEW_SEGMENTED_STYLES', 'reviewSegmentedPhone'] },
  { file: 'review-contradictions-panel.component.ts', uses: ['REVIEW_CARD_STYLES'] },
  { file: 'review-unconverted-panel.component.ts', uses: ['REVIEW_SEGMENTED_STYLES', 'reviewSegmentedPhone', 'REVIEW_CARD_STYLES'] },
];

/**
 * The rules the panels share, one per line of the shared style: its selector and its declarations. A copy is found by the whole rule, as it was
 * copied (a panel may still OVERRIDE a rule of the shared style with other declarations, such as the grid's columns on a phone, and that is not a
 * copy).
 */
const SHARED_RULES = `${REVIEW_SEGMENTED_STYLES}\n${REVIEW_CARD_STYLES}`.split('\n')
  .map(line => /^\s*(\.[^{]+?)\s*\{([^}]*)\}\s*$/.exec(line))
  .filter((m): m is RegExpExecArray => m !== null)
  .map(m => ({ selector: m[1]!, text: m[0].trim() }));

describe('the Review panels share one segmented control and one card', () => {
  it('defines the control and the card in the shared file, each selector once (a floor, so a changed layout cannot pass by finding none)', () => {
    expect(SHARED_RULES.length).toBeGreaterThanOrEqual(15);
    const selectors = SHARED_RULES.map(r => r.selector);
    expect(selectors.filter((s, i) => selectors.indexOf(s) !== i), 'a selector defined twice').toEqual([]);
    expect(REVIEW_SEGMENTED_STYLES).not.toMatch(/\.dup-/);
    expect(REVIEW_CARD_STYLES).not.toMatch(/\.sg-/);
  });

  it('draws them in the theme\'s tokens: no colour of its own', () => {
    expect(`${REVIEW_SEGMENTED_STYLES}${REVIEW_CARD_STYLES}`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  for (const { file, uses } of PANELS) {
    it(`${file} defines none of the shared rules itself`, () => {
      const src = read(file);
      const own = SHARED_RULES.filter(rule => src.includes(rule.text)).map(rule => rule.selector);
      expect(own, `${file} carries its own copy of ${own.join(', ')}: move it to review-panel.styles.ts`).toEqual([]);
    });

    it(`${file} lists ${uses.join(' and ')} in its styles`, () => {
      const src = read(file);
      const stylesAt = src.indexOf('styles: [');
      expect(stylesAt, `${file} has a styles array`).toBeGreaterThan(-1);
      for (const name of uses) {
        expect(src, `${file} imports ${name} from ./review-panel.styles`).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from './review-panel.styles'`));
        expect(src.indexOf(name, stylesAt), `${file} lists ${name} in its styles array`).toBeGreaterThan(stylesAt);
      }
    });
  }
});
