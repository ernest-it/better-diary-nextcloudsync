/* A stand-in Nextcloud, just big enough to develop and test the phone app against without a
   real server or real credentials: Login Flow v2, the current-user OCS call, and the
   WebDAV verbs the app uses, with etags and conditional writes that behave like the real
   thing. Files live in an ordinary folder, so "another device" is just an editor.

     node mobile/tools/fake-nextcloud.js <folder> [port]

   From the Android emulator the host is http://10.0.2.2:<port>. The tests start it on a
   random port through start(). */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const USER = 'alice';

function etagFor(stats, extra) {
  return crypto.createHash('md5').update(`${stats.mtimeMs}:${stats.size}:${extra || ''}`).digest('hex').slice(0, 16);
}

const xmlEscape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function start({ root, port = 0, password = 'fake-app-password', log = false } = {}) {
  const flows = new Map();   // token -> { granted, claimed }
  const davPrefix = `/remote.php/dav/files/${USER}`;

  const baseOf = (req) => `http://${req.headers.host}`;
  const authorised = (req) => req.headers.authorization === `Basic ${Buffer.from(`${USER}:${password}`).toString('base64')}`;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Length': Buffer.byteLength(body || ''), ...headers });
    res.end(body || '');
  };

  /* A folder's etag moves whenever anything inside it does, like Nextcloud's. */
  async function etagOf(full, stats) {
    if (!stats.isDirectory()) {
      const content = await fsp.readFile(full);
      return crypto.createHash('md5').update(content).update(String(stats.mtimeMs)).digest('hex').slice(0, 16);
    }
    const names = (await fsp.readdir(full)).sort();
    let joined = '';
    for (const name of names) {
      const child = path.join(full, name);
      joined += `${name}:${await etagOf(child, await fsp.stat(child))};`;
    }
    return etagFor(stats, joined);
  }

  async function propEntry(href, full) {
    const stats = await fsp.stat(full);
    const etag = await etagOf(full, stats);
    const isDir = stats.isDirectory();
    return '<d:response>'
      + `<d:href>${xmlEscape(href)}</d:href>`
      + '<d:propstat><d:prop>'
      + (isDir ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>')
      + `<d:getetag>&quot;${etag}&quot;</d:getetag>`
      + (isDir ? '' : `<d:getcontentlength>${stats.size}</d:getcontentlength>`)
      + `<d:getlastmodified>${new Date(stats.mtimeMs).toUTCString()}</d:getlastmodified>`
      + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>'
      + '<d:propstat><d:prop><oc:fileid/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>'
      + '</d:response>';
  }

  const encodeHref = (rel) => `${davPrefix}/${rel.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;

  async function dav(req, res, rel) {
    const full = path.join(root, ...rel.split('/').filter(Boolean));
    if (!path.resolve(full).startsWith(path.resolve(root))) return send(res, 403);
    let stats = null;
    try { stats = await fsp.stat(full); } catch { stats = null; }
    const current = stats ? await etagOf(full, stats) : null;
    const ifMatch = String(req.headers['if-match'] || '').replace(/"/g, '').trim();
    const ifNoneMatch = String(req.headers['if-none-match'] || '').trim();

    switch (req.method) {
      case 'PROPFIND': {
        await readBody(req);
        if (!stats) return send(res, 404);
        let body = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">';
        body += await propEntry(encodeHref(rel) + (stats.isDirectory() ? '/' : ''), full);
        if (stats.isDirectory() && req.headers.depth !== '0') {
          for (const name of (await fsp.readdir(full)).sort()) {
            const child = path.join(full, name);
            const childStats = await fsp.stat(child);
            body += await propEntry(encodeHref(`${rel}/${name}`) + (childStats.isDirectory() ? '/' : ''), child);
          }
        }
        body += '</d:multistatus>';
        return send(res, 207, body, { 'Content-Type': 'application/xml; charset=utf-8' });
      }
      case 'GET': {
        if (!stats || stats.isDirectory()) return send(res, 404);
        const content = await fsp.readFile(full);
        res.writeHead(200, { 'Content-Length': content.length, ETag: `"${current}"` });
        return res.end(content);
      }
      case 'PUT': {
        const body = await readBody(req);
        if (ifNoneMatch === '*' && stats) return send(res, 412);
        if (ifMatch && ifMatch !== current) return send(res, 412);
        try { await fsp.stat(path.dirname(full)); } catch { return send(res, 409); }
        await fsp.writeFile(full, body);
        const after = await etagOf(full, await fsp.stat(full));
        return send(res, stats ? 204 : 201, '', { ETag: `"${after}"`, 'OC-ETag': `"${after}"` });
      }
      case 'DELETE': {
        if (!stats) return send(res, 404);
        if (ifMatch && ifMatch !== current) return send(res, 412);
        await fsp.rm(full, { recursive: true, force: true });
        return send(res, 204);
      }
      case 'MKCOL': {
        if (stats) return send(res, 405);
        try { await fsp.mkdir(full); } catch { return send(res, 409); }
        return send(res, 201);
      }
      default:
        return send(res, 405);
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (log) console.log(req.method, decodeURIComponent(url.pathname));

      if (req.method === 'POST' && url.pathname === '/index.php/login/v2') {
        const token = crypto.randomBytes(16).toString('hex');
        flows.set(token, { granted: false, claimed: false });
        return send(res, 200, JSON.stringify({
          poll: { token, endpoint: `${baseOf(req)}/index.php/login/v2/poll` },
          login: `${baseOf(req)}/login/v2/flow/${token}`
        }), { 'Content-Type': 'application/json' });
      }
      if (req.method === 'POST' && url.pathname === '/index.php/login/v2/poll') {
        const token = new URLSearchParams((await readBody(req)).toString()).get('token');
        const flow = flows.get(token);
        if (!flow || !flow.granted || flow.claimed) return send(res, 404, '[]');
        flow.claimed = true;
        return send(res, 200, JSON.stringify({ server: baseOf(req), loginName: USER, appPassword: password }),
          { 'Content-Type': 'application/json' });
      }
      const page = /^\/login\/v2\/(flow|grant)\/([0-9a-f]+)$/.exec(url.pathname);
      if (page && flows.has(page[2])) {
        if (page[1] === 'grant') flows.get(page[2]).granted = true;
        const html = page[1] === 'grant'
          ? '<h1>Access granted</h1><p>Go back to daily-diary.</p>'
          : `<h1>Fake Nextcloud</h1><p>daily-diary wants to connect.</p><p><a id="grant" href="/login/v2/grant/${page[2]}">Grant access</a></p>`;
        return send(res, 200, `<!doctype html><meta name="viewport" content="width=device-width">${html}`, { 'Content-Type': 'text/html' });
      }
      if (url.pathname.startsWith('/ocs/v2.php/cloud/user')) {
        if (!authorised(req)) return send(res, 401);
        return send(res, 200, JSON.stringify({ ocs: { meta: { status: 'ok' }, data: { id: USER, 'display-name': 'Alice' } } }),
          { 'Content-Type': 'application/json' });
      }
      if (url.pathname === '/status.php') {
        return send(res, 200, JSON.stringify({ installed: true, productname: 'Nextcloud', version: '31.0.0' }),
          { 'Content-Type': 'application/json' });
      }
      if (url.pathname === davPrefix || url.pathname.startsWith(`${davPrefix}/`)) {
        if (!authorised(req)) return send(res, 401);
        const rel = decodeURIComponent(url.pathname.slice(davPrefix.length));
        return await dav(req, res, rel);
      }
      return send(res, 404);
    } catch (error) {
      if (log) console.error(error);
      return send(res, 500);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        davRoot: `http://127.0.0.1:${actual}${davPrefix}`,
        user: USER,
        password,
        port: actual,
        /* The tests' stand-in for someone tapping "Grant access" in the browser. */
        grant: (token) => { const flow = flows.get(token); if (flow) flow.granted = true; },
        close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); })
      });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || 'fake-nextcloud-files');
  const port = Number(process.argv[3]) || 8480;
  fs.mkdirSync(root, { recursive: true });
  start({ root, port, log: true }).then(({ port: actual }) => {
    console.log(`fake Nextcloud serving ${root}`);
    console.log(`  from this machine:   http://127.0.0.1:${actual}`);
    console.log(`  from the emulator:   http://10.0.2.2:${actual}`);
  });
}
