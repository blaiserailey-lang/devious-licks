#!/usr/bin/env node
// The update test. Runs the real app against a stand-in for GitHub on this
// machine (a web server on 127.0.0.1) and has it take updates the way a
// person does: the app clicks the Update button in its own window, and the
// window's code does the rest, restart included.
//
//   1. 99.0.0, a good update: the app has to download it, restart by itself
//      and come up running 99.0.0, with the player the update brought along;
//   2. 99.1.0, which fails the moment it starts: the app has to set it aside,
//      come back up on 99.0.0 by itself and say what happened;
//   3. 99.2.0, which quits without a word every time it starts: after three
//      such starts the app has to set it aside and come up on 99.0.0 again;
//   4. 99.3.0, which starts but never opens a window: the app has to give up
//      on it after a while (45 seconds in this test, two minutes normally)
//      and come back up on 99.0.0 by itself;
//   5. 99.4.0, which opens its window and dies half a second later, every
//      time: an update that gets as far as a window but can't stay up has to
//      be set aside just the same;
//   6. 99.4.5, whose code fails a moment after it has started: the app has
//      to notice by itself, set it aside and come back up on 99.0.0;
//   7. 99.5.0, a good update taken with nothing copied from the version that
//      is running: the player it runs afterwards really came down the wire;
//   8. a second copy of the app opened while the first is running: it has to
//      hand over and quit, without counting against the update;
//   9. 99.6.0, one of whose files the server sends off to another site: the
//      app has to refuse to follow, say so, and stay as it is;
//  10. started with --installed-code, the app has to ignore every update and
//      run the code it was installed with;
//  11. ...and when the person there says "stop using it", the update has to
//      be gone for good: the next plain start runs the installed code too.
//
// Every request to the stand-in is first sent on to another address, the way
// GitHub sends requests for release files on to its download servers.
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
const { spawn, spawnSync } = require('child_process');
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
  // (with a space in its name, like the real "Application Support/Devious Licks")
  const work = real(fs.mkdtempSync(path.join(os.tmpdir(), 'dl update test-')));
  const feed = path.join(work, 'feed');
  const data = path.join(work, 'data folder');
  const logFile = path.join(work, 'update-test.log');
  const holdFile = path.join(work, 'let-go');
  const updates = path.join(data, 'updates');
  const runName = `dl-test-run=${path.basename(work).replace(/\W+/g, '-')}`;
  const marker = `--${runName}`; // on every copy of the app this test starts, restarts included
  fs.writeFileSync(logFile, '');

  // ---- the test versions ----
  const base = opts.source ? { source: true } : { app: opts.app };
  const made = {};
  for (const [version, fault] of [['99.0.0'], ['99.1.0', 'throws'], ['99.2.0', 'quits'], ['99.3.0', 'hangs'], ['99.4.0', 'dies'], ['99.4.5', 'stumbles'], ['99.5.0'], ['99.6.0']]) {
    made[version] = (await make({ ...base, version, fault, out: path.join(feed, `v${version}`) })).manifest;
    console.log(`made test update ${version}${fault ? ` (${fault})` : ''}: ${made[version].files.map((f) => f.to).join(', ')}`);
  }
  const playerFiles = made['99.0.0'].files.filter((f) => f.to.startsWith('player/'));
  const hasPlayer = playerFiles.some((f) => f.to === 'player/dl-player');
  const publish = (version) => fs.copyFileSync(path.join(feed, `v${version}`, 'update.json'), path.join(feed, 'update.json'));

  // ---- the stand-in for GitHub ----
  const hits = {}; // how often each file was really handed out
  const offSite = new Set(); // files the server sends to another site instead
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!name.startsWith('/files/')) {
      const there = `/files${name}`;
      res.writeHead(302, { location: offSite.has(name) ? `http://localhost:${server.address().port}${there}` : there }).end();
      return;
    }
    const asked = name.slice('/files'.length);
    const file = path.join(feed, asked);
    if (!file.startsWith(feed + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    hits[asked] = (hits[asked] || 0) + 1;
    res.writeHead(200, { 'content-length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const address = `http://127.0.0.1:${server.address().port}/update.json`;

  // ---- running the app ----
  const exe = opts.source ? require('electron') : path.join(opts.app, 'Contents', 'MacOS', path.basename(opts.app, '.app'));
  const baseArgs = opts.source ? [ROOT, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])] : [];
  const output = [];
  const children = [];
  const launch = ({ args = [], env = {} } = {}) => {
    const child = spawn(exe, [...baseArgs, '--update-test', marker, ...args], {
      env: { ...process.env, DL_USER_DATA: data, DL_UPDATE_FEED: address, DL_TEST_LOG: logFile, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keepOutput = (d) => output.push(...String(d).split('\n').filter(Boolean));
    child.stdout.on('data', keepOutput);
    child.stderr.on('data', keepOutput);
    child.exited = new Promise((r) => child.on('exit', (code, signal) => r(signal || code)));
    children.push(child);
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
  const starts = (version) => (state().starts || {})[version] || 0;
  const waitFor = async (what, seconds, test) => {
    for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(200)) {
      const got = await test();
      if (got) return got;
    }
    throw new Error(`Timed out after ${seconds} seconds waiting for ${what}`);
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const gone = (what, pid) => waitFor(`${what} (process ${pid}) to be gone`, 30, () => !alive(pid));
  const ended = (what, child) => waitFor(`${what} to end`, 90, () => Promise.race([child.exited.then((how) => ({ how })), sleep(150)]));
  // The n-th line in the log, since `from`, that says a copy of the app went away by itself.
  const farewell = async (what, word, from, n) => {
    const seen = await waitFor(what, 90, () => {
      const found = lines().slice(from).filter((l) => l.startsWith(`[update-test] ${word} `));
      return found.length >= n ? found : null;
    });
    const pid = Number(seen[n - 1].split(' ')[2]);
    await gone(what, pid);
  };
  // One run of the app, restarts included, up to its closing line.
  const runToEnd = async (what, how) => {
    const from = lines().length;
    launch(how);
    const got = await waitFor(what, 300, () => {
      const seen = lines().slice(from);
      return seen.some((l) => /^\[update-test\] (done|FAILED)/.test(l)) ? seen : null;
    });
    for (const l of got) console.log(`   ${l}`);
    const last = got[got.length - 1];
    if (!last.startsWith('[update-test] done ')) throw new Error(`${what}: the app reported a failure`);
    const done = JSON.parse(last.slice('[update-test] done '.length));
    await gone(`the app after ${what}`, done.pid);
    return { steps: got.slice(0, -1).map((l) => l.slice('[update-test] '.length)), done };
  };

  const problems = [];
  const check = (what, got, want) => {
    const ok = want instanceof RegExp ? typeof got === 'string' && want.test(got) : JSON.stringify(got) === JSON.stringify(want);
    console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: got ${JSON.stringify(got)}, expected ${want instanceof RegExp ? want : JSON.stringify(want)}`}`);
    if (!ok) problems.push(what);
  };
  const pack = (v) => path.join(updates, v);
  // After an update that failed: back on the version before it, and saying so.
  const backOn = (run, version, failed, bad, why) => {
    check(`it is back on ${version}`, [run.done.version, real(run.done.pack || '')], [version, pack(version)]);
    check(`${failed} was set aside`, [run.done.bad.slice().sort(), run.done.skipped], [bad, [failed]]);
    check('...for the right reason', (state().bad || {})[failed], why);
    check('the button offers it again as something that failed here', [run.done.phase, run.done.latest, run.done.failedBefore, run.done.label], ['available', failed, true, `Try ${failed} again`]);
    check('...and the window says what happened', run.done.notice, new RegExp(`Version ${failed.replace(/\./g, '\\.')} was downloaded but did not start on this Mac.*went back to version ${version.replace(/\./g, '\\.')}`));
    check('the failed download was cleared away', fs.existsSync(pack(failed)), false);
  };

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
    check('the window has the Update button, shows the version and has nothing to report', [run.done.button, run.done.label, run.done.shown, run.done.notice], [true, 'Update', 'Version 99.0.0', null]);
    check('the code was downloaded once', hits['/v99.0.0/app.asar'], 1);
    if (hasPlayer) {
      check('the player is the one the update brought', real(run.done.playerDir || ''), path.join(pack('99.0.0'), 'player'));
      check('...and it runs', typeof run.done.player === 'string' && !run.done.player.startsWith('FAILED') && run.done.player.length > 0, true);
      console.log(`      player: ${run.done.player}`);
      // The player did not change, so it is copied from the installed app, not downloaded again.
      check('the unchanged player was not downloaded again', playerFiles.map((f) => hits[`/v99.0.0/${f.name}`] || 0), playerFiles.map(() => 0));
    }
    check('99.0.0 is noted as working', [state().good, state().starts], ['99.0.0', {}]);

    // ---- 2. an update that fails when it starts ----
    console.log('\n2. An update that fails when it starts (99.1.0)');
    publish('99.1.0');
    run = await runToEnd('the failing update');
    check('the steps', run.steps, ['running 99.0.0 from an update pack', 'installed 99.1.0, restarting', 'running 99.0.0 from an update pack']);
    backOn(run, '99.0.0', '99.1.0', ['99.1.0'], /broken on purpose/);

    // ---- 3. an update that never comes up ----
    console.log('\n3. An update that quits every time it starts (99.2.0)');
    publish('99.2.0');
    let from = lines().length;
    launch();
    await waitFor('99.2.0 to be installed', 300, () => lines().slice(from).some((l) => /installed 99\.2\.0, restarting|FAILED/.test(l)));
    for (const l of lines().slice(from)) console.log(`   ${l}`);
    await farewell('the first start of 99.2.0', 'quitting', from, 1);
    check('start 1 of 99.2.0 was counted', starts('99.2.0'), 1);
    for (const n of [2, 3]) {
      const { how } = await ended(`start ${n} of 99.2.0`, launch());
      check(`start ${n} of 99.2.0 ends without a window`, [how, starts('99.2.0')], [0, n]);
    }
    run = await runToEnd('the start after three failed ones');
    check('the steps', run.steps, ['running 99.0.0 from an update pack']);
    backOn(run, '99.0.0', '99.2.0', ['99.1.0', '99.2.0'], /did not come up on 3 starts in a row/);

    // ---- 4. an update that starts but never shows a window ----
    console.log('\n4. An update that starts but never opens a window (99.3.0)');
    publish('99.3.0');
    run = await runToEnd('the update that hangs', { env: { DL_BOOT_PATIENCE: '45' } });
    check('the steps', run.steps, ['running 99.0.0 from an update pack', 'installed 99.3.0, restarting', 'running 99.0.0 from an update pack']);
    backOn(run, '99.0.0', '99.3.0', ['99.1.0', '99.2.0', '99.3.0'], /did not come up within 45 seconds/);

    // ---- 5. an update that opens its window and then dies ----
    console.log('\n5. An update that opens its window and dies right after (99.4.0)');
    publish('99.4.0');
    from = lines().length;
    launch();
    await waitFor('99.4.0 to be installed', 300, () => lines().slice(from).some((l) => /installed 99\.4\.0, restarting|FAILED/.test(l)));
    await farewell('the first start of 99.4.0', 'dying', from, 1);
    check('start 1 of 99.4.0 was counted, and not taken for a working one', [starts('99.4.0'), state().good], [1, '99.0.0']);
    for (const n of [2, 3]) {
      const child = launch();
      await farewell(`start ${n} of 99.4.0`, 'dying', from, n);
      const { how } = await ended(`start ${n} of 99.4.0`, child);
      check(`start ${n} of 99.4.0 got as far as a window, then died`, [how, starts('99.4.0'), state().good], ['SIGKILL', n, '99.0.0']);
    }
    for (const l of lines().slice(from)) console.log(`   ${l}`);
    run = await runToEnd('the start after three that died');
    check('the steps', run.steps, ['running 99.0.0 from an update pack']);
    backOn(run, '99.0.0', '99.4.0', ['99.1.0', '99.2.0', '99.3.0', '99.4.0'], /did not come up on 3 starts in a row/);

    // ---- 6. an update whose code fails just after it has started ----
    console.log('\n6. An update that fails a moment after it has started (99.4.5)');
    publish('99.4.5');
    run = await runToEnd('the update that stumbles');
    check('the steps', run.steps, ['running 99.0.0 from an update pack', 'installed 99.4.5, restarting', 'running 99.0.0 from an update pack']);
    backOn(run, '99.0.0', '99.4.5', ['99.1.0', '99.2.0', '99.3.0', '99.4.0', '99.4.5'], /failed while starting: Error: this test update trips over its own feet/);

    // ---- 7. a good update with every file downloaded ----
    console.log('\n7. A good update with nothing copied from the running version (99.5.0)');
    publish('99.5.0');
    run = await runToEnd('the update that is downloaded whole', { env: { DL_TEST_NO_REUSE: '1' } });
    check('the steps', run.steps, ['running 99.0.0 from an update pack', 'installed 99.5.0, restarting', 'running 99.5.0 from an update pack']);
    check('it runs 99.5.0', [run.done.version, real(run.done.pack || ''), run.done.shown], ['99.5.0', pack('99.5.0'), 'Version 99.5.0']);
    check('every file came from the server, once', made['99.5.0'].files.map((f) => hits[`/v99.5.0/${f.name}`] || 0), made['99.5.0'].files.map(() => 1));
    if (hasPlayer) {
      check('the downloaded player runs', [real(run.done.playerDir || ''), typeof run.done.player === 'string' && !run.done.player.startsWith('FAILED') && run.done.player.length > 0], [path.join(pack('99.5.0'), 'player'), true]);
      console.log(`      player: ${run.done.player}`);
      if (process.platform === 'darwin') {
        // What macOS makes of files the app fetched by itself: no "from the
        // internet" mark, and the signatures they were built with.
        for (const f of playerFiles.filter((p) => !p.name.endsWith('.txt'))) {
          const file = path.join(pack('99.5.0'), f.to);
          const marks = spawnSync('xattr', [file], { encoding: 'utf8' }).stdout.trim();
          const signed = spawnSync('codesign', ['--verify', '--strict', file], { encoding: 'utf8' });
          check(`${f.to}: no quarantine mark, signature intact`, [marks.includes('com.apple.quarantine'), signed.status], [false, 0]);
          console.log(`      ${f.to}: marks [${marks.replace(/\n/g, ', ')}]${signed.status === 0 ? '' : ` codesign: ${signed.stderr.trim()}`}`);
        }
      }
    }
    check('99.5.0 is noted as working, and the pack before it is gone', [state().good, fs.existsSync(pack('99.0.0'))], ['99.5.0', false]);

    // ---- 8. two copies of the app at once ----
    console.log('\n8. A second copy of the app opened while the first is running');
    from = lines().length;
    const first = launch({ env: { DL_TEST_HOLD: holdFile } });
    const held = await waitFor('the first copy to be up', 120, () => lines().slice(from).find((l) => l.startsWith('[update-test] holding ')));
    const second = await ended('the second copy', launch());
    check('the second copy quit by itself', second.how, 0);
    check('...after handing over', lines().slice(from).some((l) => / second copy \d+: handing over/.test(l)), true);
    check('...and the first one was told', await waitFor('the first copy to hear of it', 20, () => lines().slice(from).some((l) => l.includes('a second copy was opened'))), true);
    check('the first copy is still running', alive(Number(held.split(' ')[2])), true);
    check('the second start does not count against the update', [starts('99.5.0'), state().good, state().bad && Object.keys(state().bad).includes('99.5.0')], [0, '99.5.0', false]);
    fs.writeFileSync(holdFile, '');
    const closing = await waitFor('the first copy to finish', 120, () => lines().slice(from).find((l) => /^\[update-test\] (done|FAILED)/.test(l)));
    for (const l of lines().slice(from)) console.log(`   ${l}`);
    check('the first copy finished its run on 99.5.0', /^\[update-test\] done .*"version":"99\.5\.0"/.test(closing), true);
    await ended('the first copy', first);

    // ---- 9. a download that is sent somewhere else ----
    console.log('\n9. An update with a file the server sends off to another site (99.6.0)');
    publish('99.6.0');
    offSite.add('/v99.6.0/app.asar');
    run = await runToEnd('the update with a file sent elsewhere');
    check('the steps', run.steps, ['running 99.5.0 from an update pack']);
    check('the update was refused', [run.done.phase, run.done.latest, run.done.error], ['error', '99.6.0', 'The download was redirected somewhere unexpected.']);
    check('...and the window says so, with the way out', run.done.notice, /The update to version 99\.6\.0 didn't go through\. The download was redirected somewhere unexpected\..*download page/);
    check('the file was never fetched from there', hits['/v99.6.0/app.asar'] || 0, 0);
    check('nothing changed: still 99.5.0, nothing of 99.6.0 on disk', [run.done.version, fs.readdirSync(updates).filter((n) => n.includes('99.6.0'))], ['99.5.0', []]);
    offSite.clear();

    // ---- 10. the way out ----
    console.log('\n10. Started with --installed-code');
    publish('99.5.0');
    run = await runToEnd('the start with --installed-code', { args: ['--installed-code'] });
    check('the steps', run.steps, [`running ${installed} from the installed code`]);
    check('it runs the installed code', [run.done.version, run.done.pack, run.done.shown], [installed, null, `Version ${installed}`]);
    check('...and sees the update waiting on the disk', [run.done.phase, run.done.latest, run.done.label], ['ready', '99.5.0', 'Restart to finish']);
    check('nothing was switched off without being asked', [fs.existsSync(pack('99.5.0')), state().good], [true, '99.5.0']);

    // ---- 11. ...and for good ----
    console.log('\n11. Switching the update off from there');
    run = await runToEnd('the start that switches the update off', { args: ['--installed-code'], env: { DL_TEST_ANSWER: 'stop' } });
    check('the steps', run.steps, ['switched off 99.5.0', `running ${installed} from the installed code`]);
    check('the update is set aside and its files are gone', [(state().bad || {})['99.5.0'], state().good || null, fs.existsSync(pack('99.5.0')), fs.existsSync(path.join(updates, 'current.json'))], ['switched off by hand', null, false, false]);
    check('the button offers it again by name, not as something to restart into', [run.done.phase, run.done.latest, run.done.failedBefore, run.done.label], ['available', '99.5.0', true, 'Try 99.5.0 again']);
    run = await runToEnd('the next plain start');
    check('the steps', run.steps, [`running ${installed} from the installed code`]);
    check('a plain start now runs the installed code, with nothing to complain about', [run.done.version, run.done.pack, run.done.skipped, run.done.notice, run.done.label], [installed, null, [], null, 'Try 99.5.0 again']);
  } catch (err) {
    problems.push(err.message);
    console.log(`\n${err.message}`);
    console.log('\nWhat the app wrote:');
    for (const l of lines()) console.log(`   ${l}`);
    console.log("\nThe end of the app's output:");
    for (const l of output.slice(-80)) console.log(`   ${l}`);
    console.log(`\nstate.json: ${JSON.stringify(state())}`);
  } finally {
    // Nothing this test started is left running.
    for (const child of children) child.kill('SIGKILL');
    spawnSync('pkill', ['-9', '-f', runName]);
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
