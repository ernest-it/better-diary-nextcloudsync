/* The phone app's sync, end to end: the real dav.js and sync.js, talking HTTP to the fake
   Nextcloud in mobile/tools, with the phone's folder and the server's folder both real
   temporary directories. "Another device" is the test writing straight into the server's
   folder, which is exactly what the desktop app does through the Nextcloud client. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const diaryDav = require('../mobile/src/dav.js');
const diarySync = require('../mobile/src/sync.js');
const fake = require('../mobile/tools/fake-nextcloud.js');

const FOLDER = 'Notes/Diary';
const ENTRY = (words) => `# Friday, 18 September 2026\n\n## Notes\n\n${words}\n`;

/* What the native plugin does on the phone, done with fetch and the filesystem. */
function transportFor(server, phoneDir) {
  const auth = `Basic ${Buffer.from(`${server.user}:${server.password}`).toString('base64')}`;
  return async ({ method, url, headers, body, fromFile, toFile }) => {
    const init = { method, headers: { ...headers, Authorization: auth } };
    if (body != null) init.body = body;
    if (fromFile) init.body = await fs.readFile(path.join(phoneDir, fromFile));
    const reply = await fetch(url, init);
    const out = { status: reply.status, headers: Object.fromEntries(reply.headers.entries()), text: '' };
    if (toFile && reply.status === 200) await fs.writeFile(path.join(phoneDir, toFile), Buffer.from(await reply.arrayBuffer()));
    else out.text = await reply.text();
    return out;
  };
}

function localFolder(dir) {
  const full = (rel) => path.join(dir, ...rel.split('/'));
  return {
    async list() {
      const out = [];
      for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
        if (!dirent.isFile()) continue;
        const stats = await fs.stat(full(dirent.name));
        out.push({ name: dirent.name, size: stats.size, mtimeMs: stats.mtimeMs });
      }
      return out;
    },
    async readText(name) { try { return await fs.readFile(full(name), 'utf8'); } catch { return null; } },
    async writeText(name, text) { await fs.writeFile(full(name), text); },
    async remove(name) { await fs.rm(full(name), { force: true }); },
    async removeDir(rel) { await fs.rm(full(rel), { recursive: true, force: true }); },
    async makeDir(rel) { await fs.mkdir(full(rel), { recursive: true }); },
    async exists(rel) { try { await fs.stat(full(rel)); return true; } catch { return false; } },
    async stat(rel) { try { const s = await fs.stat(full(rel)); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } },
    fileRef: (rel) => rel,
    typeOf: () => 'image/jpeg'
  };
}

async function setup() {
  const serverDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-server-'));
  const phoneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-phone-'));
  const diaryDir = path.join(serverDir, 'Notes', 'Diary');
  await fs.mkdir(diaryDir, { recursive: true });
  const server = await fake.start({ root: serverDir });
  const dav = diaryDav.create({ transport: transportFor(server, phoneDir), root: server.davRoot });
  let saved = null;
  const store = { load: async () => saved, save: async (value) => { saved = value; } };
  const local = localFolder(phoneDir);
  const sync = diarySync.create({ dav, local, store, folder: FOLDER });
  const onServer = (name) => fs.readFile(path.join(diaryDir, name), 'utf8').catch(() => null);
  const onPhone = (name) => fs.readFile(path.join(phoneDir, name), 'utf8').catch(() => null);
  /* A later write from "the other device": the fake server's etag includes the mtime, so
     make sure it moves even on a fast machine. */
  const elsewhere = async (name, text) => {
    await fs.writeFile(path.join(diaryDir, name), text);
    const later = new Date(Date.now() + 5000);
    await fs.utimes(path.join(diaryDir, name), later, later);
  };
  const t = { server, dav, sync, local, phoneDir, diaryDir, onServer, onPhone, elsewhere, store,
    close: () => server.close() };
  return t;
}

test('the multistatus parser reads names, folders and etags whatever the namespace prefix', () => {
  const xml = '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/remote.php/dav/files/a/Notes/Diary/2026-09-18.md</D:href>'
    + '<D:propstat><D:prop><D:resourcetype/><D:getetag>"abc"</D:getetag><D:getcontentlength>12</D:getcontentlength></D:prop>'
    + '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
    + '<D:response><D:href>/remote.php/dav/files/a/Notes/Diary/2026-09-18-assets/</D:href>'
    + '<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype><D:getetag>W/"def"</D:getetag></D:prop>'
    + '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>';
  const rows = diaryDav.parseMultistatus(xml);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual([rows[0].isDir, rows[0].etag, rows[0].size], [false, 'abc', 12]);
  assert.deepStrictEqual([rows[1].isDir, rows[1].etag], [true, 'def']);
});

