/* The filesystem layer, against a real temporary folder. diary.js only reaches for Electron
   when moving a file to the trash, so everything else runs under plain node. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const diary = require('../src/diary.js');
const entry = require('../src/entry.js');

async function freshFolder() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-diary-test-'));
  diary.setDiaryPath(dir);
  await diary.ensureDiary();
  return dir;
}

const ENTRY = '# Friday, 18 September 2026\n\n## Notes\n\nsomething happened\n';
const BLANK = '# Friday, 18 September 2026\n\n## How the day went\n\n## Notes\n\n## Tomorrow\n';

test('ensureDiary creates the folder if it is not there yet', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-diary-test-'));
  const nested = path.join(base, 'Nextcloud', 'Notes', 'Diary');
  diary.setDiaryPath(nested);
  await diary.ensureDiary();
  assert.strictEqual((await fs.stat(nested)).isDirectory(), true);
});

test('an entry is written under its own date', async () => {
  const dir = await freshFolder();
  const result = await diary.write('2026-09-18', ENTRY);
  assert.strictEqual(result.written, true);
  assert.strictEqual(result.path, path.join(dir, '2026-09-18.md'));
  assert.strictEqual(await fs.readFile(result.path, 'utf8'), ENTRY);
});

test('the write leaves no temp file behind', async () => {
  const dir = await freshFolder();
  await diary.write('2026-09-18', ENTRY);
  const left = await fs.readdir(dir);
  assert.deepStrictEqual(left, ['2026-09-18.md']);
});

test('an entry with nothing written in it is not created', async () => {
  const dir = await freshFolder();
  const result = await diary.write('2026-09-18', BLANK);
  assert.strictEqual(result.written, false);
  assert.deepStrictEqual(await fs.readdir(dir), [], 'opening a day must not litter the folder');
});

test('but emptying a day you had written keeps the file rather than deleting it silently', async () => {
  const dir = await freshFolder();
  await diary.write('2026-09-18', ENTRY);
  const result = await diary.write('2026-09-18', BLANK);
  assert.strictEqual(result.written, true);
  assert.strictEqual(await fs.readFile(path.join(dir, '2026-09-18.md'), 'utf8'), BLANK);
});

test('reading a day that was never written is an ordinary answer, not an error', async () => {
  await freshFolder();
  const result = await diary.read('2026-09-18');
  assert.strictEqual(result.exists, false);
  assert.strictEqual(result.markdown, '');
  assert.strictEqual(result.mtimeMs, 0);
});

test('a bad date is refused rather than written somewhere unexpected', async () => {
  await freshFolder();
  for (const id of ['', '2026-13-01', '../escape', '2026-09-18.md', '2026-9-8']) {
    await assert.rejects(() => diary.read(id), /not a diary date/, id);
    await assert.rejects(() => diary.write(id, ENTRY), /not a diary date/, id);
  }
});

test('list returns entries newest first and ignores everything else in the folder', async () => {
  const dir = await freshFolder();
  for (const id of ['2026-09-16', '2026-09-17', '2026-09-18']) await diary.write(id, ENTRY);
  /* The kinds of file that really do turn up in a synced folder. */
  await fs.writeFile(path.join(dir, 'README.md'), '# not an entry\n');
  await fs.writeFile(path.join(dir, '2026-09-18 (conflicted copy 2026-09-19 113000).md'), ENTRY);
  await fs.writeFile(path.join(dir, '.hidden.md'), ENTRY);
  await fs.writeFile(path.join(dir, '2026-09-18.md.tmp'), ENTRY);
  await fs.mkdir(path.join(dir, 'attachments'));

  const items = await diary.list();
  assert.deepStrictEqual(items.map(item => item.id), ['2026-09-18', '2026-09-17', '2026-09-16']);
  for (const item of items) assert.strictEqual(item.size > 0, true);
});

test('list on a folder that is not there yet is empty, not an error', async () => {
  diary.setDiaryPath(path.join(os.tmpdir(), `daily-diary-missing-${Date.now()}`));
  assert.deepStrictEqual(await diary.list(), []);
});

test('readMany returns only the days asked for, and skips bad ids', async () => {
  await freshFolder();
  await diary.write('2026-09-17', ENTRY);
  await diary.write('2026-09-18', ENTRY);
  const rows = await diary.readMany(['2026-09-18', 'nonsense', '2026-09-17', '2026-13-40']);
  assert.deepStrictEqual(rows.map(row => row.id), ['2026-09-18', '2026-09-17']);
  assert.strictEqual(rows.every(row => row.exists), true);
});

test('the app recognises its own writes, so the watcher does not reload what you just typed', async () => {
  const dir = await freshFolder();
  const result = await diary.write('2026-09-18', ENTRY);
  assert.strictEqual(diary.wasSelfWrite(result.path), true);
  assert.strictEqual(diary.wasSelfWrite(path.join(dir, '2026-09-19.md')), false);
});

test('two saves of the same day land in the order they were made', async () => {
  const dir = await freshFolder();
  const last = '# Friday, 18 September 2026\n\n## Notes\n\nthe last one\n';
  await Promise.all([
    diary.write('2026-09-18', ENTRY),
    diary.write('2026-09-18', '# Friday, 18 September 2026\n\n## Notes\n\nthe middle one\n'),
    diary.write('2026-09-18', last)
  ]);
  await diary.flush();
  assert.strictEqual(await fs.readFile(path.join(dir, '2026-09-18.md'), 'utf8'), last);
});

