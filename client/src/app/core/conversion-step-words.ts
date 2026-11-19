import type { KeyTranslator } from './translated-text';
import type { ConversionStep } from './conversion.types';

/**
 * The words of a conversion step, and of a step the run refused (bundle-285, Q-747, plan sections 5 D8 and 8).
 *
 * ## What it prevents
 *
 * A step names things a PEER wrote: a vote carries it, and any member of a network may have named a type `<img src=x onerror=...>`. So a
 * sentence is made from a translation key out of a CLOSED set ({@link CONVERSION_STEP_KEYS}) and the names go in as parameters, which the
 * translation layer fills in as text; nothing here concatenates a name into a key, joins it into markup, or asks the language for a key the
 * name chose. The same holds for a refusal's code: a code that is not on {@link STEP_REFUSAL_CODES} is asked as the generic sentence with the
 * code as a parameter, never as `conversion.stepRefusal.<code>`; and the list is asked by membership, so `constructor` is not a code.
 *
 * The page binds the sentence as text (interpolation), never as HTML.
 */

/** Every translation key {@link stepSentence} asks for. The words themselves are in the locale files (`conversion.step.*`). */
export const CONVERSION_STEP_KEYS = [
  'conversion.step.renameType',
  'conversion.step.renameProperty',
  'conversion.step.mapEnum',
  'conversion.step.mapPair',
  'conversion.step.splitType',
  'conversion.step.splitTypeOpen',
  'conversion.step.splitCase',
] as const;

/** The separator between the pairs of a map and between the cases of a split: as the drawing writes them ("change a to b, c to d"). */
const PAIRS_SEPARATOR = ', ';
const CASES_SEPARATOR = '; ';

/**
 * One step as a sentence in the translator's active language, names interpolated as given. A split with no `otherwise` does not say where
 * the others go (the server leaves such a record unconverted), so it does not make a destination up.
 */
export function stepSentence(transloco: KeyTranslator, step: ConversionStep): string {
  const t = (key: (typeof CONVERSION_STEP_KEYS)[number], params: Record<string, string>): string => transloco.translate(key, params);
  switch (step.op) {
    case 'renameType':
      return t('conversion.step.renameType', { from: step.from, to: step.to });
    case 'renameProperty':
      return t('conversion.step.renameProperty', { from: step.from, to: step.to });
    case 'mapEnum': {
      const pairs = Object.entries(step.values).map(([from, to]) => t('conversion.step.mapPair', { from, to })).join(PAIRS_SEPARATOR);
      return t('conversion.step.mapEnum', { property: step.property, pairs });
    }
    case 'splitType': {
      const cases = step.cases.map(c => t('conversion.step.splitCase', { when: c.when, to: c.to })).join(CASES_SEPARATOR);
      return step.otherwise === undefined
        ? t('conversion.step.splitTypeOpen', { type: step.from, cases })
        : t('conversion.step.splitType', { type: step.from, cases, otherwise: step.otherwise });
    }
  }
}

/**
 * Every reason a run records for a step it does not apply: the codes of `ConversionIssueCode` (`schema/src/conversion-steps.ts`), the three a
 * round's check adds (`RoundConvertRefusal`, `sync/governance.ts`), and `replaced` (a later step on the same source took its place).
 * `testing/conversion-contract.spec.ts` compares this list with the server's, so a code added there fails here with its name.
 */
export const STEP_REFUSAL_CODES = [
  'malformed_step', 'too_many_steps', 'too_many_values', 'too_many_cases', 'no_cases', 'type_name_too_long', 'condition_too_long',
  'same_name', 'duplicate_property_rename', 'duplicate_enum_map', 'duplicate_type_step', 'type_not_reached',
  'property_not_declared_before', 'property_not_declared_after', 'property_still_declared',
  'enum_not_declared_before', 'enum_key_not_in_before', 'enum_not_declared_after', 'enum_value_not_in_after', 'value_equals_key',
  'type_not_declared_before', 'type_not_declared_after', 'condition_refused', 'conditions_over_budget',
  'steps_not_signed', 'step_target_not_in_round', 'property_still_declared_here',
  'replaced',
] as const;

/** The words of a refusal reason: a key and its parameters. A code off the list is the generic sentence, `{{code}}` the code as given. */
export function stepRefusalWords(code: string): { key: string; params: Record<string, string> } {
  return (STEP_REFUSAL_CODES as readonly string[]).includes(code)
    ? { key: `conversion.stepRefusal.${code}`, params: {} }
    : { key: 'conversion.stepRefusal.unknown', params: { code } };
}