test('paths with spaces and non-ASCII names survive the round trip', async () => {
  const t = await setup();
  try {
    await t.dav.makeFolders('Notes/Diary/Ünïcode folder');
    const listing = await t.dav.list('Notes/Diary');
    assert.ok(listing.some(row => row.isDir && row.name === 'Ünïcode folder'));
  } finally { await t.close(); }
});

test('a missing folder lists as null rather than failing', async () => {
  const t = await setup();
  try {
    assert.strictEqual(await t.dav.list('Nope/Nothing'), null);
    await t.dav.makeFolders('Nope/Nothing');
    assert.deepStrictEqual(await t.dav.list('Nope/Nothing'), []);
  } finally { await t.close(); }
});

test('entries already on the server come down to the phone', async () => {
  const t = await setup();
  try {
    await t.elsewhere('2026-09-18.md', ENTRY('from the laptop'));
    await fs.writeFile(path.join(t.diaryDir, 'README.md'), 'not an entry');
    const result = await t.sync.sync();
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.changed, ['2026-09-18']);
    assert.strictEqual(await t.onPhone('2026-09-18.md'), ENTRY('from the laptop'));
    assert.strictEqual(await t.onPhone('README.md'), null);
  } finally { await t.close(); }
});

test('an entry written on the phone goes up, and a second pass has nothing to do', async () => {
  const t = await setup();
  try {
    await t.sync.writeEntry('2026-09-18.md', ENTRY('on the bus'));
    assert.strictEqual((await t.sync.sync()).ok, true);
    assert.strictEqual(await t.onServer('2026-09-18.md'), ENTRY('on the bus'));
    const again = await t.sync.sync();
    assert.deepStrictEqual(again.changed, []);
  } finally { await t.close(); }
});

test('an edit on the phone replaces the version the server had', async () => {
  const t = await setup();
  try {
    await t.elsewhere('2026-09-18.md', ENTRY('first'));
    await t.sync.sync();
    await t.sync.writeEntry('2026-09-18.md', ENTRY('first, then more'));
    await t.sync.sync();
    assert.strictEqual(await t.onServer('2026-09-18.md'), ENTRY('first, then more'));
  } finally { await t.close(); }
});

test('an edit made elsewhere reaches a phone that has not touched the day', async () => {
  const t = await setup();
  try {
    await t.elsewhere('2026-09-18.md', ENTRY('first'));
    await t.sync.sync();
    await t.elsewhere('2026-09-18.md', ENTRY('changed on the laptop'));
    const result = await t.sync.sync();
    assert.deepStrictEqual(result.changed, ['2026-09-18']);
    assert.strictEqual(await t.onPhone('2026-09-18.md'), ENTRY('changed on the laptop'));
  } finally { await t.close(); }
});

test('the same day written in both places is held as a conflict and nothing is overwritten', async () => {
  const t = await setup();
  try {
    await t.elsewhere('2026-09-18.md', ENTRY('first'));
    await t.sync.sync();
    await t.sync.writeEntry('2026-09-18.md', ENTRY('phone version'));
    await t.elsewhere('2026-09-18.md', ENTRY('laptop version'));

    const result = await t.sync.sync();
    assert.deepStrictEqual(result.conflicts, ['2026-09-18']);
    assert.strictEqual(await t.onPhone('2026-09-18.md'), ENTRY('phone version'));
    assert.strictEqual(await t.onServer('2026-09-18.md'), ENTRY('laptop version'));
    assert.strictEqual(await t.sync.conflictFor('2026-09-18.md'), ENTRY('laptop version'));

    /* Held means held: more passes, more phone edits, still nothing goes up. */
    await t.sync.writeEntry('2026-09-18.md', ENTRY('phone version, still typing'));
    await t.sync.sync();
    assert.strictEqual(await t.onServer('2026-09-18.md'), ENTRY('laptop version'));
  } finally { await t.close(); }
});

test('keeping mine uploads the phone version over the one that arrived', async () => {
  const t = await setup();
  try {
    await t.elsewhere('2026-09-18.md', ENTRY('first'));
    await t.sync.sync();
    await t.sync.writeEntry('2026-09-18.md', ENTRY('phone version'));
    await t.elsewhere('2026-09-18.md', ENTRY('laptop version'));
    await t.sync.sync();

    await t.sync.resolve('2026-09-18.md', 'mine');
    await t.sync.sync();
    assert.strictEqual(await t.onServer('2026-09-18.md'), ENTRY('phone version'));
    assert.strictEqual(await t.sync.conflictFor('2026-09-18.md'), null);
  } finally { await t.close(); }
});

