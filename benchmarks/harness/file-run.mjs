/**
 * A graded run as a directory of files: inputs, answers, judge batches, verdicts (`B-6`).
 *
 * ## Why a directory rather than a loop
 *
 * Owner, 2026-09-23: this assistant is the answerer and a GPT model, driven by hand in another vendor's chat,
 * is the judge — two hosted families, which is the `B-2` rule, and no provider keys. Neither side is a
 * function the harness can call, so every hand-over is a FILE. `run.mjs` is the same run as one loop over
 * injected functions; this is the shape for when the functions are people and chat windows.
 *
 * ## What it is built against, in the owner's words
 *
 * *"can you do it so we dont get rate limited or at least dont loose all the work if we do?"* A rate limit
 * has killed an extraction round here twice. So:
 *
 *  - **every unit of work is its own file** — one per conversation per arm, one per judge batch — and a limit
 *    costs the file in progress and nothing before it;
 *  - **every write is atomic**, a temporary file renamed into place, so a kill mid-write leaves nothing that
 *    reads as done;
 *  - **status is read off the directory**, and an answer file is only "done" when it answers every question
 *    in the input it was MADE FROM — a re-prepared input invalidates the answers built on the old one.
 *
 * ## The key never enters the run directory
 *
 * The answerer reads `input/`. Nothing here writes a reference answer, a category or the evidence into any
 * file under this directory except the judge's own batches — scoring and export re-derive them from the
 * loader. A key that is not on disk beside the inputs cannot be read by whoever is answering them.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { wholeHistory } from './arms.mjs';
import { VERDICTS } from './grade.mjs';

/** LoCoMo categories 1–4. Category 5 is the adversarial set published figures leave out. */
export const SCORED_CATEGORIES = Object.freeze([1, 2, 3, 4]);
export const ARMS = Object.freeze(['memory', 'baseline']);

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Write a file so that it either exists whole or not at all. */
function atomicWrite(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const inputPath = (runDir, conv, arm) => join(runDir, 'input', `${conv}.${arm}.json`);
const answerPath = (runDir, conv, arm) => join(runDir, 'answers', `${conv}.${arm}.json`);

/**
 * The scored questions of one conversation, with ids that are their RELEASE positions.
 *
 * Positions rather than a running count, so filtering out category 5 cannot renumber anything: `conv-26#7`
 * means the seventh row of that conversation's `qa` in the pinned release, today and in a year.
 */
export function scoredQuestions(questions, conversationId) {
  return questions
    .filter(q => q.conversationId === conversationId)
    .map((q, position) => ({ ...q, id: `${conversationId}#${position}` }))
    .filter(q => SCORED_CATEGORIES.includes(q.category));
}

/** Has this conversation's input already been written? The resume check, exported for the CLI. */
export function isPrepared(runDir, conversationId) {
  return ARMS.every(arm => existsSync(inputPath(runDir, conversationId, arm)));
}

/**
 * Write both arms' inputs for one conversation — question text and context, and nothing else.
 *
 * @param {object} args
 * @param {Function} args.hitsFor  question text → the memory arm's retrieval hits
 * @param {object}   args.retrieval  `{ topK, traverse }`, recorded so the memory arm can be reproduced
 */
export function prepareConversation({ runDir, conversation, questions, hitsFor, retrieval }) {
  const scored = scoredQuestions(questions, conversation.id);
  const ids = scored.map(q => q.id);
  if (isPrepared(runDir, conversation.id)) return { skipped: true, ids };

  mkdirSync(join(runDir, 'input'), { recursive: true });
  /*
   * FIELD BY FIELD, never a spread of the loader's row — the row carries `answer`, `adversarialAnswer`,
   * `evidence` and `category`, and a spread is how the key would reach the answerer in a file that looks
   * exactly like this one.
   */
  const memory = {
    conversationId: conversation.id, arm: 'memory', retrieval,
    questions: scored.map(q => ({ id: q.id, question: q.question, context: hitsFor(q.question) })),
  };
  const baseline = {
    conversationId: conversation.id, arm: 'baseline', context: wholeHistory(conversation),
    questions: scored.map(q => ({ id: q.id, question: q.question })),
  };
  atomicWrite(inputPath(runDir, conversation.id, 'memory'), JSON.stringify(memory, null, 2));
  atomicWrite(inputPath(runDir, conversation.id, 'baseline'), JSON.stringify(baseline, null, 2));
  return { skipped: false, ids };
}

/** Record one arm's answers for one conversation, stamped with the input they answer. */
export function writeAnswers(runDir, conversationId, arm, answers, answeredBy = null) {
  const input = readFileSync(inputPath(runDir, conversationId, arm), 'utf8');
  mkdirSync(join(runDir, 'answers'), { recursive: true });
  atomicWrite(answerPath(runDir, conversationId, arm), JSON.stringify({
    conversationId, arm, inputSha256: sha256(input), answeredBy, answers,
  }, null, 2));
}

/** What is wrong with one answer file, or `null` when it is complete for the input on disk. */
function answerProblem(runDir, conversationId, arm) {
  const ap = answerPath(runDir, conversationId, arm);
  if (!existsSync(ap)) return 'missing';
  const input = readFileSync(inputPath(runDir, conversationId, arm), 'utf8');
  const file = JSON.parse(readFileSync(ap, 'utf8'));
  if (file.inputSha256 !== sha256(input)) {
    return 'made from a different input than the one on disk — re-answer it';
  }
  const wanted = JSON.parse(input).questions.map(q => q.id);
  const absent = wanted.filter(id => typeof file.answers?.[id] !== 'string' || !file.answers[id].trim());
  if (absent.length > 0) return `incomplete: missing ${absent.slice(0, 5).join(', ')}${absent.length > 5 ? ` and ${absent.length - 5} more` : ''}`;
  return null;
}

/** Per conversation per arm: `missing`, `done`, or what is wrong with the file that is there. */
export function answerStatus(runDir, conversationIds) {
  const out = {};
  for (const c of conversationIds) {
    out[c] = {};
    for (const arm of ARMS) {
      if (!existsSync(inputPath(runDir, c, arm))) { out[c][arm] = 'not prepared'; continue; }
      out[c][arm] = answerProblem(runDir, c, arm) ?? 'done';
    }
  }
  return out;
}

/** One arm's answers, or a throw naming exactly why they cannot be used. */
export function readAnswers(runDir, conversationId, arm) {
  const problem = answerProblem(runDir, conversationId, arm);
  if (problem) throw new Error(`${conversationId} ${arm} answers: ${problem}`);
  return JSON.parse(readFileSync(answerPath(runDir, conversationId, arm), 'utf8')).answers;
}

/**
 * A balanced, reproducible sample: `perCategory` questions from each scored category.
 *
 * Ordered by a hash of seed and id rather than by `Math.random`, so the same seed picks the same questions
 * on any machine — the sample is part of what the figure means, and a figure over a sample nobody can
 * regenerate is not checkable.
 */
export function sampleForJudge(pool, { perCategory, seed }) {
  const rank = (id) => sha256(`${seed}|${id}`);
  const out = [];
  for (const c of SCORED_CATEGORIES) {
    out.push(...pool.filter(q => q.category === c)
      .sort((a, b) => (rank(a.id) < rank(b.id) ? -1 : 1))
      .slice(0, perCategory));
  }
  return out;
}

/** The reference the judge compares against — the same cut the F1 score makes. */
const judgedReference = (q) => (q.category === 3 ? String(q.answer).split(';')[0].trim() : String(q.answer));

/**
 * The judge's prompt: the instructions once, in their own file, so each batch carries items only.
 *
 * The wording is `grade.mjs`'s judge prompt, the rule the in-process runner already applies, restated for a
 * batch — one sentence per item would multiply the upload by two hundred for nothing.
 */
export const JUDGE_PROMPT = [
  'You are grading answers to questions about a long conversation between two people.',
  '',
  'The attached file holds items. Each item has an id (J followed by four digits), a QUESTION, a REFERENCE',
  'answer that is the ground truth, and an ANSWER to grade.',
  '',
  'For each item, decide whether the ANSWER is correct for the QUESTION, using the REFERENCE as ground truth.',
  'An answer is correct when it states the same fact as the reference, even in different words, or with',
  'extra detail that does not contradict it. A date is correct if it names the same day, month or year the',
  'reference names, whatever the format. An answer is incorrect when it states something else, omits the',
  'fact the question asks for, or says it does not know.',
  '',
  'Do not search the web and do not use any other source. Judge each item on its own three fields only.',
  '',
  `Reply with one line per item and nothing else: the id, a space, and exactly one word, ${VERDICTS.join(' or ')}.`,
  'Grade every item in the file, in order. Example:',
  'J0001 correct',
  'J0002 incorrect',
].join('\n');

/**
 * Write the judge's prompt and its batches for a sample of scored questions, both arms.
 *
 * **The judge must not be able to tell which arm an answer came from.** Ids are opaque (`J0001`), the arm is
 * recorded only in `judge/key.json`, which is never uploaded, and the two arms of one question are shuffled
 * apart so that neighbours do not give the pairing away.
 */
export function exportJudgeBatches({
  runDir, conversations, questions, perCategory = 50, batchSize = 200, seed = 'tier0',
}) {
  const pool = conversations.flatMap(c => scoredQuestions(questions, c));
  const sample = sampleForJudge(pool, { perCategory, seed });

  const answersOf = new Map();
  const items = [];
  for (const q of sample) {
    for (const arm of ARMS) {
      const key = `${q.conversationId}.${arm}`;
      if (!answersOf.has(key)) answersOf.set(key, readAnswers(runDir, q.conversationId, arm));
      items.push({ id: q.id, arm, question: q.question, reference: judgedReference(q), answer: answersOf.get(key)[q.id] });
    }
  }
  items.sort((a, b) => (sha256(`${seed}|${a.id}|${a.arm}`) < sha256(`${seed}|${b.id}|${b.arm}`) ? -1 : 1));

  mkdirSync(join(runDir, 'judge'), { recursive: true });
  const key = {};
  const batches = [];
  for (let start = 0, n = 1; start < items.length; start += batchSize, n++) {
    const chunk = items.slice(start, start + batchSize);
    const blocks = chunk.map((it, i) => {
      const jid = `J${String(start + i + 1).padStart(4, '0')}`;
      key[jid] = { id: it.id, arm: it.arm, batch: n };
      const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
      return `${jid}\nQUESTION: ${flat(it.question)}\nREFERENCE: ${flat(it.reference)}\nANSWER: ${flat(it.answer)}\n`;
    });
    const path = join(runDir, 'judge', `batch-${n}.txt`);
    atomicWrite(path, blocks.join('\n'));
    batches.push(path);
  }
  atomicWrite(join(runDir, 'judge', 'key.json'), JSON.stringify(key, null, 2));
  atomicWrite(join(runDir, 'judge', 'prompt.md'), `${JUDGE_PROMPT}\n`);
  return { batches, items: items.length, prompt: join(runDir, 'judge', 'prompt.md') };
}

const readKey = (runDir) => JSON.parse(readFileSync(join(runDir, 'judge', 'key.json'), 'utf8'));

/**
 * Read the judge's reply for one batch, as pasted — chat prose and markdown included.
 *
 * A line counts only when it carries a batch id AND one of the two verdict words. Anything else about an id
 * is refused for that id, and an id the reply never mentions stays UNGRADED: a reply cut off at item 140 is
 * sixty questions that were not judged, which is not the same as sixty that were judged wrong.
 */
export function importJudgeReply(runDir, batch, text) {
  const key = readKey(runDir);
  const inBatch = Object.keys(key).filter(j => key[j].batch === batch);
  if (inBatch.length === 0) throw new Error(`there is no judge batch ${batch}`);
  const verdicts = {};
  const invalid = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/\b(J\d{4})\b[^A-Za-z0-9]*([A-Za-z]+)/);
    if (!m) continue;
    const [, jid, rawWord] = m;
    const word = rawWord.toLowerCase();
    if (!inBatch.includes(jid)) { invalid.push(`${jid}: not in batch ${batch}`); continue; }
    if (!VERDICTS.includes(word)) { invalid.push(`${jid}: '${rawWord}' is not ${VERDICTS.join(' or ')}`); continue; }
    if (jid in verdicts) { invalid.push(`${jid}: graded twice`); continue; }
    verdicts[jid] = word;
  }
  const missing = inBatch.filter(j => !(j in verdicts));
  mkdirSync(join(runDir, 'verdicts'), { recursive: true });
  atomicWrite(join(runDir, 'verdicts', `batch-${batch}.json`), JSON.stringify({ batch, verdicts, missing, invalid }, null, 2));
  return { graded: Object.keys(verdicts).length, missing, invalid };
}

/** Per batch: done, partial or missing — and how many items across the run still have no verdict. */
export function judgeStatus(runDir) {
  const key = readKey(runDir);
  const nums = [...new Set(Object.values(key).map(k => k.batch))].sort((a, b) => a - b);
  let ungraded = 0;
  const batches = nums.map(batch => {
    const of = Object.values(key).filter(k => k.batch === batch).length;
    const p = join(runDir, 'verdicts', `batch-${batch}.json`);
    const graded = existsSync(p) ? Object.keys(JSON.parse(readFileSync(p, 'utf8')).verdicts).length : 0;
    ungraded += of - graded;
    return { batch, of, graded, state: graded === 0 ? 'missing' : graded === of ? 'done' : 'partial' };
  });
  return { batches, ungraded };
}

/** Every verdict imported so far, keyed back to question id and arm. */
export function readVerdicts(runDir) {
  const key = readKey(runDir);
  const dir = join(runDir, 'verdicts');
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
    const { verdicts } = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    for (const [jid, word] of Object.entries(verdicts)) out.push({ ...key[jid], verdict: word });
  }
  return out;
}
