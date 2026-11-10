const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { makeFetch } = require('../src/transport');

// Stands in for Electron's net module: each request plays back a script of
// what the server does ({ redirect }, { status, chunks }, { error }).
function fakeNet(script) {
  const made = [];
  return {
    made,
    request(options) {
      const req = new EventEmitter();
      Object.assign(req, { options, followed: [], abortedTimes: 0, response: null });
      const steps = [...script];
      const next = () => {
        const step = steps.shift();
        if (!step || req.abortedTimes) return;
        if (step.redirect) {
          let followed = false;
          req.followRedirect = () => { followed = true; req.followed.push(step.redirect); };
          req.emit('redirect', 302, 'GET', step.redirect, {});
          req.followRedirect = () => { throw new Error('followRedirect called too late'); };
          if (followed) setImmediate(next);
        } else if (step.error) {
          req.emit('error', new Error(step.error));
        } else {
          const res = new Readable({ read() {} });
          res.statusCode = step.status;
          req.response = res;
          req.emit('response', res);
          for (const chunk of step.chunks || []) res.push(chunk);
          if (!step.hang) res.push(null);
        }
      };
      req.end = () => setImmediate(next);
      req.abort = () => {
        req.abortedTimes += 1;
        if (req.response && !req.response.destroyed) req.response.destroy(); // what Electron does
      };
      made.push(req);
      return req;
    },
  };
}

const https = (url) => url.startsWith('https://');

test('a plain answer comes back as a Response with its body', async () => {
  const net = fakeNet([{ status: 200, chunks: ['hello ', 'there'] }]);
  const res = await makeFetch(net, https)('https://github.com/x/update.json');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(await res.text(), 'hello there');
  assert.deepStrictEqual({ ...net.made[0].options }, { url: 'https://github.com/x/update.json', method: 'GET', redirect: 'manual', cache: 'no-store' });
});

test('a 404 is an answer, not an error', async () => {
  const res = await makeFetch(fakeNet([{ status: 404, chunks: ['Not Found'] }]), https)('https://github.com/x');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.ok, false);
});

test('every redirect is checked, and the allowed ones are followed on the spot', async () => {
  const net = fakeNet([{ redirect: 'https://github.com/a' }, { redirect: 'https://release-assets.example.net/b' }, { status: 200, chunks: ['file'] }]);
  const res = await makeFetch(net, https)('https://github.com/x');
  assert.strictEqual(await res.text(), 'file');
  assert.deepStrictEqual(net.made[0].followed, ['https://github.com/a', 'https://release-assets.example.net/b']);
});

test('a redirect to somewhere that is not allowed stops the request', async () => {
  const net = fakeNet([{ redirect: 'https://github.com/a' }, { redirect: 'http://elsewhere.example/b' }, { status: 200, chunks: ['never'] }]);
  await assert.rejects(makeFetch(net, https)('https://github.com/x'), /redirected somewhere unexpected/);
  assert.deepStrictEqual(net.made[0].followed, ['https://github.com/a']);
  assert.strictEqual(net.made[0].abortedTimes, 1);
  // and an address that isn't allowed is not even asked for
  const none = fakeNet([{ status: 200 }]);
  await assert.rejects(makeFetch(none, https)('http://github.com/x'), /redirected somewhere unexpected/);
  assert.strictEqual(none.made.length, 0);
});

test('a network error is passed on', async () => {
  await assert.rejects(makeFetch(fakeNet([{ error: 'net::ERR_INTERNET_DISCONNECTED' }]), https)('https://github.com/x'), /ERR_INTERNET_DISCONNECTED/);
});

test('stopping a request: before the answer it fails, after the answer the body fails', async () => {
  const early = new AbortController();
  const quiet = fakeNet([]); // a server that never answers
  const waiting = makeFetch(quiet, https)('https://github.com/x', { signal: early.signal });
  setTimeout(() => early.abort(), 20);
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.strictEqual(quiet.made[0].abortedTimes, 1);

  const late = new AbortController();
  const stalls = fakeNet([{ status: 200, chunks: ['part'], hang: true }]); // answers, then goes silent
  const res = await makeFetch(stalls, https)('https://github.com/x', { signal: late.signal });
  const reader = res.body.getReader();
  assert.strictEqual(Buffer.from((await reader.read()).value).toString(), 'part');
  setTimeout(() => late.abort(), 20);
  await assert.rejects(reader.read());
  assert.strictEqual(stalls.made[0].abortedTimes, 1);

  const already = new AbortController();
  already.abort();
  const never = fakeNet([{ status: 200 }]);
  await assert.rejects(makeFetch(never, https)('https://github.com/x', { signal: already.signal }));
  assert.strictEqual(never.made.length, 0);
});

test('an answer with a status no page could have is an error, not a crash', async () => {
  const net = fakeNet([{ status: 101 }]);
  await assert.rejects(makeFetch(net, https)('https://github.com/x'));
  assert.strictEqual(net.made[0].abortedTimes, 1);
});
