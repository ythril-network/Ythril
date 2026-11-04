/**
 * The one way a script prints a GitHub Actions workflow command (`::warning title=…::…`) (Q-710).
 *
 * ## What it prevents
 *
 * The runner reads every line a step prints that starts with `::` as a command. A message carrying a newline (an API error, a
 * stack) would end the annotation early and could start a SECOND command from text the script did not write; a `%` would be read
 * as the start of an escape. Escaping was spelled twice (one copy blanked `%` and CR, the other escaped them), and a third caller
 * would pick one or neither. Here the message and the title are escaped as the runner defines it, so every caller gets the same.
 *
 * Node built-ins only (none, in fact): scripts run by a CI job that installs nothing import it.
 */

/** The levels the runner shows as an annotation. */
const LEVELS = new Set(['notice', 'warning', 'error']);

/** A command's message: `%`, CR and LF escaped, so it is one line and starts nothing. */
const escapeData = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** A command property (the title): the message's escapes plus `:` and `,`, which end a property. */
const escapeProperty = (text) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

/**
 * The workflow command line for one annotation. Throws on a level the runner does not know: a misspelt level prints a line the
 * runner ignores, and the warning it was meant to raise is lost without a sign.
 *
 * @param {'notice'|'warning'|'error'} level
 * @param {string} title
 * @param {unknown} message
 * @returns {string}
 */
export function workflowCommand(level, title, message) {
  if (!LEVELS.has(level)) throw new Error(`workflow command level ${JSON.stringify(level)} is not one of ${[...LEVELS].join(', ')}`);
  return `::${level} title=${escapeProperty(title)}::${escapeData(message)}`;
}
