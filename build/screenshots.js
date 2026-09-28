/* `npm run screenshots` — regenerates docs/screenshots/ from the real app, pointed at a
   throwaway diary of invented entries. Nothing from anybody's actual diary, name or disk
   ever ends up in the pictures, and they can be redone whenever the UI changes instead of
   going stale.

   Runs the app's own main.js under Electron with its userData and diary folder moved into
   a temporary directory, then drives the page the way a person would — menu actions,
   clicks, typing — and captures each state. */
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const entryModel = require('../src/entry.js');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-diary-screenshots-'));
const DIARY = path.join(ROOT, 'Diary');
const USER_DATA = path.join(ROOT, 'userData');
/* What the sidebar shows as the diary's location, instead of the temporary folder. */
const SHOWN_PATH = '~/Nextcloud/Notes/Diary';

/* ---------------------------------------------------------------- the demo diary */

const today = entryModel.todayId(new Date(), 4);
const day = (offset) => entryModel.shiftId(today, offset);
const PHOTO_DAY = day(-6);

function entry(id, { tags, went, notes = '', tomorrow = '' }) {
  const lines = [`# ${entryModel.formatTitle(id, 'long')}`, ''];
  if (tags) lines.push(`Tags: ${tags}`, '');
  lines.push('## How the day went', '', went, '', '## Notes', '', notes, '', '## Tomorrow', '', tomorrow, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

const ENTRIES = {
  [day(0)]: {
    tags: 'Wren, reservoir',
    went: 'Walked the reservoir path with Wren after work. The water was flat enough to see the far treeline upside down in it, and we stayed until the light went.',
    notes: 'order the filter before the weekend',
    tomorrow: 'swap show at the fairground'
  },
  [day(-1)]: {
    went: 'Rain most of the day. Read by the window and finally sorted the **spare room** shelves.',
    notes: '- bike lights\n- return the library books',
    tomorrow: 'walk if it clears'
  },
  [day(-2)]: {
    tags: 'Jonah Pike, fairground',
    went: 'First proper day out in a while. Jonah Pike drove; the fairground was half set up and we walked the stalls anyway. Found the bracket for the shelf at the very last one.',
    notes: 'Jonah wants the recipe for the lentil thing'
  },
  [day(-3)]: {
    tags: 'workshop',
    went: 'Quiet one. Finished the shelf brackets and oiled the bench.'
  },
  [day(-5)]: {
    tags: 'workshop, Wren',
    went: 'Long day at work, nothing much to report. Wren rang about Sunday — the reservoir if the rain holds off.',
    tomorrow: 'pick up the drill bits'
  },
  [PHOTO_DAY]: {
    tags: 'reservoir',
    went: `Up early for the light over the reservoir. Worth it.\n\n![the far treeline at dawn](${PHOTO_DAY}-assets/photo-1.png)\n\nCold hands, good coffee.`
  },
  [day(-9)]: { went: 'Back to the routine. Sorted the allotment rota.' },
  [day(-12)]: { tags: 'Jonah Pike', went: 'Dinner at Jonah Pike’s. Far too much pasta.' },
  [day(-365)]: { went: 'A year ago today. Rained the whole weekend, so we played cards and let the reservoir walk wait.' }
};

/* A dawn over still water, drawn rather than photographed so it belongs to nobody. */
function dawnPng(width, height) {
  const horizon = Math.round(height * 0.56);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const mix = (a, b, t) => a.map((value, index) => Math.round(value + (b[index] - value) * t));
  const skyTop = [44, 58, 96];
  const skyLow = [236, 170, 128];
  const sun = { x: width * 0.66, y: horizon - height * 0.11, r: height * 0.07 };
  const ridge = (x) => horizon - height * (0.035 + 0.02 * Math.sin(x / 37) + 0.012 * Math.sin(x / 11) + 0.018 * Math.abs(Math.sin(x / 90)));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      let colour;
      const sky = (sy) => {
        const d = Math.hypot(x - sun.x, sy - sun.y);
        let c = mix(skyTop, skyLow, Math.pow(Math.min(1, sy / horizon), 1.6));
        if (d < sun.r) c = [252, 232, 196];
        else if (d < sun.r * 3) c = mix([250, 214, 170], c, (d - sun.r) / (sun.r * 2));
        return c;
      };
      if (y < horizon) {
        colour = y > ridge(x) ? [30, 38, 52] : sky(y);
      } else {
        const mirrored = horizon - (y - horizon) * 1.1;
        const ripple = Math.sin(y * 0.9 + Math.sin(x / 23) * 2) * 0.08;
        const reflected = mirrored > ridge(x) || mirrored < 0 ? [30, 38, 52] : sky(mirrored);
        colour = mix(reflected, [22, 30, 44], 0.35 + ripple + (y - horizon) / (height - horizon) * 0.3);
      }
      const at = row + 1 + x * 3;
      raw[at] = colour[0]; raw[at + 1] = colour[1]; raw[at + 2] = colour[2];
    }
  }
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

function seed() {
  fs.mkdirSync(path.join(DIARY, `${PHOTO_DAY}-assets`), { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  for (const [id, content] of Object.entries(ENTRIES)) {
    fs.writeFileSync(path.join(DIARY, `${id}.md`), entry(id, content));
  }
  fs.writeFileSync(path.join(DIARY, `${PHOTO_DAY}-assets`, 'photo-1.png'), dawnPng(1200, 750));
  fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify({
    theme: 'light', diaryPath: DIARY, spellcheck: false, sidebarVisible: true
  }));
  fs.writeFileSync(path.join(USER_DATA, 'window-state.json'), JSON.stringify({ width: 1440, height: 900, maximized: false }));
}

/* ---------------------------------------------------------------- driving the page */

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function drive(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const menu = (action) => win.webContents.send('diary:menu', action);
  const until = async (code, what) => {
    for (let tries = 0; tries < 100; tries++) {
      if (await js(code)) return;
      await wait(100);
    }
    throw new Error(`screenshots: timed out waiting for ${what}`);
  };
  const tidy = () => js(`(() => {
    for (const id of ['storagePath', 'settingsPath']) {
      const node = document.getElementById(id);
      if (node) { node.textContent = ${JSON.stringify(SHOWN_PATH)}; node.title = ''; }
    }
    const toast = document.getElementById('toast');
    if (toast) toast.classList.remove('show');
  })()`);
  const shot = async (name) => {
    await tidy();
    await wait(600);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), image.toPNG());
    console.log(`screenshots: ${name}`);
  };
  const escape = () => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  const closeDialogs = () => js('while (window.diaryDialog.isOpen()) window.diaryDialog.closeTop()');
  const openDay = async (id) => {
    await js(`document.querySelector('.cal-day[data-id="${id}"]').click()`);
    await until(`document.getElementById('entryDate').textContent.includes(${JSON.stringify(entryModel.formatTitle(id, 'long').split(',')[1].trim())})`, `the entry for ${id}`);
    await js(`document.activeElement && document.activeElement.blur(); document.getElementById('workspace').scrollTop = 0`);
  };
  const search = async (query) => {
    menu('search');
    await until(`!document.getElementById('searchOverlay').hidden`, 'the search palette');
    await js(`(() => { const input = document.getElementById('searchInput'); input.value = ${JSON.stringify(query)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  };

  await until(`!document.getElementById('appShell').hidden && document.querySelectorAll('.cal-day.has-entry').length > 3`, 'the diary to open');
  await js(`document.activeElement && document.activeElement.blur()`);

  await shot('01-light.png');

  menu('toggle-theme');
  await until(`document.documentElement.dataset.theme === 'dark'`, 'dark mode');
  await shot('02-dark.png');
  menu('toggle-theme');
  await until(`document.documentElement.dataset.theme === 'light'`, 'light mode');

  await search('reservoir');
  await shot('03-search.png');
  await closeDialogs();

  menu('settings');
  await until(`window.diaryDialog.isOpen()`, 'settings');
  await shot('04-settings.png');
  await closeDialogs();

  /* Two versions of one day: type into it, and have "another device" write it meanwhile. */
  await openDay(day(-2));
  await js(`window.diarySettings.set({ autosaveMs: 8000 })`);
  await js(`(() => {
    const editor = document.querySelector('.editor');
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, ' Drove back the long way round.');
  })()`);
  const elsewhere = { ...ENTRIES[day(-2)], went: `${ENTRIES[day(-2)].went} Written up properly on the laptop that evening.` };
  fs.writeFileSync(path.join(DIARY, `${day(-2)}.md`), entry(day(-2), elsewhere));
  win.webContents.send('diary:changed');
  await until(`!document.getElementById('notice').hidden`, 'the conflict notice');
  await js(`document.activeElement && document.activeElement.blur(); document.getElementById('workspace').scrollTop = 0`);
  await shot('05-conflict.png');
  await js(`document.getElementById('noticeKeep').click()`);
  await js(`window.diarySettings.set({ autosaveMs: 700 })`);
  await wait(300);

  await openDay(day(0));
  await js(`[...document.querySelectorAll('#tagList button')].find(button => button.textContent.includes('Wren')).click()`);
  await until(`!document.getElementById('tagView').hidden`, 'the tag view');
  await shot('06-tags.png');
  await escape();

  await openDay(PHOTO_DAY);
  await until(`[...document.querySelectorAll('.editor img')].some(image => image.complete && image.naturalWidth > 0)`, 'the photo');
  await shot('07-photos.png');

  await search('reservoir');
  await js(`document.getElementById('searchInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))`);
  await until(`!document.getElementById('tagView').hidden`, 'every match');
  await shot('08-search-results.png');
}

/* ---------------------------------------------------------------- run */

seed();
app.setPath('userData', USER_DATA);
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', () => {
    drive(win)
      .then(() => { console.log(`screenshots: written to ${path.relative(process.cwd(), OUT)}`); })
      .catch((error) => { console.error(error); process.exitCode = 1; })
      .finally(() => {
        /* Chromium still holds its profile files open until the process is gone; whatever
           it keeps is left to the system's temp cleanup. */
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* see above */ }
        app.exit(process.exitCode || 0);
      });
  });
});
require('../src/main.js');
