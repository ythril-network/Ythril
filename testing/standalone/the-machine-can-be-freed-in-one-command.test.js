/**
 * `npm run machine:free` frees this machine's disk and memory in one command, and destroys nothing it should keep
 * (`Q-55`).
 *
 * Owner-requested 2026-09-24, so that a memory crash or a full Docker disk is one command rather than the right
 * sequence of four remembered steps. It was built and sat on a branch for a day with no tracker row, while the flow's
 * machine-trouble convention told the loop to run it.
 *
 * The part worth a gate is what it must NOT do. The default run removes the TEST stack and prunes only what no running
 * container needs; the whole data disk goes only with `-Wipe`.
 *
 * ## The owner's instance survives a wipe (`Q-294`, bundle-64)
 *
 * The owner's instance keeps its data in bind mounts under the checkout (`local-data/`, `config/`), so deleting the data
 * disk loses its images and containers but not its database — and nothing brought it back: the wipe recorded nothing and
 * `docker-compact.ps1` relied on a restart policy that a compose stop had already disarmed. `scripts/owner-instance.ps1`
 * records, stops and restores it; what this file holds is the ORDER the two scripts that take the engine away call it
 * in, because a save after the delete or a restore before the engine answers is the same lost instance, and both read
 * fine line by line. Positions are taken in the comment-stripped text, so a comment that names a function cannot stand
 * in for the call. The behaviour of the module itself is `the-owner-instance-comes-back-after-a-wipe.test.js`.
 *
 * Run: node --test testing/standalone/the-machine-can-be-freed-in-one-command.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const PKG = JSON.parse(readFileSync('package.json', 'utf8'));
const SCRIPT = 'scripts/machine-free.ps1';
const WIPE = 'scripts/docker-wipe.ps1';
const COMPACT = 'scripts/docker-compact.ps1';
const OWNER = 'scripts/owner-instance.ps1';
const DESKTOP = 'scripts/docker-desktop.ps1';
/** A script's text with its comment lines dropped: what it DOES, never what it says it does. */
const codeOf = (file) => readFileSync(file, 'utf8').split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
const code = () => codeOf(SCRIPT);
/** A script's header: the comment block it opens with. */
const headerOf = (file) => {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const end = lines.findIndex(l => !/^\s*#/.test(l));
  return lines.slice(0, end < 0 ? lines.length : end).map(l => l.replace(/^\s*#\s?/, '')).join(' ');
};
/** The position of the first match of `re` in `text` at or after `from`, or -1. */
const at = (text, re, from = 0) => { const m = re.exec(text.slice(from)); return m ? from + m.index : -1; };

describe('npm run machine:free', () => {
  it('is a script, and the file it runs exists', () => {
    assert.match(PKG.scripts?.['machine:free'] ?? '', /scripts\/machine-free\.ps1/, 'package.json has no machine:free');
    assert.ok(existsSync(SCRIPT), `${SCRIPT} is missing`);
  });

  it('removes the TEST stack and nothing else by name', () => {
    const downs = [...code().matchAll(/docker compose[^\n]*down[^\n]*/g)].map(m => m[0]);
    assert.ok(downs.length > 0, 'it no longer removes the test stack');
    for (const d of downs) assert.match(d, /-p ythril-test\b/, `a compose down outside the test project: ${d}`);
  });

  it('wipes the data disk only when asked with -Wipe', () => {
    const src = code();
    const at = src.indexOf('docker-wipe.ps1');
    assert.ok(at > -1, 'the -Wipe path is gone');
    assert.match(src.slice(Math.max(0, src.lastIndexOf('if', at) - 1), at), /if \(\$Wipe\)/, 'docker-wipe runs without -Wipe');
  });
});

describe('no script on the wipe path removes anything by name outside the test project', () => {
  // A by-name removal is a compose `down`/`rm` or a docker `rm`/`rmi`, however the call is spelled: a literal `docker`,
  // a `compose` argument list, or the module's `$Docker` seam. Each must name the test project.
  const REMOVAL = /(\bdocker\b|\bcompose\b|\$Docker\b)[^\n]*?['"\s](down|rm|rmi)\b[^\n]*/g;
  for (const file of [SCRIPT, WIPE, OWNER, DESKTOP]) {
    it(`${file} removes nothing else by name`, () => {
      assert.ok(existsSync(file), `${file} is missing`);
      for (const [line] of codeOf(file).matchAll(REMOVAL)) {
        assert.match(line, /ythril-test\b/, `${file}: a removal outside the test project: ${line.trim()}`);
      }
    });
  }
});

describe('docker-wipe.ps1 records the owner\'s instance before the delete and brings it back after the engine answers', () => {
  const DELETE = /Remove-Item[^\n]*(\$disk|docker_data\.vhdx)/;

  it('it saves the owner\'s instance before it deletes the data disk', () => {
    const src = codeOf(WIPE);
    const del = at(src, DELETE);
    assert.ok(del > -1, `${WIPE} no longer deletes the data disk`);
    const save = at(src, /\bSave-OwnerInstance\b/);
    assert.ok(save > -1, `${WIPE} never calls Save-OwnerInstance: nothing records what ran`);
    assert.ok(save < del, `${WIPE} saves the owner's instance after the delete, when there is nothing left to read`);
  });

  it('it stops the owner\'s instance before it deletes the data disk', () => {
    const src = codeOf(WIPE);
    const del = at(src, DELETE);
    const stop = at(src, /\bStop-OwnerInstance\b/);
    assert.ok(stop > -1, `${WIPE} never calls Stop-OwnerInstance: mongod is killed with the VM rather than shut down`);
    assert.ok(del > -1 && stop < del, `${WIPE} stops the owner's instance after the delete`);
  });

  it('it restores the owner\'s instance only after Wait-Engine, after the delete', () => {
    const src = codeOf(WIPE);
    const del = at(src, DELETE);
    assert.ok(del > -1, `${WIPE} no longer deletes the data disk`);
    const wait = at(src, /\bWait-Engine\b/, del);
    assert.ok(wait > -1, `${WIPE} never waits for the engine after the delete`);
    const restore = at(src, /\bRestore-OwnerInstance\b/);
    assert.ok(restore > -1, `${WIPE} never calls Restore-OwnerInstance: the owner's instance stays down`);
    assert.ok(restore > wait, `${WIPE} restores the owner's instance before the engine answers again`);
  });

  it('it takes -RestoreOnly, -UseRecord and -DiscardRecord', () => {
    const src = codeOf(WIPE);
    for (const sw of ['RestoreOnly', 'UseRecord', 'DiscardRecord']) {
      assert.match(src, new RegExp(`\\[switch\\]\\s*\\$${sw}\\b`), `${WIPE} declares no -${sw}`);
    }
  });
});

describe('machine-free -Wipe asks every refusal of the wipe before it removes anything (Q-577)', () => {
  // The refusals of docker-wipe.ps1, by what each reads: the data guard (Get-OwnerInstance), a pending record nobody said what to do
  // with (Resolve-PendingRecord), the room the rebuild needs and the registries it pulls from (Assert-WipeMayGoAhead's own checks).
  // They live in ONE function of the module, which both scripts call, so a refusal added to the wipe is asked by machine-free too.
  const ASK = /\bAssert-WipeMayGoAhead\b/;

  it('the one question is asked before the test stack is removed and before the prune, and only with -Wipe', () => {
    const src = code();
    const guard = at(src, ASK);
    const down = at(src, /docker compose[^\n]*\bdown\b/);
    const prune = at(src, /docker system prune/);
    assert.ok(guard > -1, `${SCRIPT} never asks Assert-WipeMayGoAhead: a refusing wipe is found out after the test stack is gone and everything is pruned`);
    assert.ok(down > -1 && prune > -1, `${SCRIPT} no longer removes the test stack or prunes`);
    assert.ok(guard < down, `${SCRIPT} removes the test stack before it asks whether the wipe may go ahead`);
    assert.ok(guard < prune, `${SCRIPT} prunes before it asks whether the wipe may go ahead`);
    assert.match(src.slice(Math.max(0, src.lastIndexOf('if (', guard)), guard), /\$Wipe\b/, `${SCRIPT} asks the wipe's refusal without -Wipe`);
  });

  it('it passes the wipe\'s own switches, so a pending record the owner already decided about is not refused again', () => {
    const call = /Assert-WipeMayGoAhead[^\n]*/.exec(code())?.[0] ?? '';
    for (const sw of ['UseRecord', 'DiscardRecord']) assert.match(call, new RegExp(`-${sw}:\\$${sw}\\b`), `${SCRIPT} does not pass -${sw} to the question`);
  });

  it('the question holds every refusal the wipe has: the data guard, the pending record, the room and the registries', () => {
    const body = /function Assert-WipeMayGoAhead\b[\s\S]*?\n}\r?\n/.exec(codeOf(OWNER))?.[0] ?? '';
    assert.ok(body, `${OWNER} has no Assert-WipeMayGoAhead`);
    for (const [what, re] of [['the data guard', /\bGet-OwnerInstance\b/], ['the pending record', /\bResolve-PendingRecord\b/],
      ['the free space', /\bMeasure-OwnerImages\b/], ['the registries', /\$Reachable\b/]]) {
      assert.match(body, re, `Assert-WipeMayGoAhead does not ask ${what}`);
    }
  });

  it('docker-wipe.ps1 asks the same question before it records, stops, quits Docker or deletes, and keeps no refusal of its own after', () => {
    const src = codeOf(WIPE);
    const ask = at(src, ASK);
    assert.ok(ask > -1, `${WIPE} does not ask Assert-WipeMayGoAhead`);
    for (const [what, re] of [['records the instance', /\bSave-OwnerInstance\b/], ['stops the instance', /\bStop-OwnerInstance\b/],
      ['quits Docker Desktop', /\bStop-DockerDesktop\b/], ['deletes the disk', /Remove-Item[^\n]*\$disk/]]) {
      const pos = at(src, re);
      assert.ok(pos > -1, `${WIPE} no longer ${what}`);
      assert.ok(ask < pos, `${WIPE} ${what} before it asks whether the wipe may go ahead`);
    }
    assert.doesNotMatch(src, /\bTest-Reachable\b/, `${WIPE} still probes a registry itself: the registries are a refusal of the question`);
    assert.doesNotMatch(src, /\bMeasure-OwnerImages\b/, `${WIPE} still measures the room itself: the room is a refusal of the question`);
  });

  it('the header names the refusals asked first, not only the data guard', () => {
    const h = headerOf(SCRIPT);
    for (const [what, re] of [['the pending record', /pending record/i], ['the registries', /registr/i], ['the room', /\b(room|space|free)\b/i]]) {
      assert.match(h, re, `${SCRIPT}'s header does not say ${what} is asked before the prune`);
    }
  });
});

describe('every probe of the engine is bounded, and the guard says it needs the engine', () => {
  it('no script asks `docker info` through an unbounded Invoke-Native', () => {
    for (const file of [SCRIPT, WIPE, COMPACT, OWNER, DESKTOP]) {
      assert.doesNotMatch(codeOf(file), /Invoke-Native\s*(-Command\s*)?\{\s*docker\s+info/, `${file} probes the engine with no bound`);
    }
  });

  it('the one probe carries a timeout, and the default docker seam routes `info` through it', () => {
    assert.match(codeOf(DESKTOP), /function Invoke-DockerInfo[\s\S]*?-FilePath\s+'docker'[\s\S]*?-TimeoutSeconds\s+\d+/, `${DESKTOP}'s docker info probe has no timeout`);
    assert.match(codeOf(OWNER), /function Invoke-DockerCli[\s\S]*?'info'[\s\S]*?Invoke-DockerInfo/, `${OWNER}'s default docker seam does not bound \`info\``);
  });

  it('the wipe and the guide say the guard runs only while the engine answers and checks nothing otherwise (U1c)', () => {
    assert.match(headerOf(WIPE), /nothing is checked/i, `${WIPE}'s header does not say nothing is checked with the engine down`);
    assert.match(codeOf(WIPE).replace(/\s+/g, ' '), /the data guard runs only while it does[^']*NO volume is checked/, `${WIPE}'s output does not say nothing is checked with the engine down`);
    assert.match(readFileSync('docs/workstation-mode-guide.md', 'utf8').replace(/\s+/g, ' '), /only while the engine answers[^.]*nothing is checked/i, 'the workstation guide does not say nothing is checked with the engine down');
  });

  it('no wipe-path text still calls a volume "labelled disposable": the list is x-ythril.disposable-volumes', () => {
    for (const file of [WIPE, SCRIPT, OWNER]) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /\blabell?ed disposable/i, `${file} still says a volume is labelled disposable`);
    }
  });
});

describe('the wipe guide names what the guard cannot see, and the engine it needs (Q-577)', () => {
  // The guard reads this compose project's labelled volumes and the volumes a running service mounts. Three things sit outside its
  // reach, and two versions are its floor; the guide's wipe section says each, so nobody reads "it checked" as "nothing else is lost".
  const section = () => {
    const text = readFileSync('docs/workstation-mode-guide.md', 'utf8').replace(/\r\n/g, '\n');
    const start = text.indexOf("### Wiping Docker's disk");
    assert.ok(start > -1, 'the workstation guide has no wipe section');
    const next = text.indexOf('\n---', start);
    return text.slice(start, next < 0 ? undefined : next).replace(/\s+/g, ' ');
  };

  it('names the volumes the guard does not check: external ones, and a project started under another name', () => {
    const s = section();
    assert.match(s, /external volumes?/i, 'the wipe section does not name external volumes as unchecked');
    assert.match(s, /another project name/,'the wipe section does not name a project started under another name as unchecked');
    assert.match(s, /not checked[^.]*external|external[^.]*not checked/i, 'external volumes are named but not said to be unchecked');
  });

  it('names the version floor, and says an older engine refuses rather than passes', () => {
    const s = section();
    assert.match(s, /Docker 23/, 'the wipe section does not name the Docker 23 floor of `docker volume ls --format json`');
    assert.match(s, /compose[^.]*(project )?name/i, 'the wipe section does not name the compose that reports the project name');
    assert.match(s, /refuses[^.]*(older|too old|below)|(older|too old|below)[^.]*refuses/i, 'the wipe section does not say an older engine or compose refuses');
  });
});

describe('docker-compact.ps1 brings the owner\'s instance back itself, whatever happened in between', () => {
  it('a stop that was attempted is brought back even when it failed part-way', () => {
    const src = codeOf(COMPACT);
    const flag = at(src, /\$stopAttempted\s*=\s*\$true/);
    const stop = at(src, /\bStop-OwnerInstance\b/);
    assert.ok(flag > -1 && stop > -1, `${COMPACT} has no stop-attempted flag before its stop`);
    assert.ok(flag < stop, `${COMPACT} sets its flag after the stop call: a stop that throws part-way is never brought back`);
    const fin = at(src, /\bfinally\s*\{/, stop);
    const back = at(src, /\bStart-OwnerInstance\b/, fin);
    assert.ok(fin > -1 && back > fin, `${COMPACT} has no bring-back in its finally`);
    assert.match(src.slice(fin, back), /\$stopAttempted\b/, `${COMPACT}'s bring-back is not decided by the stop having been attempted`);
  });

  it('it stops the owner\'s instance through the module, and the bring-back runs in a finally after it', () => {
    const src = codeOf(COMPACT);
    const stop = at(src, /\bStop-OwnerInstance\b/);
    assert.ok(stop > -1, `${COMPACT} never calls Stop-OwnerInstance`);
    const fin = at(src, /\bfinally\s*\{/, stop);
    assert.ok(fin > -1, `${COMPACT} has no finally after the stop: a refused UAC or a diskpart failure leaves the instance down`);
    const wait = at(src, /\bWait-Engine\b/, fin);
    const back = at(src, /\bStart-OwnerInstance\b/, fin);
    assert.ok(wait > -1, `${COMPACT}'s finally does not wait for the engine`);
    assert.ok(back > wait, `${COMPACT}'s finally does not bring the owner's instance back after the engine answers`);
  });
});

describe('the headers say what survives a wipe', () => {
  // "the database" and "everything" are the two spellings the headers used for it; both are false for bind-mounted data.
  const DESTROYS_THE_DATABASE = (sentence) => /\b(database|everything)\b/i.test(sentence) && /(destroy|delet|lost|gone|wiped)/i.test(sentence)
    && !/\b(not|never|surviv\w*|kept|keeps|untouched)\b/i.test(sentence);
  for (const file of [WIPE, SCRIPT]) {
    it(`${file}'s header names local-data and config as surviving`, () => {
      const h = headerOf(file);
      assert.match(h, /local-data/, `${file}'s header does not name local-data`);
      assert.match(h, /\bconfig\b/, `${file}'s header does not name config`);
      assert.match(h, /surviv/i, `${file}'s header does not say what survives`);
    });

    it(`${file}'s header no longer claims the database is destroyed`, () => {
      const claims = headerOf(file).split(/(?<=[.!?])\s+/).filter(DESTROYS_THE_DATABASE);
      assert.deepEqual(claims, [], `${file}'s header still says the database goes with the disk`);
    });
  }
});