test('what was written comes back exactly, including a hard line break', async () => {
  await freshFolder();
  const source = '# Friday, 18 September 2026\n\n## Notes\n\nfirst  \nsecond\n';
  await diary.write('2026-09-18', source);
  const back = await diary.read('2026-09-18');
  assert.strictEqual(back.markdown, source);
  assert.deepStrictEqual(entry.parse(back.markdown, '2026-09-18').sections[0].body, 'first  \nsecond');
});

test('deleting removes the entry', async () => {
  const dir = await freshFolder();
  await diary.write('2026-09-18', ENTRY);
  await diary.remove('2026-09-18');
  assert.deepStrictEqual(await fs.readdir(dir), []);
});

test('the default folder is an absolute path aimed at a synced folder', async () => {
  const fallback = diary.defaultDiaryPath();
  assert.strictEqual(path.isAbsolute(fallback), true);
  assert.match(path.basename(fallback).toLowerCase(), /diary/);
});

/* ---------------------------------------------------------------- photos */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test('a photo is copied in beside the entry, byte for byte', async () => {
  const dir = await freshFolder();
  const source = path.join(dir, 'source.png');
  await fs.writeFile(source, PNG);

  const added = await diary.importAsset('2026-09-18', source);
  assert.strictEqual(added.name, 'photo-1.png');
  assert.strictEqual(added.relative, '2026-09-18-assets/photo-1.png');

  const landed = await fs.readFile(path.join(dir, '2026-09-18-assets', 'photo-1.png'));
  assert.deepStrictEqual(landed, PNG, 'not re-encoded, not stripped');
});

test('adding more photos never overwrites one already there', async () => {
  const dir = await freshFolder();
  const source = path.join(dir, 'source.png');
  await fs.writeFile(source, PNG);
  const names = [];
  for (let i = 0; i < 3; i++) names.push((await diary.importAsset('2026-09-18', source)).name);
  assert.deepStrictEqual(names, ['photo-1.png', 'photo-2.png', 'photo-3.png']);
});

test('bytes off the clipboard land the same way', async () => {
  const dir = await freshFolder();
  const written = await diary.writeAsset('2026-09-18', '.png', PNG);
  assert.strictEqual(written.relative, '2026-09-18-assets/photo-1.png');
  assert.deepStrictEqual(await fs.readFile(path.join(dir, '2026-09-18-assets', 'photo-1.png')), PNG);
});

test('formats the app cannot display are refused', async () => {
  const dir = await freshFolder();
  const heic = path.join(dir, 'IMG_0001.HEIC');
  await fs.writeFile(heic, PNG);
  await assert.rejects(() => diary.importAsset('2026-09-18', heic), /not an image this app can show/);
  await assert.rejects(() => diary.writeAsset('2026-09-18', '.heic', PNG), /not an image this app can show/);
  await assert.rejects(() => diary.writeAsset('2026-09-18', '.svg', PNG), /not an image this app can show/);
});

test('a photo cannot be read or written outside its own day folder', async () => {
  const dir = await freshFolder();
  await diary.writeAsset('2026-09-18', '.png', PNG);
  const escapes = ['../../secret.png', '..\\..\\secret.png', '/etc/passwd', 'sub/dir/x.png'];
  for (const name of escapes) {
    /* Either refused outright, or flattened to a plain name inside the folder — never
       reaching out of it. */
    await assert.rejects(() => diary.readAsset('2026-09-18', name), /./, name);
  }
});

test('listing a day returns only images, sorted', async () => {
  const dir = await freshFolder();
  await diary.writeAsset('2026-09-18', '.png', PNG);
  await diary.writeAsset('2026-09-18', '.jpg', PNG);
  await fs.writeFile(path.join(dir, '2026-09-18-assets', 'notes.txt'), 'not an image');
  assert.deepStrictEqual(await diary.listAssets('2026-09-18'), ['photo-1.jpg', 'photo-1.png']);
});

test('listing a day with no photos is empty, not an error', async () => {
  await freshFolder();
  assert.deepStrictEqual(await diary.listAssets('2026-09-18'), []);
});

test('readAsset hands back the bytes and the right media type', async () => {
  await freshFolder();
  await diary.writeAsset('2026-09-18', '.png', PNG);
  const got = await diary.readAsset('2026-09-18', 'photo-1.png');
  assert.strictEqual(got.type, 'image/png');
  assert.deepStrictEqual(got.bytes, PNG);
});

test('deleting a day takes its photos with it', async () => {
  const dir = await freshFolder();
  await diary.write('2026-09-18', ENTRY);
  await diary.writeAsset('2026-09-18', '.png', PNG);
  assert.strictEqual((await fs.readdir(dir)).includes('2026-09-18-assets'), true);
  await diary.remove('2026-09-18');
  assert.deepStrictEqual(await fs.readdir(dir), [], 'entry and photos both gone');
});

test('removing one photo leaves the others alone', async () => {
  const dir = await freshFolder();
  await diary.writeAsset('2026-09-18', '.png', PNG);
  await diary.writeAsset('2026-09-18', '.png', PNG);
  await diary.removeAsset('2026-09-18', 'photo-1.png');
  assert.deepStrictEqual(await diary.listAssets('2026-09-18'), ['photo-2.png']);
});