test('taking theirs puts the arrived version on the phone and uploads nothing', async () => {
  const t = await setup();
  try {
    await t.elsewhere('2026-09-18.md', ENTRY('first'));
    await t.sync.sync();
    await t.sync.writeEntry('2026-09-18.md', ENTRY('phone version'));
    await t.elsewhere('2026-09-18.md', ENTRY('laptop version'));
    await t.sync.sync();

    await t.sync.resolve('2026-09-18.md', 'theirs');
    assert.strictEqual(await t.onPhone('2026-09-18.md'), ENTRY('laptop version'));
    await t.sync.sync();
    assert.strictEqual(await t.onServer('2026-09-18.md'), ENTRY('laptop version'));
  } finally { await t.close(); }
});

test('keeping mine still refuses to overwrite a third version that arrived meanwhile', async () => {
  const t = await setup();
  try {
    await t.elsewhere('2026-09-18.md', ENTRY('first'));
    await t.sync.sync();
    await t.sync.writeEntry('2026-09-18.md', ENTRY('phone version'));
    await t.elsewhere('2026-09-18.md', ENTRY('laptop version'));
    await t.sync.sync();
    await t.sync.resolve('2026-09-18.md', 'mine');
    await t.elsewhere('2026-09-18.md', ENTRY('tablet version'));

    const result = await t.sync.sync();
    assert.strictEqual(await t.onServer('2026-09-18.md'), ENTRY('tablet version'));
    /* The refused upload surfaces as a fresh conflict on the pass after. */
    const next = await t.sync.sync();
    assert.ok(result.conflicts.concat(next.conflicts).includes('2026-09-18'));
    assert.strictEqual(await t.sync.conflictFor('2026-09-18.md'), ENTRY('tablet version'));
  } finally { await t.close(); }
});

test('a day deleted on the phone is deleted on the server, with its photos', async () => {
  const t = await setup();
  try {
    await t.elsewhere('2026-09-18.md', ENTRY('first'));
    await fs.mkdir(path.join(t.diaryDir, '2026-09-18-assets'));
    await fs.writeFile(path.join(t.diaryDir, '2026-09-18-assets', 'photo-1.jpg'), 'jpeg');
    await t.sync.sync();
    await t.sync.deleteEntry('2026-09-18.md');
    await t.sync.sync();
    assert.strictEqual(await t.onServer('2026-09-18.md'), null);
    await assert.rejects(fs.stat(path.join(t.diaryDir, '2026-09-18-assets')));
  } finally { await t.close(); }
});

test('a day deleted elsewhere disappears from the phone if it was not edited there', async () => {
  const t = await setup();
  try {
    await t.elsewhere('2026-09-18.md', ENTRY('first'));
    await t.sync.sync();
    await fs.rm(path.join(t.diaryDir, '2026-09-18.md'));
    const result = await t.sync.sync();
    assert.deepStrictEqual(result.changed, ['2026-09-18']);
    assert.strictEqual(await t.onPhone('2026-09-18.md'), null);
  } finally { await t.close(); }
});

test('deleted in one place and edited in the other, the edit wins', async () => {
  const t = await setup();
  try {
    await t.elsewhere('2026-09-18.md', ENTRY('first'));
    await t.sync.sync();
    await fs.rm(path.join(t.diaryDir, '2026-09-18.md'));
    await t.sync.writeEntry('2026-09-18.md', ENTRY('edited on the phone'));
    await t.sync.sync();
    assert.strictEqual(await t.onServer('2026-09-18.md'), ENTRY('edited on the phone'));

    await t.sync.deleteEntry('2026-09-18.md');
    await t.elsewhere('2026-09-18.md', ENTRY('edited on the laptop'));
    await t.sync.sync();
    assert.strictEqual(await t.onPhone('2026-09-18.md'), ENTRY('edited on the laptop'));
  } finally { await t.close(); }
});

