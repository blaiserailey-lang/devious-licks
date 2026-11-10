#!/usr/bin/env node
// The update test. Runs the real app against a stand-in for GitHub on this
// machine (a web server on 127.0.0.1) and has it take updates the way the
// Update button does:
//
//   1. 99.0.0, a good update: the app has to download it, restart by itself
//      and come up running 99.0.0, with the player the update brought along;
//   2. 99.1.0, which fails the moment it starts: the app has to set it aside
//      and come back up on 99.0.0 by itself;
//   3. 99.2.0, which quits without a word every time it starts: after three
//      such starts the app has to set it aside and come up on 99.0.0 again;
//   4. 99.3.0, which starts but never opens a window: the app has to give up
//      on it after a while (20 seconds in this test, two minutes normally) and come back up on
//      99.0.0 by itself;
//   5. started with --installed-code, the app has to ignore every update and
//      run the code it was installed with.
//
// The test versions are made from the app's own code (scripts/make-update.js).
// Nothing here touches the real library: the app keeps its files in a
// temporary folder for the test.
//
//   node scripts/test-update.js --app "dist/mac-universal/Devious Licks.app"
//   node scripts/test-update.js --source     the code in this folder, run with Electron (needs a display)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { make } = require('./make-update');

const ROOT = path.join(__dirname, '..');
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
    if (argv[i] === '--source') opts.source = true;
    else if (argv[i] === '--app' && i + 1 < argv.length) opts.app = path.resolve(argv[++i]);
    else if (argv[i] === '--keep') opts.keep = true; // leave the test's folder behind, to look at
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  if (!opts.source && !opts.app) throw new Error('Say what to test: --app <X.app>, or --source');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const work = real(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-update-test-')));
  const feed = path.join(work, 'feed');
  const data = path.join(work, 'data');
  const logFile = path.join(work, 'update-test.log');
  const updates = path.join(data, 'updates');
  fs.writeFileSync(logFile, '');

  // ---- the three test versions ----
  const base = opts.source ? { source: true } : { app: opts.app };
  const made = {};
  for (const [version, fault] of [['99.0.0'], ['99.1.0', 'throws'], ['99.2.0', 'quits'], ['99.3.0', 'hangs']]) {
    made[version] = (await make({ ...base, version, fault, out: path.join(feed, `v${version}`) })).manifest;
    console.log(`made test update ${version}${fault ? ` (${fault})` : ''}: ${made[version].files.map((f) => f.to).join(', ')}`);
  }
  const hasPlayer = made['99.0.0'].files.some((f) => f.to === 'player/dl-player');
  const publish = (version) => fs.copyFileSync(path.join(feed, `v${version}`, 'update.json'), path.join(feed, 'update.json'));

  // ---- the stand-in for GitHub ----
  const hits = {};
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(feed, name);
    hits[name] = (hits[name] || 0) + 1;
    if (!file.startsWith(feed + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const address = `http://127.0.0.1:${server.address().port}/update.json`;

  // ---- running the app ----
  const exe = opts.source ? require('electron') : path.join(opts.app, 'Contents', 'MacOS', path.basename(opts.app, '.app'));
  const baseArgs = opts.source ? [ROOT, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])] : [];
  const output = [];
  const launch = ({ args = [], env = {} } = {}) => {
    const child = spawn(exe, [...baseArgs, '--update-test', ...args], {
      env: { ...process.env, DL_USER_DATA: data, DL_UPDATE_FEED: address, DL_TEST_LOG: logFile, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keepOutput = (d) => output.push(...String(d).split('\n').filter(Boolean));
    child.stdout.on('data', keepOutput);
    child.stderr.on('data', keepOutput);
    child.exited = new Promise((r) => child.on('exit', r));
    return child;
  };
  const lines = () => fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('[update-test]'));
  const state = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(updates, 'state.json'), 'utf8'));
    } catch {
      return {};
    }
  };
  const waitFor = async (what, seconds, test) => {
    for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(200)) {
      const got = test();
      if (got) return got;
    }
    throw new Error(`Timed out after ${seconds} seconds waiting for ${what}`);
  };
  // One run of the app, restarts included, up to its closing line.
  const runToEnd = async (what, how) => {
    const from = lines().length;
    launch(how);
    const got = await waitFor(what, 240, () => {
      const seen = lines().slice(from);
      return seen.some((l) => /^\[update-test\] (done|FAILED)/.test(l)) ? seen : null;
    });
    for (const l of got) console.log(`   ${l}`);
    const last = got[got.length - 1];
    if (!last.startsWith('[update-test] done ')) throw new Error(`${what}: the app reported a failure`);
    const done = JSON.parse(last.slice('[update-test] done '.length));
    await waitFor(`the app to quit after ${what}`, 30, () => !alive(done.pid));
    return { steps: got.slice(0, -1).map((l) => l.slice('[update-test] '.length)), done };
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const problems = [];
  const check = (what, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`}`);
    if (!ok) problems.push(what);
  };
  const pack = (v) => path.join(updates, v);

  try {
    // ---- 1. a good update ----
    console.log('\n1. A good update (99.0.0)');
    publish('99.0.0');
    let run = await runToEnd('the good update');
    const installed = run.done.installed;
    check('the steps', run.steps, [`running ${installed} from the installed code`, 'installed 99.0.0, restarting', 'running 99.0.0 from an update pack']);
    check('it runs 99.0.0', run.done.version, '99.0.0');
    check('...from the update in its data folder', real(run.done.pack || ''), pack('99.0.0'));
    check('nothing newer is on offer', [run.done.phase, run.done.error], ['none', null]);
    check('no update has been set aside or passed over', [run.done.bad, run.done.skipped], [[], []]);
    check('the window has the Update button and shows the version', [run.done.button, run.done.shown], [true, 'Version 99.0.0']);
    check('the code was downloaded once', hits['/v99.0.0/app.asar'], 1);
    if (hasPlayer) {
      check('the player is the one the update brought', real(run.done.playerDir || ''), path.join(pack('99.0.0'), 'player'));
      check('...and it runs', typeof run.done.player === 'string' && !run.done.player.startsWith('FAILED') && run.done.player.length > 0, true);
      console.log(`      player: ${run.done.player}`);
      // The player did not change, so it is copied from the installed app, not downloaded again.
      check('the unchanged player was not downloaded again', [hits['/v99.0.0/dl-player'] || 0, hits['/v99.0.0/mupen64plus_next_libretro.dylib'] || 0], [0, 0]);
    }
    check('99.0.0 is noted as working', state().good, '99.0.0');

    // ---- 2. an update that fails when it starts ----
    console.log('\n2. An update that fails when it starts (99.1.0)');
    publish('99.1.0');
    run = await runToEnd('the failing update');
    check('the steps', run.steps, ['running 99.0.0 from an update pack', 'installed 99.1.0, restarting', 'running 99.0.0 from an update pack']);
    check('it is back on 99.0.0', [run.done.version, real(run.done.pack || '')], ['99.0.0', pack('99.0.0')]);
    check('99.1.0 was set aside', run.done.bad, ['99.1.0']);
    check('...and the start-up code said it passed it over', run.done.skipped, ['99.1.0']);
    check('the button offers 99.1.0 again, knowing it failed here', [run.done.phase, run.done.latest, run.done.failedBefore], ['available', '99.1.0', true]);
    check('the failed download was cleared away', fs.existsSync(pack('99.1.0')), false);
    console.log(`      why: ${state().bad && state().bad['99.1.0']}`);

    // ---- 3. an update that never comes up ----
    console.log('\n3. An update that quits every time it starts (99.2.0)');
    publish('99.2.0');
    const from = lines().length;
    launch();
    await waitFor('99.2.0 to be installed', 240, () => lines().slice(from).some((l) => /installed 99\.2\.0, restarting|FAILED/.test(l)));
    for (const l of lines().slice(from)) console.log(`   ${l}`);
    await waitFor('its first start', 60, () => state().starts && state().starts['99.2.0'] === 1);
    await sleep(3000); // it quits by itself
    for (const n of [2, 3]) {
      const code = await launch().exited;
      check(`start ${n} of 99.2.0 ends without a window`, [code, state().starts && state().starts['99.2.0']], [0, n]);
    }
    run = await runToEnd('the start after three failed ones');
    check('the steps', run.steps, ['running 99.0.0 from an update pack']);
    check('it is back on 99.0.0', [run.done.version, real(run.done.pack || '')], ['99.0.0', pack('99.0.0')]);
    check('99.2.0 was set aside too', run.done.bad.slice().sort(), ['99.1.0', '99.2.0']);
    console.log(`      why: ${state().bad && state().bad['99.2.0']}`);

    // ---- 4. an update that starts but never shows a window ----
    console.log('\n4. An update that starts but never opens a window (99.3.0)');
    publish('99.3.0');
    run = await runToEnd('the update that hangs', { env: { DL_BOOT_PATIENCE: '20' } });
    check('the steps', run.steps, ['running 99.0.0 from an update pack', 'installed 99.3.0, restarting', 'running 99.0.0 from an update pack']);
    check('it is back on 99.0.0', [run.done.version, real(run.done.pack || '')], ['99.0.0', pack('99.0.0')]);
    check('99.3.0 was set aside as well', run.done.bad.slice().sort(), ['99.1.0', '99.2.0', '99.3.0']);
    console.log(`      why: ${state().bad && state().bad['99.3.0']}`);

    // ---- 5. the way out ----
    console.log('\n5. Started with --installed-code');
    run = await runToEnd('the start with --installed-code', { args: ['--installed-code'] });
    check('the steps', run.steps, [`running ${installed} from the installed code`]);
    check('it runs the installed code', [run.done.version, run.done.pack], [installed, null]);
  } catch (err) {
    problems.push(err.message);
    console.log(`\n${err.message}`);
    console.log('\nWhat the app wrote:');
    for (const l of lines()) console.log(`   ${l}`);
    console.log("\nThe end of the app's output:");
    for (const l of output.slice(-60)) console.log(`   ${l}`);
    console.log(`\nstate.json: ${JSON.stringify(state())}`);
  }

  server.close();
  if (opts.keep) console.log(`\nThe test's files are in ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
  if (problems.length) {
    console.log(`\nUpdate test FAILED: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log('\nUpdate test passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(`test-update: ${err.stack || err}`);
  process.exit(1);
});
