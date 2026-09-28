/* Electron main process: the window, settings, watching the diary folder, and every IPC
   channel the page is allowed to call. The renderer is sandboxed and never sees fs. */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require('electron');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const diary = require('./diary.js');
const entryModel = require('./entry.js');
const menu = require('./menu.js');
const windowState = require('./window-state.js');

const INDEX = path.join(__dirname, '..', 'index.html');
const ASSET_SCHEME = 'diary-asset';

/* Must be declared before the app is ready. Photos live next to the entries, outside the
   app, and the page cannot reach a file:// path there — so they are served over the app's
   own scheme instead, by a handler that only ever looks inside the diary folder. */
protocol.registerSchemesAsPrivileged([{
  scheme: ASSET_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
}]);
const WATCH_DEBOUNCE = 300;
const DEV = !app.isPackaged;

/* ---------------------------------------------------------------- settings */

const DEFAULT_SETTINGS = {
  theme: 'system',
  fontScale: 1,
  diaryPath: null,
  autosaveMs: 700,
  spellcheck: true,
  sidebarVisible: true,
  /* The sections a brand-new entry is scaffolded with. Days you have already written in keep
     whatever headings they were written with — see entry.js ensureSections(). */
  headings: entryModel.DEFAULT_HEADINGS.slice(),
  titleStyle: entryModel.DEFAULT_TITLE_STYLE,
  /* Write at 1am and you mean yesterday. 0 makes the diary day start at plain midnight. */
  dayStartHour: 4,
  /* Purely how the writing area looks; the file on disk is identical either way. */
  bodyFont: 'sans'
};

let settings = { ...DEFAULT_SETTINGS };

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

function sanitizeSettings(patch, base) {
  const next = { ...base };
  if (!patch || typeof patch !== 'object') return next;
  if (['system', 'light', 'dark'].includes(patch.theme)) next.theme = patch.theme;
  if ('fontScale' in patch) next.fontScale = Math.round(clamp(patch.fontScale, 0.85, 1.4, base.fontScale) * 100) / 100;
  if ('autosaveMs' in patch) next.autosaveMs = Math.round(clamp(patch.autosaveMs, 200, 10000, base.autosaveMs));
  if ('spellcheck' in patch) next.spellcheck = Boolean(patch.spellcheck);
  if ('sidebarVisible' in patch) next.sidebarVisible = Boolean(patch.sidebarVisible);
  if ('dayStartHour' in patch) next.dayStartHour = Math.round(clamp(patch.dayStartHour, 0, 12, base.dayStartHour));
  if (entryModel.TITLE_STYLES.includes(patch.titleStyle)) next.titleStyle = patch.titleStyle;
  if (['sans', 'serif'].includes(patch.bodyFont)) next.bodyFont = patch.bodyFont;
  if ('headings' in patch) {
    const list = entryModel.headingList(patch.headings).slice(0, 12);
    /* Never let the app end up with no sections at all — an entry would then be a bare date
       with nowhere to type, and the settings dialog would have nothing to put back. */
    next.headings = list.length ? list : base.headings.slice();
  }
  if ('diaryPath' in patch) next.diaryPath = typeof patch.diaryPath === 'string' && patch.diaryPath.trim() ? path.resolve(patch.diaryPath) : null;
  return next;
}

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

