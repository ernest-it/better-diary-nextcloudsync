/* WebDAV, as much of it as a diary needs: list a folder, read, write, delete, make a folder,
   and move a photo to or from a local file without it passing through JavaScript.

   Pure: the actual HTTP goes through `transport`, so the app hands it the native plugin and
   the tests hand it plain fetch() against a fake server. Every write is conditional — a
   PUT says which version it expects to replace (If-Match) or that it expects to replace
   nothing (If-None-Match: *) — which is what lets sync.js notice when a day changed on
   another device instead of quietly overwriting it.

   transport(request) -> { status, headers, text }
     request: { method, url, headers, body?, fromFile?, toFile? } */
const diaryDav = (() => {
  const encodePath = (path) => String(path || '')
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');

  const decodeEntities = (value) => String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');

  /* Nextcloud quotes its etags, and some proxies add a weak W/ in front. What matters is
     only whether two of them are the same, so they are compared bare. */
  const bareEtag = (value) => String(value || '').replace(/^W\//, '').replace(/"/g, '').trim();

  const header = (headers, name) => {
    if (!headers) return '';
    const wanted = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === wanted) return String(headers[key] == null ? '' : headers[key]);
    }
    return '';
  };

  /* A multistatus body, read with regular expressions rather than DOMParser so the same code
     runs under node in the tests. Namespace prefixes differ between servers (d:, D:, none),
     so every tag is matched with an optional prefix. */
  const tag = (name) => new RegExp(`<(?:[A-Za-z][\\w.-]*:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z][\\w.-]*:)?${name}>`, 'i');
  const RESPONSE_RE = /<(?:[A-Za-z][\w.-]*:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?response>/gi;
  const COLLECTION_RE = /<(?:[A-Za-z][\w.-]*:)?collection\s*\/?>/i;

  function parseMultistatus(xml) {
    const rows = [];
    for (const match of String(xml || '').matchAll(RESPONSE_RE)) {
      const block = match[1];
      const href = (tag('href').exec(block) || [])[1];
      if (!href) continue;
      /* Only the propstat that came back 200 describes the file; a 404 one lists the
         properties the server did not have. */
      let props = '';
      for (const stat of block.matchAll(/<(?:[A-Za-z][\w.-]*:)?propstat(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?propstat>/gi)) {
        const status = (tag('status').exec(stat[1]) || [])[1] || '';
        if (/\s200\s/.test(` ${status} `)) props += stat[1];
      }
      const modified = Date.parse(decodeEntities((tag('getlastmodified').exec(props) || [])[1] || ''));
      rows.push({
        href: decodeEntities(href.trim()),
        isDir: COLLECTION_RE.test(props),
        etag: bareEtag(decodeEntities((tag('getetag').exec(props) || [])[1] || '')),
        size: Number((tag('getcontentlength').exec(props) || [])[1]) || 0,
        mtimeMs: Number.isFinite(modified) ? modified : 0
      });
    }
    return rows;
  }

  const PROPFIND_BODY = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<d:propfind xmlns:d="DAV:"><d:prop>'
    + '<d:resourcetype/><d:getetag/><d:getcontentlength/><d:getlastmodified/>'
    + '</d:prop></d:propfind>';

  class DavError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  const describe = (status) => {
    if (status === 0) return 'Nextcloud could not be reached';
    if (status === 401) return 'Nextcloud did not accept the login — sign in again';
    if (status === 403) return 'Nextcloud refused access to the diary folder';
    if (status === 404) return 'The diary folder is not on the server any more';
    if (status === 507) return 'Your Nextcloud storage is full';
    if (status >= 500) return `Nextcloud had a problem (${status})`;
    return `Nextcloud answered ${status}`;
  };

  /* `root` is the WebDAV URL of the user's files, e.g.
     https://cloud.example.com/remote.php/dav/files/alice — every path below is relative to it. */
  function create({ transport, root }) {
    const base = String(root || '').replace(/\/+$/, '');
    const urlFor = (path) => `${base}/${encodePath(path)}`;
    /* The href a PROPFIND hands back is a path on the server; this is the same thing for a
       path of ours, so the two can be compared to strip the listing down to names. */
    let basePath = '';
    try { basePath = decodeURIComponent(new URL(base).pathname).replace(/\/+$/, ''); } catch { basePath = ''; }

    async function send(request) {
      let reply;
      try {
        reply = await transport(request);
      } catch (error) {
        throw new DavError((error && error.message) || describe(0), 0);
      }
      return { status: Number(reply && reply.status) || 0, headers: (reply && reply.headers) || {}, text: String((reply && reply.text) || '') };
    }

    const etagOf = (reply) => bareEtag(header(reply.headers, 'oc-etag') || header(reply.headers, 'etag'));

    /* The folder itself and its direct children, each with a name relative to `path`.
       Returns null when the folder does not exist, which is an answer, not a failure. */
    async function list(path) {
      const reply = await send({
        method: 'PROPFIND',
        url: `${urlFor(path)}/`,
        headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY
      });
      if (reply.status === 404) return null;
      if (reply.status !== 207) throw new DavError(describe(reply.status), reply.status);
      const folder = `${basePath}/${String(path || '').split('/').filter(Boolean).join('/')}`.replace(/\/+$/, '');
      const out = [];
      for (const row of parseMultistatus(reply.text)) {
        let href = row.href;
        try { href = decodeURIComponent(new URL(href, 'http://x').pathname); } catch { /* keep it as it came */ }
        href = href.replace(/\/+$/, '');
        if (href === folder) continue;
        const name = href.slice(href.lastIndexOf('/') + 1);
        if (!name) continue;
        out.push({ name, isDir: row.isDir, etag: row.etag, size: row.size, mtimeMs: row.mtimeMs });
      }
      return out;
    }

    async function getText(path) {
      const reply = await send({ method: 'GET', url: urlFor(path), headers: {} });
      if (reply.status === 404) return null;
      if (reply.status !== 200) throw new DavError(describe(reply.status), reply.status);
      return { text: reply.text, etag: etagOf(reply) };
    }

    /* `expect` is the etag we believe is on the server, or null for "there should be
       nothing there yet". Returns { ok, etag } or { ok: false, conflict: true } when the
       server holds something other than what we expected. */
    async function putText(path, text, expect) {
      const headers = { 'Content-Type': 'text/markdown; charset=utf-8' };
      if (expect) headers['If-Match'] = `"${expect}"`;
      else headers['If-None-Match'] = '*';
      const reply = await send({ method: 'PUT', url: urlFor(path), headers, body: String(text) });
      if (reply.status === 412) return { ok: false, conflict: true };
      if (reply.status < 200 || reply.status >= 300) throw new DavError(describe(reply.status), reply.status);
      return { ok: true, etag: etagOf(reply) };
    }

    /* Nextcloud puts deleted files in its own trash bin, so this is the phone's equivalent
       of the desktop moving things to the system trash. */
    async function remove(path, expect) {
      const headers = {};
      if (expect) headers['If-Match'] = `"${expect}"`;
      const reply = await send({ method: 'DELETE', url: urlFor(path), headers });
      if (reply.status === 412) return { ok: false, conflict: true };
      if (reply.status === 404) return { ok: true, missing: true };
      if (reply.status < 200 || reply.status >= 300) throw new DavError(describe(reply.status), reply.status);
      return { ok: true };
    }

    /* Each missing level in turn, so Notes/Diary can be made on an account with no Notes. */
    async function makeFolders(path) {
      const parts = String(path || '').split('/').filter(Boolean);
      for (let depth = 1; depth <= parts.length; depth++) {
        const reply = await send({ method: 'MKCOL', url: urlFor(parts.slice(0, depth).join('/')), headers: {} });
        /* 405: it is already there. */
        if (reply.status !== 201 && reply.status !== 405) throw new DavError(describe(reply.status), reply.status);
      }
    }

    async function download(path, toFile) {
      const reply = await send({ method: 'GET', url: urlFor(path), headers: {}, toFile });
      if (reply.status === 404) return { ok: false, missing: true };
      if (reply.status !== 200) throw new DavError(describe(reply.status), reply.status);
      return { ok: true, etag: etagOf(reply) };
    }

    /* A photo is never overwritten: its name is new, and if somehow it is not, the one on
       the server wins and this one is reported rather than replacing it. */
    async function upload(path, fromFile, contentType) {
      const headers = { 'If-None-Match': '*', 'Content-Type': contentType || 'application/octet-stream' };
      const reply = await send({ method: 'PUT', url: urlFor(path), headers, fromFile });
      if (reply.status === 412) return { ok: false, conflict: true };
      if (reply.status < 200 || reply.status >= 300) throw new DavError(describe(reply.status), reply.status);
      return { ok: true, etag: etagOf(reply) };
    }

    return { list, getText, putText, remove, makeFolders, download, upload, urlFor };
  }

  return { create, parseMultistatus, encodePath, bareEtag, DavError };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = diaryDav;
if (typeof window !== 'undefined') window.diaryDav = diaryDav;
