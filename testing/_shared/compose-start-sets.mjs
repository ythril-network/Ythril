/**
 * Which services ONE `docker compose up` starts together — the set a resource budget has to be taken over.
 *
 * ## What this prevents
 *
 * `the-test-stack-leaves-the-machine-room` used to sum the default ceilings of EVERY service in the test compose
 * file. That is a sum over what no single `up` starts: the opt-in `office` profile's doc-office is not part of
 * `docker compose up`, and no CI job starts all four instances plus both sidecars. The sum had no headroom, so the
 * implementer who had to fit doc-office cut the sidecars' defaults below what a PDF renderer and LibreOffice need —
 * the budget rule "fixed" by making the stack unable to do its job. The rule is about what runs TOGETHER, so the
 * sets it is taken over are the ones a command actually starts.
 *
 * ## The sets, and where each comes from
 *
 * - **the default set** — `docker compose up` with nothing named: every service with no `profiles:` key. This is
 *   what a developer's `npm run test:up` starts.
 * - **one set per CI job that runs `docker compose … up`** — derived from the PARSED workflow, never from its
 *   text: the services named on its `up` commands, plus every service of each `--profile` (or `COMPOSE_PROFILES`)
 *   it passes, plus the `depends_on` closure of all of those. A job whose `up` names no service starts the default
 *   set plus its profiles. Several `up` commands in one job accumulate: they share one runner. (Compose itself
 *   starts only the named services; counting the profile's too only over-counts.)
 *
 * ## Refusals instead of guesses
 *
 * A command whose services cannot be read (`up $SERVICES`) or name a service the compose file lacks throws. An empty
 * or shortened set would pass every budget written over it, which is the quiet failure this module exists to stop.
 * Only `docker compose … up` is read; `config --images`, `build`, `down` and the rest start nothing.
 *
 * One question per module: which services start together. It holds no budget — each gate states its own rule over
 * the sets, so a rule and the derivation of its subjects never share a reason to change.
 */
import { jobEntries, shellOf, stepsOf, shellCommands } from './ci-workflow.mjs';

/** `docker compose` global options that take a value as the NEXT word (`--opt=value` carries its own). */
const GLOBAL_OPTS_WITH_VALUE = new Set(['-p', '--project-name', '-f', '--file', '--profile', '--env-file', '--project-directory', '--ansi', '--progress', '--parallel']);
/** `up` options that take a value as the next word. */
const UP_OPTS_WITH_VALUE = new Set(['--wait-timeout', '-t', '--timeout', '--scale', '--exit-code-from', '--pull', '--attach', '--no-attach']);

const unquote = (w) => w.replace(/^(['"])(.*)\1$/, '$2');

/**
 * Every `docker compose … up` in a shell script, as `{ part, profiles, after }`: the command's text, the profiles
 * its global options switch on, and the words after `up`. The ONE reading of "is this command a compose up" —
 * `startsComposeStack` and `upCommands` both answer from it, so a detector of "a job starts the stack" cannot be a
 * looser regex that disagrees with the reader of what the start names (`config --images | grep up` is not a start).
 */
function composeUps(script) {
  const out = [];
  for (const part of shellCommands(script)) {
    const words = part.split(/\s+/).filter(Boolean).map(unquote);
    const at = words.findIndex((w, i) => (w === 'docker' && words[i + 1] === 'compose') || w === 'docker-compose');
    if (at < 0) continue;
    let i = at + (words[at] === 'docker' ? 2 : 1);
    const profiles = [];
    for (; i < words.length && words[i].startsWith('-'); i++) {
      const [flag, inline] = words[i].split(/=(.*)/s);
      const takes = GLOBAL_OPTS_WITH_VALUE.has(flag);
      const value = inline ?? (takes ? words[++i] : undefined);
      if (flag === '--profile') profiles.push(value);
    }
    if (words[i] === 'up') out.push({ part, profiles, after: words.slice(i + 1) });
  }
  return out;
}

/** Does this shell script run `docker compose … up`? Answers whether a start exists without having to read what it names. */
export const startsComposeStack = (script) => composeUps(script).length > 0;

/**
 * Every `docker compose … up` in a shell script, as `{ profiles, services }`. `services` is empty when the command
 * names none (it then starts everything its profiles enable).
 */
export function upCommands(script) {
  return composeUps(script).map(({ part, profiles, after }) => {
    const services = [];
    for (let i = 0; i < after.length; i++) {
      const w = after[i];
      if (w.startsWith('-')) {
        const [flag, inline] = w.split(/=(.*)/s);
        if (inline === undefined && UP_OPTS_WITH_VALUE.has(flag)) i++;
        continue;
      }
      if (/^(?:\d*|&)[<>]/.test(w)) continue; // a redirection (`2>&1`, `>log`), not a service
      if (/[$`]/.test(w)) throw new Error(`cannot read which service \`${w}\` names in: ${part}`);
      services.push(w);
    }
    return { profiles, services };
  });
}

/**
 * The jobs of a workflow that start a compose stack, `[{ id, name, job }]` — a local composite action's `up` counts.
 * `opts.root` is the repository a local action is looked up in (default: this one), as for `shellOf`.
 */
export const stackJobs = (workflow, opts) => jobEntries(workflow).filter(({ job }) => stepsOf(job).some((s) => startsComposeStack(shellOf(s, opts))));

const asList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v) : []);

/** The services in `names`, plus everything they `depends_on`, transitively. */
export function dependencyClosure(compose, names) {
  const seen = new Set();
  const visit = (n) => {
    if (seen.has(n)) return;
    if (!compose.services?.[n]) throw new Error(`a start set names ${n}, which the compose file does not define`);
    seen.add(n);
    asList(compose.services[n].depends_on).forEach(visit);
  };
  names.forEach(visit);
  return seen;
}

const profilesOf = (svc) => asList(svc.profiles);

/** `COMPOSE_PROFILES` from a workflow, job or step `env:` map — the other way to switch a profile on. */
const envProfiles = (...envs) => envs.flatMap((e) => String(e?.COMPOSE_PROFILES ?? '').split(',').map((s) => s.trim()).filter(Boolean));

/** Every service of a compose file that no profile gates. */
export function defaultServices(compose) {
  return Object.keys(compose.services ?? {}).filter((n) => profilesOf(compose.services[n]).length === 0);
}

/**
 * Every set of services one command in this repo starts together, as `[{ label, services: string[] }]`
 * (sorted names). `compose` is the parsed test compose file, `workflow` the parsed `ci.yml`, `opts.root` the repository
 * its local composite actions are read from (default: this one).
 */
export function startSets(compose, workflow, opts) {
  const all = Object.keys(compose.services ?? {});
  const inProfiles = (profiles) => all.filter((n) => profilesOf(compose.services[n]).some((p) => profiles.includes(p)));
  const sets = [{ label: 'the default set (`docker compose up`)', services: [...dependencyClosure(compose, defaultServices(compose))].sort() }];
  for (const { id, job } of stackJobs(workflow, opts)) {
    const started = new Set();
    for (const step of stepsOf(job)) {
      for (const up of upCommands(shellOf(step, opts))) {
        const profiles = [...up.profiles, ...envProfiles(workflow.env, job.env, step.env)];
        // Compose starts only the named services when it is given any, so counting a profile's services as well is
        // the conservative reading: a budget that holds for it holds for the exact one.
        const named = [...(up.services.length > 0 ? up.services : defaultServices(compose)), ...inProfiles(profiles)];
        dependencyClosure(compose, named).forEach((n) => started.add(n));
      }
    }
    sets.push({ label: `CI job ${id}`, services: [...started].sort() });
  }
  return sets;
}