test('offline, writes stay on the phone and go up once the server is back', async () => {
  const t = await setup();
  try {
    await t.sync.sync();
    const port = t.server.port;
    await t.server.close();

    await t.sync.writeEntry('2026-09-18.md', ENTRY('written in a tunnel'));
    const offline = await t.sync.sync();
    assert.strictEqual(offline.ok, false);
    assert.strictEqual(offline.offline, true);
    assert.strictEqual(await t.onPhone('2026-09-18.md'), ENTRY('written in a tunnel'));

    /* Same folder, same port: the server coming back. */
    const back = await fake.start({ root: path.dirname(path.dirname(t.diaryDir)), port });
    try {
      assert.strictEqual((await t.sync.sync()).ok, true);
      assert.strictEqual(await t.onServer('2026-09-18.md'), ENTRY('written in a tunnel'));
    } finally { await back.close(); }
  } finally { /* already closed */ }
});

test('photos queue for upload, and removing one before it went up just cancels it', async () => {
  const t = await setup();
  try {
    await fs.mkdir(path.join(t.phoneDir, '2026-09-18-assets'));
    await fs.writeFile(path.join(t.phoneDir, '2026-09-18-assets', 'photo-a.jpg'), 'aaa');
    await fs.writeFile(path.join(t.phoneDir, '2026-09-18-assets', 'photo-b.jpg'), 'bbb');
    await t.sync.queuePhoto('upload', '2026-09-18-assets/photo-a.jpg');
    await t.sync.queuePhoto('upload', '2026-09-18-assets/photo-b.jpg');
    await fs.rm(path.join(t.phoneDir, '2026-09-18-assets', 'photo-b.jpg'));
    await t.sync.queuePhoto('delete', '2026-09-18-assets/photo-b.jpg');
    await t.sync.sync();

    assert.strictEqual(await fs.readFile(path.join(t.diaryDir, '2026-09-18-assets', 'photo-a.jpg'), 'utf8'), 'aaa');
    await assert.rejects(fs.stat(path.join(t.diaryDir, '2026-09-18-assets', 'photo-b.jpg')));
    assert.strictEqual((await t.sync._state()).queue.length, 0);
  } finally { await t.close(); }
});

test('photos come down only when asked for, and only once', async () => {
  const t = await setup();
  try {
    await fs.mkdir(path.join(t.diaryDir, '2026-09-18-assets'));
    await fs.writeFile(path.join(t.diaryDir, '2026-09-18-assets', 'photo-1.jpg'), 'jpeg bytes');
    await t.elsewhere('2026-09-18.md', `${ENTRY('look')}\n![](2026-09-18-assets/photo-1.jpg)\n`);
    await t.sync.sync();
    await assert.rejects(fs.stat(path.join(t.phoneDir, '2026-09-18-assets', 'photo-1.jpg')));

    assert.deepStrictEqual(await t.sync.ensurePhotos(['2026-09-18-assets/photo-1.jpg']), ['2026-09-18-assets/photo-1.jpg']);
    assert.strictEqual(await fs.readFile(path.join(t.phoneDir, '2026-09-18-assets', 'photo-1.jpg'), 'utf8'), 'jpeg bytes');
    assert.deepStrictEqual(await t.sync.ensurePhotos(['2026-09-18-assets/photo-1.jpg']), []);
  } finally { await t.close(); }
});

test('Login Flow v2 hands over an app password once access is granted, and only once', async () => {
  const serverDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diary-server-'));
  const server = await fake.start({ root: serverDir });
  try {
    const start = await (await fetch(`${server.url}/index.php/login/v2`, { method: 'POST' })).json();
    const poll = () => fetch(start.poll.endpoint, { method: 'POST', body: `token=${start.poll.token}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.strictEqual((await poll()).status, 404);
    server.grant(start.poll.token);
    const granted = await poll();
    assert.strictEqual(granted.status, 200);
    assert.strictEqual((await granted.json()).appPassword, server.password);
    assert.strictEqual((await poll()).status, 404);
  } finally { await server.close(); }
});

test('a Nextcloud address is read however it was typed or pasted', () => {
  const { normaliseServer } = require('../mobile/src/setup.js');
  assert.strictEqual(normaliseServer('cloud.example.com'), 'https://cloud.example.com');
  assert.strictEqual(normaliseServer('  https://cloud.example.com/  '), 'https://cloud.example.com');
  assert.strictEqual(normaliseServer('https://cloud.example.com/apps/files/?dir=/Notes'), 'https://cloud.example.com');
  assert.strictEqual(normaliseServer('https://example.com/nextcloud/index.php/apps/dashboard/'), 'https://example.com/nextcloud');
  assert.strictEqual(normaliseServer('http://10.0.2.2:8480'), 'http://10.0.2.2:8480');
  assert.strictEqual(normaliseServer('ftp://nope'), '');
  assert.strictEqual(normaliseServer(''), '');
});
