#!/usr/bin/env node
// The update the way it will really happen: a copy of the app as it was
// RELEASED (its start-up code can never be changed again) takes the update
// files made from THIS build, from a stand-in for GitHub on this machine. It
// has to download them, restart by itself, come up running the new version
// with the player the update brought, and still be on it at the next start.
//
// scripts/test-update.js tries every way an update can go wrong, with test
// versions cut from one build. This one is the plain case across two real
// builds: what every Mac that has the app is about to do.
//
//   node scripts/test-real-update.js --app "<the released>/Devious Licks.app" --pack dist/update
//   node scripts/test-real-update.js --source <folder with the released code> --pack <folder>
//       (--source: run with Electron from a source folder; needs a display)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const packs = require('../src/packs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app' && i + 1 < argv.length) opts.app = path.resolve(argv[++i]);
    else if (argv[i] === '--source' && i + 1 < argv.length) opts.source = path.resolve(argv[++i]);
    else if (argv[i] === '--pack' && i + 1 < argv.length) opts.pack = path.resolve(argv[++i]);
    else if (argv[i] === '--keep') opts.keep = true;
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  if (!opts.pack || (!opts.app && !opts.source)) throw new Error('Say what to test: --app <released X.app> (or --source <folder>) and --pack <folder with update.json>');
  return opts;
}

