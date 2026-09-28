/* The only module that touches diary files on disk.

   The layout is deliberately boring, because the folder is meant to be shared with your
   Nextcloud client and read by Nextcloud Notes, your phone, and any text editor:

     <diary>/2026-09-18.md
     <diary>/2026-09-19.md

   One file per day, named for the day, and nothing else. No index, no database, no dotfile —
   losing this app must not cost you anything but the app. Anything in the folder that is not
   named YYYY-MM-DD.md is ignored and never written to, which is also what keeps Nextcloud's
   "(conflicted copy)" files out of the way instead of showing up as phantom entries. */
'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const entryModel = require('./entry.js');

/* Electron is only present inside the app; requiring this file from plain node must not throw. */
function electron() {
  try {
    const mod = require('electron');
    return mod && typeof mod === 'object' ? mod : {};
  } catch {
    return {};
  }
}

let root = '';
const recentWrites = new Map();
const chains = new Map();

/* ---------------------------------------------------------------- self-writes */

function remember(file) {
  recentWrites.set(path.resolve(file).toLowerCase(), Date.now() + 4000);
}

/* Consumed by the watcher in main.js: true when the app itself just wrote this path, so our
   own autosave is never mistaken for an edit arriving from another device. */
function wasSelfWrite(file) {
  const key = path.resolve(String(file || '')).toLowerCase();
  const now = Date.now();
  for (const [entry, expiry] of recentWrites) if (expiry < now) recentWrites.delete(entry);
  return recentWrites.has(key);
}

/* Serialises work per file, so two autosaves of the same day cannot interleave their
   temp-file-and-rename dance and land in the wrong order. */
function queue(key, task) {
  const previous = chains.get(key) || Promise.resolve();
  const run = previous.then(task, task);
  chains.set(key, run.then(() => {}, () => {}));
  return run;
}

async function flush() {
  for (let pass = 0; pass < 3 && chains.size; pass++) {
    await Promise.allSettled([...chains.values()]);
    chains.clear();
  }
}

/* ---------------------------------------------------------------- paths */

const getDiaryPath = () => root;

function setDiaryPath(next) {
  const resolved = typeof next === 'string' && next.trim() ? path.resolve(next) : '';
  root = resolved || defaultDiaryPath();
  return root;
}

/* Picks the folder that is most likely already syncing. Only the *parent* has to exist —
   the diary folder itself is created on first run — so a fresh Nextcloud install with a
   Notes folder gets Notes/Diary without anybody being asked anything. */
function defaultDiaryPath() {
  const home = os.homedir();
  const candidates = [
    [path.join(home, 'Nextcloud', 'Notes'), 'Diary'],
    [path.join(home, 'Nextcloud'), 'Diary'],
    [path.join(home, 'ownCloud', 'Notes'), 'Diary'],
    [path.join(home, 'Documents'), 'diary']
  ];
  for (const [parent, name] of candidates) {
    try {
      if (require('fs').statSync(parent).isDirectory()) return path.join(parent, name);
    } catch {
      // Not installed on this machine; try the next one.
    }
  }
  return path.join(home, 'Documents', 'diary');
}

const fileFor = (id) => {
  const name = entryModel.fileNameFor(id);
  if (!name) throw new Error('That is not a diary date');
  if (!root) throw new Error('No diary folder is set');
  return path.join(root, name);
};

async function ensureDiary() {
  if (!root) setDiaryPath('');
  await fs.mkdir(root, { recursive: true });
  return root;
}

/* ---------------------------------------------------------------- reading */

/* Every entry's date, size and mtime, and nothing else — this is what the calendar, the
   "recent" list and the search index's staleness check are built on, and it stays cheap
   even after a few thousand days. */
async function list() {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const dirent of entries) {
    if (dirent.isDirectory()) continue;
    const id = entryModel.idFromFileName(dirent.name);
    if (!id) continue;
    try {
      const stats = await fs.stat(path.join(root, dirent.name));
      items.push({ id, mtimeMs: stats.mtimeMs, size: stats.size });
    } catch {
      // Vanished between readdir and stat — a sync client moving it into place. Next pass.
    }
  }
  items.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return items;
}

