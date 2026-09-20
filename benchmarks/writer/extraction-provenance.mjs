/**
 * How was this extraction produced, and was the whole corpus produced the same way?
 *
 * ## Two failures, both of which happened rather than being imagined
 *
 * **A file tuned against a scoreboard, indistinguishable from the ones that were not.** `conv-26` sat in the
 * extractions directory looking exactly like its neighbours. It had been written by hand while its author
 * watched the retrieval scores — the prompt changed, the numbers were read, the prompt changed again — which
 * is legitimate development and illegitimate evidence. Nothing in the file, the directory or any gate said
 * so. What caught it was somebody remembering, and the stopgap was a paragraph in `bench.mjs status` naming
 * that one conversation, which expired the moment its replacement landed.
 *
 * **A corpus made by two prompts**, twice in one day. A session rate limit killed a re-extraction round
 * halfway through; later, two conversations were redone under a clarified rule while eight were not. Each
 * time the hazard is identical — every per-conversation difference afterwards is unattributable — and each
 * time **nothing anywhere could see it**, because the files are individually perfect either way.
 *
 * ## Why a hash of the prompt rather than a version
 *
 * A version somebody types is a claim about the prompt. A hash of its bytes IS the prompt, and it cannot
 * survive an edit. The corresponding rule for the flag is the asymmetry in `provenanceProblems`: a missing
 * `unattended` is refused rather than read as `true`, because **the run that would misreport is the run that
 * leaves it out**. An honest `false` is a legitimate answer and records something real.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The prompt's own fingerprint.
 *
 * @param {string|null} path the prompt file, or null when passing `source` directly (tests)
 * @param {string} [source] the prompt text, when there is no file to read
 *
 * It throws on a missing file rather than hashing an empty string. That is the guard a hand-written copy
 * drops, and it is the worst possible failure here: every run would carry the digest of `''`, identical and
 * plausible, and the field would look like it was working while recording nothing.
 */
export function promptFingerprint(path, source) {
  let text = source;
  if (text === undefined) {
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(`cannot fingerprint the prompt at '${path}': ${err.message}. Hashing nothing would `
        + 'give every extraction the same fingerprint, which is worse than having no field at all.');
    }
  }
  /*
   * NEWLINES ARE NORMALISED FIRST, and this is the part a hand-written copy drops.
   *
   * This repo is checked out with CRLF on Windows and LF in CI, so hashing the bytes as they sit on disk
   * fingerprints the CHECKOUT rather than the prompt: the same prompt would produce two digests, a corpus
   * extracted on a developer machine would look like a corpus made by two prompts, and the one check this
   * module exists to perform would fire permanently on nothing. A permanent false alarm teaches a reader to
   * ignore the signal that means something real.
   */
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * What is wrong with one extraction's provenance block, or nothing.
 *
 * @returns {string[]}
 */
export function provenanceProblems(extraction) {
  const p = extraction?.producedBy;
  if (!p || typeof p !== 'object') {
    return ['there is no `producedBy` block, so nothing records which prompt made this file or whether a '
      + 'retrieval score was visible while it was written. Both have gone wrong here before and neither '
      + 'leaves any other trace.'];
  }
  const problems = [];
  if (!SHA256.test(String(p.promptSha256 ?? ''))) {
    problems.push(`producedBy.promptSha256 is '${p.promptSha256}', which is not a lowercase sha256 hex `
      + 'digest. It is the hash of the prompt file\'s bytes, not a version number — a version stays put '
      + 'through an edit and the whole point is that this cannot.');
  }
  /*
   * Absent is REFUSED; `false` is accepted and is a real answer. Reading absence as `true` would make the
   * field a formality: the run that would misreport is exactly the run that omits it.
   */
  if (typeof p.unattended !== 'boolean') {
    problems.push('producedBy.unattended must be true or false. Leaving it out is not the same as saying '
      + 'yes — an extraction written while a retrieval score was visible is legitimate development and '
      + 'illegitimate evidence, and it has to be possible to tell which this is.');
  }
  return problems;
}

/**
 * Was the whole corpus produced the same way?
 *
 * This is the question nothing could ask before, and the one that matters for any number taken off the
 * corpus: a delta between conversations extracted by two different prompts measures the prompts.
 *
 * @returns {{onePrompt: boolean, prompts: {sha: string, conversations: string[]}[], attended: string[]}}
 */
export function corpusProvenance(extractions) {
  if (!Array.isArray(extractions) || extractions.length === 0) {
    /*
     * "Every file names the same prompt" is vacuously true of no files, which is precisely the reading that
     * turns a broken directory read into a clean bill of health.
     */
    throw new Error('no extractions to check — agreement across an empty corpus is not agreement');
  }
  const byPrompt = new Map();
  const attended = [];
  for (const x of extractions) {
    const id = x.conversationId;
    const sha = x.producedBy?.promptSha256 ?? '(none)';
    if (!byPrompt.has(sha)) byPrompt.set(sha, []);
    byPrompt.get(sha).push(id);
    if (x.producedBy?.unattended !== true) attended.push(id);
  }
  const prompts = [...byPrompt.entries()].map(([sha, conversations]) => ({ sha, conversations }));
  return { onePrompt: prompts.length === 1, prompts, attended };
}