/* A corrupt settings file must never stop the app from starting. */
function loadSettings() {
  try {
    settings = sanitizeSettings(JSON.parse(fsSync.readFileSync(settingsPath(), 'utf8')), DEFAULT_SETTINGS);
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  return settings;
}

async function saveSettings() {
  const file = settingsPath();
  const tmp = `${file}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- watching */

let watcher = null;
let watchTimer = null;

function stopWatching() {
  try {
    if (watcher) watcher.close();
  } catch {
    // Already closed.
  }
  watcher = null;
}

function notifyChanged() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('diary:changed');
  }
}

function scheduleChanged() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(notifyChanged, WATCH_DEBOUNCE);
}

/* The diary is one flat folder, so a single non-recursive watch covers it on every platform. */
function startWatching() {
  stopWatching();
  const base = diary.getDiaryPath();
  if (!base) return;
  try {
    watcher = fsSync.watch(base, { persistent: false }, (_event, filename) => {
      if (filename && diary.wasSelfWrite(path.join(base, String(filename)))) return;
      scheduleChanged();
    });
    watcher.on('error', () => {});
  } catch {
    // Watching is a convenience; a diary on a filesystem that cannot watch still works.
  }
  startRescanning();
}

/* ---------------------------------------------------------------- rescanning

   fs.watch is unreliable on exactly the folders this app is built for — a Nextcloud folder
   routinely gains a file with no event fired at all — so watching alone cannot deliver
   "the entry I wrote on my phone shows up on my laptop". A slow poll of the entry mtimes
   covers that, and a poll on window focus makes the common case feel immediate. */

const RESCAN_MS = 15000;
let rescanTimer = null;
let lastSignature = null;

async function signature() {
  const stamps = new Map();
  for (const item of await diary.list()) stamps.set(item.id, `${item.mtimeMs}:${item.size}`);
  return stamps;
}

function changed(previous, next) {
  for (const [id, stamp] of next) if (previous.get(id) !== stamp) return true;
  for (const id of previous.keys()) if (!next.has(id)) return true;
  return false;
}

async function rescan() {
  let next;
  try {
    next = await signature();
  } catch {
    return;
  }
  const previous = lastSignature;
  lastSignature = next;
  if (previous === null) return;  // the first pass only establishes the baseline
  if (changed(previous, next)) notifyChanged();
}

/* The poll interval is far longer than diary.js's few-second memory of its own writes, so by
   the time a pass runs our own autosave already looks like somebody else's edit. Folding the
   new stamp straight into the baseline closes that window instead of racing it. */
async function absorb(id) {
  if (!lastSignature || !entryModel.isId(id)) return;
  try {
    const file = diary.fileFor(id);
    const stats = await fs.stat(file);
    lastSignature.set(id, `${stats.mtimeMs}:${stats.size}`);
  } catch {
    /* We just deleted it, or it never existed. Either way the baseline should agree, so the
       next poll does not report our own delete as somebody else's change. */
    lastSignature.delete(id);
  }
}

function startRescanning() {
  clearInterval(rescanTimer);
  lastSignature = null;
  rescanTimer = setInterval(() => { rescan().catch(() => {}); }, RESCAN_MS);
  rescan().catch(() => {});
}

function stopRescanning() {
  clearInterval(rescanTimer);
  rescanTimer = null;
}

/* ---------------------------------------------------------------- window */

let mainWindow = null;

/* Packaged builds get the icon from extraResources; a dev run reads it out of build/. */
function iconPath() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'icon.png') : null,
    path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
  ];
  return candidates.find(file => file && fsSync.existsSync(file)) || undefined;
}

function createWindow() {
  const state = windowState.restore();
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: '#f8f6f1',
    title: 'daily-diary',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: settings.spellcheck
    }
  });

  windowState.manage(win);
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  /* Electron ships no context menu of its own, and the spelling suggestions for a word only
     exist here, in Chromium's menu params. The page cannot see them, so it is told. */
  win.webContents.on('context-menu', (_event, params) => {
    if (win.isDestroyed()) return;
    win.webContents.send('diary:context-menu', {
      x: params.x,
      y: params.y,
      editable: Boolean(params.isEditable),
      misspelledWord: String(params.misspelledWord || ''),
      suggestions: (params.dictionarySuggestions || []).slice(0, 5).map(String)
    });
  });

  win.on('focus', () => { rescan().catch(() => {}); });

  /* Closing the window is the ordinary way out of the app, and it destroys the page — along
     with whatever is still sitting in its autosave timer — before `before-quit` ever runs.
     So the close is held open just long enough to ask the page for it. */
  let closable = false;
  win.on('close', (event) => {
    if (closable) return;
    event.preventDefault();
    askPageToFlush()
      .then(() => diary.flush())
      .catch(() => {})
      .finally(() => {
        closable = true;
        if (!win.isDestroyed()) win.close();
      });
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.loadFile(INDEX);
  mainWindow = win;
  return win;
}

/* ---------------------------------------------------------------- serving photos

   diary-asset://entry/<date>/<file.jpg> -> <diary>/<date>-assets/<file.jpg>

   diary.js does the path checking, so nothing outside a day's own folder can be reached and
   only the image types Chromium can decode are served. */

function registerAssetProtocol() {
  protocol.handle(ASSET_SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (url.hostname !== 'entry' || parts.length !== 2) return new Response('Not found', { status: 404 });
    try {
      const { bytes, type } = await diary.readAsset(parts[0], parts[1]);
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': type, 'cache-control': 'no-store' }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/* ---------------------------------------------------------------- flushing the page

   On the way out the page is asked to write whatever is still in its autosave timer. It
   answers on `diary:flushed`; if it is wedged or already gone, the timeout lets the app
   close anyway rather than hanging on quit. */

const FLUSH_TIMEOUT = 2000;
let flushWaiters = [];

function askPageToFlush() {
  const windows = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed());
  if (!windows.length) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let outstanding = windows.length;
    const done = () => {
      if (settled) return;
      settled = true;
      flushWaiters = flushWaiters.filter(waiter => waiter !== waiter_);
      resolve();
    };
    const waiter_ = () => {
      outstanding -= 1;
      if (outstanding <= 0) done();
    };
    flushWaiters.push(waiter_);
    setTimeout(done, FLUSH_TIMEOUT);
    for (const win of windows) win.webContents.send('diary:flush');
  });
}

/* ---------------------------------------------------------------- ipc */

/* Only our own window may call these, and no handler is ever allowed to reject. */
function fromOurWindow(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  return Boolean(win) && BrowserWindow.getAllWindows().includes(win);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromOurWindow(event)) return { ok: false, error: 'Unknown sender' };
    try {
      return await fn(...args);
    } catch (error) {
      return { ok: false, error: (error && error.message) || 'Something went wrong' };
    }
  });
}

function registerIpc() {
  ipcMain.on('diary:spell', (event, action, word) => {
    if (!fromOurWindow(event) || typeof word !== 'string' || !word.trim()) return;
    if (action === 'replace') event.sender.replaceMisspelling(word);
    else if (action === 'add') event.sender.session.addWordToSpellCheckerDictionary(word);
  });

  /* Synchronous, so preload can expose platform/version as plain values. */
  ipcMain.on('diary:app-info', (event) => {
    event.returnValue = { version: app.getVersion(), platform: process.platform };
  });

  /* The page's answer to `diary:flush` — see askPageToFlush(). */
  ipcMain.on('diary:flushed', (event) => {
    if (!fromOurWindow(event)) return;
    for (const waiter of [...flushWaiters]) waiter();
  });

  handle('diary:path', async () => ({ ok: true, path: diary.getDiaryPath() }));

  handle('diary:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: 'Choose the folder your diary lives in',
      message: 'Pick a folder inside the one your Nextcloud client syncs.',
      defaultPath: diary.getDiaryPath(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'Cancelled' };
    await diary.flush();
    const chosen = diary.setDiaryPath(result.filePaths[0]);
    await diary.ensureDiary();
    settings = sanitizeSettings({ diaryPath: chosen }, settings);
    await saveSettings();
    startWatching();
    return { ok: true, path: chosen };
  });

  handle('diary:reveal', async () => {
    await diary.ensureDiary();
    const error = await shell.openPath(diary.getDiaryPath());
    return error ? { ok: false, error } : { ok: true };
  });

  handle('diary:list', async () => ({ ok: true, items: await diary.list() }));
  handle('diary:read', async (id) => ({ ok: true, entry: await diary.read(id) }));
  handle('diary:read-many', async (ids) => ({ ok: true, entries: await diary.readMany(ids) }));

  handle('diary:write', async (id, markdown) => {
    const result = await diary.write(id, markdown);
    await absorb(id);
    return { ok: true, ...result };
  });

  handle('diary:delete', async (id) => {
    const result = await diary.remove(id);
    await absorb(id);
    return { ok: true, ...result };
  });

  /* Hand one day to somebody else, or keep a copy outside the synced folder. */
  handle('diary:export', async (id, markdown) => {
    if (!entryModel.isId(id)) return { ok: false, error: 'That is not a diary date' };
    const result = await dialog.showSaveDialog(mainWindow || undefined, {
      title: 'Export this entry',
      defaultPath: entryModel.fileNameFor(id),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'Cancelled' };
    await fs.writeFile(result.filePath, String(markdown == null ? '' : markdown), 'utf8');
    return { ok: true, path: result.filePath };
  });

  /* Pick photos from anywhere on the disk; they are copied in byte for byte. */
  handle('photo:add', async (id) => {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: 'Add photos to this entry',
      buttonLabel: 'Add',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, error: 'Cancelled' };

    const added = [];
    const failed = [];
    for (const source of result.filePaths.slice(0, 40)) {
      try {
        added.push(await diary.importAsset(id, source));
      } catch (error) {
        failed.push((error && error.message) || path.basename(source));
      }
    }
    await absorb(id);
    return { ok: added.length > 0, added, failed, error: added.length ? '' : (failed[0] || 'Nothing could be added') };
  });

  /* The same, for a photo pasted or dropped in, which arrives as bytes rather than a path. */
  handle('photo:write', async (id, extension, bytes) => {
    const written = await diary.writeAsset(id, extension, bytes);
    await absorb(id);
    return { ok: true, ...written };
  });

  handle('photo:remove', async (id, filename) => {
    const result = await diary.removeAsset(id, filename);
    await absorb(id);
    return { ok: true, ...result };
  });

  handle('photo:list', async (id) => ({ ok: true, names: await diary.listAssets(id) }));

  /* Open a photo in whatever the desktop uses for pictures. */
  handle('photo:open', async (id, filename) => {
    const dir = diary.assetDirFor(id);
    const target = path.join(dir, path.basename(String(filename || '')));
    if (path.dirname(path.resolve(target)) !== path.resolve(dir)) return { ok: false, error: 'That file is not in this entry' };
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });

  handle('settings:get', async () => settings);
  handle('settings:set', async (patch) => {
    const previousPath = settings.diaryPath;
    settings = sanitizeSettings(patch, settings);
    for (const win of BrowserWindow.getAllWindows()) win.webContents.session.setSpellCheckerEnabled(settings.spellcheck);
    const saved = await saveSettings();
    if (settings.diaryPath && settings.diaryPath !== previousPath) {
      await diary.flush();
      diary.setDiaryPath(settings.diaryPath);
      await diary.ensureDiary();
      startWatching();
    }
    return saved ? { ok: true, settings } : { ok: false, error: 'Settings could not be saved', settings };
  });

  handle('shell:open-external', async (url) => {
    let parsed = null;
    try {
      parsed = new URL(String(url));
    } catch {
      return { ok: false, error: 'That is not a valid link' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'Only web links can be opened' };
    await shell.openExternal(parsed.href);
    return { ok: true };
  });
}

/* ---------------------------------------------------------------- lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    loadSettings();
    diary.setDiaryPath(settings.diaryPath || diary.defaultDiaryPath());
    try {
      await diary.ensureDiary();
    } catch {
      // A missing or unwritable folder still lets the window open and report the failure.
    }
    registerAssetProtocol();
    registerIpc();
    menu.installMenu({ dev: DEV });
    createWindow();
    startWatching();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    stopRescanning();
    stopWatching();
    /* Never quit mid-sentence. diary.flush() only drains writes already handed to the main
       process; what you typed in the last few hundred milliseconds is still sitting in the
       page's autosave timer, so the page is asked to hand it over first. */
    askPageToFlush()
      .then(() => diary.flush())
      .finally(() => app.quit());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  /* Logging out or shutting down sends these. Without a handler the process is simply
     terminated, which is the one exit that would lose what you had just written. */
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => { app.quit(); });
  }
}
