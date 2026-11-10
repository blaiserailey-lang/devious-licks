// Shared by the update tests: throw-away folders, packs on disk, and a tiny
// web server that plays the part of the project's GitHub releases.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = (name = 'dl-test-') => fs.mkdtempSync(path.join(os.tmpdir(), name));

// The files of one version, as { 'app.asar': contents, 'player/dl-player': contents }.
function describe(version, files, { electron = '45.2.3', needsApp = '0.3.2', notes = '' } = {}) {
  return {
    format: 1, version, electron, needsApp, notes,
    files: Object.entries(files).map(([to, body]) => ({
      name: path.basename(to), to, size: Buffer.byteLength(body), sha256: sha(body), exec: to.endsWith('dl-player'),
    })),
  };
}

// Writes a complete pack for `version` into the updates folder `dir`.
function makePack(dir, version, { electron = '45.2.3', files = { 'app.asar': `code ${version}`, 'player/dl-player': 'player' } } = {}) {
  const folder = path.join(dir, version);
  for (const [to, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, to)), { recursive: true });
    fs.writeFileSync(path.join(folder, to), body);
  }
  const manifest = describe(version, files, { electron });
  fs.writeFileSync(path.join(folder, 'pack.json'), JSON.stringify(manifest));
  return manifest;
}

// Serves whatever is in `routes` ({ '/update.json': body or (req, res) => ... })
// on 127.0.0.1 and counts the requests per path.
async function serve(routes) {
  const hits = {};
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    hits[url] = (hits[url] || 0) + 1;
    const route = routes[url];
    if (route === undefined) { res.writeHead(404); res.end('Not Found'); return; }
    if (typeof route === 'function') { route(req, res); return; }
    res.writeHead(200);
    res.end(route);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, hits, routes, close: () => new Promise((resolve) => server.close(resolve)) };
}

module.exports = { sha, tmp, describe, makePack, serve };
