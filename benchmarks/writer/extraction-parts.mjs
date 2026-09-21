/**
 * Where a half-written extraction waits for the session that finishes it.
 *
 * ## Why parts have to survive a session, and it has cost three rounds
 *
 * A conversation is extracted in parts of about ten sessions, and the parts used to live in a per-session
 * scratch directory. That directory is wiped between sessions — which is precisely when the parts are
 * needed. A round killed by a rate limit therefore lost everything it had written, and the next session
 * began at part 1 of conversation 1.
 *
 * Measured twice on 2026-09-20: ten extractors launched together exhausted the window in about twenty
 * minutes and produced **nothing**, every one dying between reading its conversation and writing its file.
 * The same wall-clock in batches of three produced three finished conversations.
 *
 * So parts go in `benchmarks/.cache/`, which is gitignored and already holds the pinned corpus: the place
 * this repo already keeps a thing that must survive and must not be committed.
 *
 * ## The guard that makes resuming safe, and the reason this is a module rather than a `readdirSync`
 *
 * **Parts that survive a session survive a PROMPT CHANGE.** A directory of last week's parts is internally
 * perfect — consistent indices, matching `of`, the right conversation — and merging them with parts written
 * today produces one file describing one conversation under two sets of rules. Nothing downstream can see
 * it: `bench.mjs merge` stamps the working tree's fingerprint on whatever it is given, so the spliced file
 * comes out claiming a single prompt.
 *
 * That is `B-15`'s defect one level down, and `B-15` exists because the corpus-level version of it happened
 * twice in one day. So a part records the prompt it was written under and a resume REFUSES a set that
 * disagrees with the prompt being run now. A checkpoint that can silently splice two rounds is worth less
 * than no checkpoint.
 *
 * Every other refusal here is the same shape: absence must never read as agreement. A part with no
 * provenance is refused rather than assumed current, and a part that will not parse is refused rather than
 * skipped — a truncated file is exactly what a killed process leaves behind, and skipping it would restart
 * that part while the broken file sat beside the good ones waiting to break the merge instead.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { EOL as nl } from 'node:os';
import { join } from 'node:path';

/** Gitignored, and beside the pinned corpus rather than in a session's scratch. See the note above. */
export const PARTS_ROOT = join('benchmarks', '.cache', 'extraction-parts');

/** Where one conversation's parts wait. */
export function partsDir(conversationId) {
  return join(PARTS_ROOT, conversationId);
}

/** `part3.json` → 3, and anything else → null, so a stray file cannot be read as a part. */
function indexOfFile(name) {
  const m = /^part(\d+)\.json$/.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * What is already written for this conversation, and which part to write next.
 *
 * @param {string} conversationId
 * @param {string} promptSha256  the fingerprint of the prompt being run NOW. Every part must name it.
 * @returns {{done: number[], of: number|null, next: number|null, complete: boolean}}
 * @throws when the parts on disk cannot safely be continued — see the note at the top of this file
 */
export function resumePoint(conversationId, promptSha256) {
  const dir = partsDir(conversationId);
  if (!existsSync(dir)) return { done: [], of: null, next: 1, complete: false };

  const found = new Map();
  let of = null;
  for (const name of readdirSync(dir).sort()) {
    const index = indexOfFile(name);
    if (index === null) continue;
    let part;
    try {
      part = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      throw new Error(`${name} is unreadable as JSON. A killed process leaves a truncated part behind, and `
        + 'skipping it would restart that part while the broken file waited to break the merge instead. '
        + `Delete it and let the resume rewrite it: ${join(dir, name)}`);
    }
    if (part.conversationId !== conversationId) {
      throw new Error(`${name} says conversationId '${part.conversationId}', but it is filed under `
        + `'${conversationId}'. These are parts of different conversations.`);
    }
    /*
     * THREE ANSWERS, NOT TWO, and the third is the one that actually happened.
     *
     * A value that is not a sha256 at all is MALFORMED — somebody transcribed the short form a status line
     * prints — and it is not the same finding as a part written under a different prompt. The first message
     * here said "written under prompt X and the prompt now is X", because it abbreviated both sides to
     * twelve characters and a twelve-character value abbreviates to itself. A refusal a reader cannot act
     * on is worse than the bug it reports: it reads as the check being broken.
     */
    const sha = part.producedBy?.promptSha256;
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) {
      throw new Error(`${name} records promptSha256 ${sha === undefined ? '(nothing)' : `'${sha}'`}, which is `
        + 'not a sha256. It is the full 64-character digest that goes on a part, never the short form a '
        + `status line prints. The prompt now is ${promptSha256}.`);
    }
    if (sha !== promptSha256) {
      throw new Error(`${name} was written under a DIFFERENT prompt.${nl}  part:   ${sha}${nl}`
        + `  now:    ${promptSha256}${nl}`
        + 'Resuming would merge one conversation from two sets of rules into a file that claims a single '
        + `prompt, which is the one thing nothing downstream can see. Delete ${dir} and extract it again.`);
    }
    if (of === null) of = part.part?.of ?? null;
    else if (part.part?.of !== of) {
      throw new Error(`${name} says there are ${part.part?.of} parts where an earlier one says of ${of}. `
        + 'Two runs of the same conversation left files in one directory.');
    }
    found.set(index, true);
  }

  const done = [...found.keys()].sort((a, b) => a - b);
  if (of === null) return { done, of: null, next: 1, complete: false };
  // The first MISSING index, never `max + 1`: a death between two writes can leave a hole, and continuing
  // past it produces a merge that refuses for a missing part with nothing to say which.
  let next = null;
  for (let i = 1; i <= of; i++) if (!found.has(i)) { next = i; break; }
  return { done, of, next, complete: next === null };
}