/* `exists: false` is an ordinary answer, not an error: most days you open have never been
   written to, and the renderer scaffolds them from your headings. */
async function read(id) {
  const file = fileFor(id);
  try {
    const [markdown, stats] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { id, exists: true, markdown, mtimeMs: stats.mtimeMs };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { id, exists: false, markdown: '', mtimeMs: 0 };
    throw error;
  }
}

/* Batched so the renderer can refresh its search index for the handful of days that changed
   without a round trip each. */
async function readMany(ids) {
  const wanted = (Array.isArray(ids) ? ids : []).filter(entryModel.isId).slice(0, 4000);
  const out = [];
  for (const id of wanted) {
    try {
      out.push(await read(id));
    } catch {
      // Unreadable today; the next refresh will pick it up.
    }
  }
  return out;
}

/* ---------------------------------------------------------------- writing */

async function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  let handle = null;
  try {
    handle = await fs.open(tmp, 'w');
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
  remember(tmp);
  remember(file);
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/* An entry with nothing written in it is not saved — opening tomorrow to see what the
   headings look like should not leave an empty file for the sync client to carry around.
   If the day already had a file and you empty it out, the file stays; deleting it is an
   explicit choice, made from the menu. */
async function write(id, markdown) {
  const file = fileFor(id);
  const text = String(markdown == null ? '' : markdown);
  const parsed = entryModel.parse(text, id);
  if (entryModel.isBlank(parsed)) {
    const current = await read(id);
    if (!current.exists) return { path: file, written: false, mtimeMs: 0 };
  }
  return queue(file.toLowerCase(), async () => {
    await writeFileAtomic(file, text);
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.stat(file)).mtimeMs;
    } catch {
      // The write succeeded; not being able to stat it afterwards is not worth failing over.
    }
    return { path: file, written: true, mtimeMs };
  });
}

/* To the system trash, never straight to oblivion — a diary is the last thing that should
   be unrecoverable because of a misclick. */
async function remove(id) {
  /* The photos go first: if trashing the entry fails, a day with no pictures is a smaller
     surprise than pictures with no day. */
  try {
    await removeAssetDir(id);
  } catch {
    // No photos, or they could not be moved; removing the entry is still worth doing.
  }
  const file = fileFor(id);
  const { shell } = electron();
  if (shell && typeof shell.trashItem === 'function') {
    try {
      await shell.trashItem(file);
      return { path: file, trashed: true };
    } catch {
      // No trash on this filesystem (a network mount, some Linux setups): fall through.
    }
  }
  await fs.rm(file, { force: true });
  return { path: file, trashed: false };
}

/* ---------------------------------------------------------------- photos

   A day's photos live in `<date>-assets/` beside `<date>.md`, referenced from the entry by
   a plain relative path: `![by the water](2026-09-20-assets/photo-1.jpg)`. Ordinary files
   in an ordinary folder, so they are still there for the Nextcloud Files app, a file
   manager, or anything else that opens a folder of pictures.

   Originals are copied byte for byte — no re-encoding, no stripping — which is what was
   asked for. It does mean a photo's own metadata, GPS included, travels with it. */

const ASSET_SUFFIX = '-assets';
/* Formats Chromium can actually decode. HEIC off an iPhone is not one of them. */
const IMAGE_TYPES = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'], ['.avif', 'image/avif']
]);

const assetDirFor = (id) => {
  if (!entryModel.isId(id)) throw new Error('That is not a diary date');
  if (!root) throw new Error('No diary folder is set');
  return path.join(root, `${id}${ASSET_SUFFIX}`);
};

/* Every filesystem-unsafe character goes, then the result is checked to be a plain name
   that really does land inside the day's own folder. The renderer is never trusted. */
