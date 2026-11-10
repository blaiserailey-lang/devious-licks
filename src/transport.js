// How the Update button reaches GitHub from inside the app: through the
// app's own network stack (the one its windows use, so the Mac's proxy and
// certificate settings apply), one request at a time, with every redirect
// looked at before it is followed.
//
// GitHub answers a request for a release file by sending the app on to its
// download servers. Where those live has changed over the years and may
// change again, so the rule is not a list of names: every step of the way
// has to pass `allowed` (in the app: it has to be https), and the files that
// arrive are checked against the sizes and SHA-256 hashes in update.json
// anyway.
//
// (Electron's net.fetch can't do this: it follows redirects by itself and
// doesn't say where it ended up.)
'use strict';
const { Readable } = require('stream');

const REDIRECTED = 'The download was redirected somewhere unexpected.';
const NO_BODY = new Set([101, 204, 205, 304]);

function aborted(signal) {
  if (signal && signal.reason instanceof Error) return signal.reason;
  const err = new Error('The request was stopped.');
  err.name = 'AbortError';
  return err;
}

// makeFetch(net, allowed) returns fetch(url, { signal, cache }), which
// answers with a Response like the standard fetch does (status, ok, body).
function makeFetch(net, allowed) {
  return function fetch(url, { signal, cache = 'no-store' } = {}) {
    return new Promise((resolve, reject) => {
      if (!allowed(url)) {
        reject(new Error(REDIRECTED));
        return;
      }
      if (signal && signal.aborted) {
        reject(aborted(signal));
        return;
      }
      const request = net.request({ url, method: 'GET', redirect: 'manual', cache });
      let response = null;
      let over = false; // the promise has been settled
      const settle = (how, value) => {
        if (over) return false;
        over = true;
        how(value);
        return true;
      };
      let onAbort = null;
      const done = () => signal && signal.removeEventListener('abort', onAbort);
      const stop = (err) => {
        done();
        // Once the answer has been handed out, the way to report trouble is
        // through its body: whoever is reading it gets the error.
        if (!settle(reject, err) && response && !response.destroyed) response.destroy(err);
        try {
          request.abort();
        } catch {
          /* it was over already */
        }
      };
      onAbort = () => stop(aborted(signal));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      request.on('redirect', (_status, _method, to) => {
        // (has to be decided right here: a redirect that isn't followed
        // inside this call is dropped)
        if (allowed(to)) request.followRedirect();
        else stop(new Error(REDIRECTED));
      });
      request.on('response', (res) => {
        response = res;
        res.once('close', done);
        let answer;
        try {
          answer = new Response(NO_BODY.has(res.statusCode) ? null : Readable.toWeb(res), { status: res.statusCode });
        } catch (err) {
          stop(err); // an answer that isn't one (a status no web page could have)
          return;
        }
        settle(resolve, answer);
      });
      request.on('error', (err) => {
        if (settle(reject, err)) done();
      });
      request.end();
    });
  };
}

module.exports = { makeFetch, REDIRECTED };