// The version of the released app, read from its own code.
function versionOf(opts) {
  if (opts.source) return JSON.parse(fs.readFileSync(path.join(opts.source, 'package.json'), 'utf8')).version;
  const asar = require('@electron/asar');
  return JSON.parse(asar.extractFile(path.join(opts.app, 'Contents', 'Resources', 'app.asar'), 'package.json').toString('utf8')).version;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.pack, 'update.json'), 'utf8'));
  const next = manifest.version;
  const old = versionOf(opts);
  console.log(`The released app is ${old}; the update is ${next} (needs app ${manifest.needsApp} or later, engine ${manifest.electron}).`);
  if (!packs.newer(next, old)) {
    console.log('That is not a later version than the released one: nothing to update, nothing tested.');
    return 0;
  }
  if (packs.newer(manifest.needsApp, old)) {
    console.log(`Version ${old} is older than this update asks for: such a Mac is sent to the download page instead (as intended), so there is nothing to test here.`);
    return 0;
  }

  const work = real(fs.mkdtempSync(path.join(os.tmpdir(), 'dl real update-')));
  const data = path.join(work, 'data folder');
  const logFile = path.join(work, 'update-test.log');
  const updates = path.join(data, 'updates');
  const runName = `dl-test-run=${path.basename(work).replace(/\W+/g, '-')}`;
  fs.writeFileSync(logFile, '');

  // ---- the stand-in for GitHub: update.json, and the files under /v<version>/ ----
  // (Every request is first sent on to another address, as GitHub does.)
  const hits = {};
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!name.startsWith('/files/')) {
      res.writeHead(302, { location: `/files${name}` }).end();
      return;
    }
    const asked = name.slice('/files'.length);
    const wanted = asked === '/update.json' ? 'update.json' : asked.startsWith(`/v${next}/`) ? asked.slice(`/v${next}/`.length) : null;
    const file = wanted && !wanted.includes('/') && !wanted.includes('..') ? path.join(opts.pack, wanted) : null;
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    hits[wanted] = (hits[wanted] || 0) + 1;
    res.writeHead(200, { 'content-length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const address = `http://127.0.0.1:${server.address().port}/update.json`;

  // ---- running the released app ----
  const exe = opts.source ? require('electron') : path.join(opts.app, 'Contents', 'MacOS', path.basename(opts.app, '.app'));
  const baseArgs = opts.source ? [opts.source, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])] : [];
  const output = [];
  const children = [];
  const lines = () => fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('[update-test]'));
  const state = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(updates, 'state.json'), 'utf8'));
    } catch {
      return {};
    }
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (what, seconds, test) => {
    for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(200)) {
      const got = await test();
      if (got) return got;
    }
    throw new Error(`Timed out after ${seconds} seconds waiting for ${what}`);
  };
  // One run of the app, restarts included, up to its closing line.
  const runToEnd = async (what) => {
    const from = lines().length;
    const child = spawn(exe, [...baseArgs, '--update-test', `--${runName}`], {
      env: { ...process.env, DL_USER_DATA: data, DL_UPDATE_FEED: address, DL_TEST_LOG: logFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keepOutput = (d) => output.push(...String(d).split('\n').filter(Boolean));
    child.stdout.on('data', keepOutput);
    child.stderr.on('data', keepOutput);
    children.push(child);
    const got = await waitFor(what, 300, () => {
      const seen = lines().slice(from);
      return seen.some((l) => /^\[update-test\] (done|FAILED)/.test(l)) ? seen : null;
    });
    for (const l of got) console.log(`   ${l}`);
    const last = got[got.length - 1];
    if (!last.startsWith('[update-test] done ')) throw new Error(`${what}: the app reported a failure`);
    const done = JSON.parse(last.slice('[update-test] done '.length));
    await waitFor(`the app after ${what} to be gone`, 30, () => !alive(done.pid));
    return { steps: got.slice(0, -1).map((l) => l.slice('[update-test] '.length)), done };
  };

  const problems = [];
  const check = (what, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`}`);
    if (!ok) problems.push(what);
  };
  const pack = path.join(updates, next);
  const hasPlayer = manifest.files.some((f) => f.to === 'player/dl-player');

  try {
    console.log(`\n1. The released ${old} takes ${next}`);
    let run = await runToEnd('the update');
    check('the steps', run.steps, [`running ${old} from the installed code`, `installed ${next}, restarting`, `running ${next} from an update pack`]);
    check(`it runs ${next}, from the update in its data folder`, [run.done.version, real(run.done.pack || '')], [next, pack]);
    check('the app it was installed as is still the released one', run.done.installed, old);
    check('nothing newer is on offer, nothing went wrong', [run.done.phase, run.done.error], ['none', null]);
    check('no update has been set aside or passed over', [run.done.bad, run.done.skipped], [[], []]);
    check('the window shows the new version', run.done.shown, `Version ${next}`);
    check('the code came down the wire, once', hits['app.asar'], 1);
    if (hasPlayer) {
      check('the player is the one the update brought', real(run.done.playerDir || ''), path.join(pack, 'player'));
      check('...and it runs', typeof run.done.player === 'string' && !run.done.player.startsWith('FAILED') && run.done.player.length > 0, true);
      console.log(`      player: ${run.done.player}`);
    }
    for (const f of manifest.files) console.log(`      ${f.name}: ${hits[f.name] ? 'downloaded' : 'the same as in the released app, copied from there'}`);
    check(`${next} is noted as working`, [state().good, state().starts], [next, {}]);

    console.log('\n2. The next start');
    run = await runToEnd('the next start');
    check('the steps', run.steps, [`running ${next} from an update pack`]);
    check(`it is still on ${next}, with nothing to report`, [run.done.version, real(run.done.pack || ''), run.done.bad, run.done.skipped, run.done.notice], [next, pack, [], [], null]);
    check('nothing was downloaded again', hits['app.asar'], 1);
  } catch (err) {
    problems.push(err.message);
    console.log(`\n${err.message}`);
    console.log('\nWhat the app wrote:');
    for (const l of lines()) console.log(`   ${l}`);
    console.log("\nThe end of the app's output:");
    for (const l of output.slice(-80)) console.log(`   ${l}`);
    console.log(`\nstate.json: ${JSON.stringify(state())}`);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    spawnSync('pkill', ['-9', '-f', runName]);
  }

  server.close();
  if (opts.keep) console.log(`\nThe test's files are in ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
  if (problems.length) {
    console.log(`\nReal update test FAILED: ${problems.join('; ')}`);
    return 1;
  }
  console.log(`\nReal update test passed: a released ${old} becomes ${next} through its Update button.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`test-real-update: ${err.stack || err}`);
    process.exit(1);
  }
);