function assetPathFor(id, filename) {
  const dir = assetDirFor(id);
  const safe = path
    .basename(String(filename || ''))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120);
  if (!safe) throw new Error('That is not a usable file name');
  const target = path.join(dir, safe);
  if (path.dirname(path.resolve(target)) !== path.resolve(dir)) throw new Error('That file name is not allowed');
  return { dir, name: safe, target };
}

const mediaTypeFor = (name) => IMAGE_TYPES.get(path.extname(String(name || '')).toLowerCase()) || '';

/* photo-1.jpg, photo-2.jpg… never reusing a name that is already taken, so adding a photo
   can never overwrite one that is already in the entry. */
async function freeAssetName(id, extension) {
  const dir = assetDirFor(id);
  let taken = [];
  try {
    taken = await fs.readdir(dir);
  } catch {
    taken = [];
  }
  const lower = new Set(taken.map(name => name.toLowerCase()));
  for (let n = 1; n <= 9999; n++) {
    const candidate = `photo-${n}${extension}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error('That day already has too many photos');
}

/* Copies a file in from anywhere on the disk, byte for byte. */
async function importAsset(id, sourcePath) {
  const extension = path.extname(String(sourcePath || '')).toLowerCase();
  if (!IMAGE_TYPES.has(extension)) throw new Error(`${path.basename(String(sourcePath))} is not an image this app can show`);
  const name = await freeAssetName(id, extension);
  const { dir, target } = assetPathFor(id, name);
  await fs.mkdir(dir, { recursive: true });
  remember(target);
  await fs.copyFile(sourcePath, target);
  const { size } = await fs.stat(target);
  return { name, relative: `${id}${ASSET_SUFFIX}/${name}`, size };
}

/* The same, for bytes that came off the clipboard or a drop rather than a path. */
async function writeAsset(id, extension, bytes) {
  const suffix = String(extension || '').toLowerCase();
  if (!IMAGE_TYPES.has(suffix)) throw new Error('That is not an image this app can show');
  if (!bytes || !bytes.length) throw new Error('There was nothing to save');
  const name = await freeAssetName(id, suffix);
  const { dir, target } = assetPathFor(id, name);
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(target, Buffer.from(bytes));
  return { name, relative: `${id}${ASSET_SUFFIX}/${name}`, size: bytes.length };
}

/* Reads one photo for the diary-asset: protocol. Refuses anything that is not an image
   sitting directly in that day's folder. */
async function readAsset(id, filename) {
  const { target } = assetPathFor(id, filename);
  const type = mediaTypeFor(filename);
  if (!type) throw new Error('That is not an image');
  return { bytes: await fs.readFile(target), type };
}

async function listAssets(id) {
  let names = [];
  try {
    names = await fs.readdir(assetDirFor(id));
  } catch {
    return [];
  }
  return names.filter(name => mediaTypeFor(name)).sort();
}

/* To the system trash, like everything else this app removes. */
async function removeAsset(id, filename) {
  const { target } = assetPathFor(id, filename);
  const { shell } = electron();
  if (shell && typeof shell.trashItem === 'function') {
    try {
      await shell.trashItem(target);
      return { trashed: true };
    } catch {
      // No trash on this filesystem; fall through.
    }
  }
  await fs.rm(target, { force: true });
  return { trashed: false };
}

/* Called when a whole day is deleted, so its photos go with it rather than being left
   behind as a folder nothing references. */
async function removeAssetDir(id) {
  const dir = assetDirFor(id);
  try {
    await fs.stat(dir);
  } catch {
    return { trashed: false, missing: true };
  }
  const { shell } = electron();
  if (shell && typeof shell.trashItem === 'function') {
    try {
      await shell.trashItem(dir);
      return { trashed: true };
    } catch {
      // Fall through.
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
  return { trashed: false };
}

module.exports = {
  setDiaryPath, getDiaryPath, defaultDiaryPath, ensureDiary, fileFor,
  list, read, readMany, write, remove,
  ASSET_SUFFIX, assetDirFor, importAsset, writeAsset, readAsset, listAssets,
  removeAsset, removeAssetDir, mediaTypeFor,
  wasSelfWrite, flush
};
