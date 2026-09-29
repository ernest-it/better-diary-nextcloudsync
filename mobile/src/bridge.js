/* window.diaryApp for Android — the same surface src/preload.js gives the desktop page, so
   the renderer, the store, search and settings run here unchanged.

   On the desktop "the folder" is a folder on disk that the Nextcloud client keeps in sync.
   Here the app is its own sync client: the page reads and writes a copy of the diary folder
   in the app's private storage, exactly as it would a folder on disk, and sync.js carries
   that copy to and from the diary folder on the server in the background. So writing works
   offline, and everything the page knows about noticing changes from other devices —
   onChanged, the conflict notice — works the same way it does on the desktop. */
(() => {
  'use strict';

  const cap = window.Capacitor;
  const plugins = (cap && cap.Plugins) || {};
  const { Filesystem, App, Share, Nextcloud, LocalNotifications } = plugins;

  const DIR = 'DATA';
  const LOCAL = 'diary';
  const ACCOUNT_KEY = 'daily-diary:mobile-account';
  const SETTINGS_KEY = 'daily-diary:mobile-settings';
  const STATE_FILE = 'sync-state.json';

  const DEFAULT_SETTINGS = {
    theme: 'system',
    fontScale: 1,
    diaryPath: null,
    autosaveMs: 700,
    spellcheck: true,
    /* A phone has no room for the sidebar beside the page; it is a drawer here instead. */
    sidebarVisible: false,
    headings: ['How the day went', 'Notes', 'Tomorrow'],
    titleStyle: 'long',
    dayStartHour: 4,
    bodyFont: 'sans',
    reminderEnabled: false,
    reminderTime: window.diaryReminder.DEFAULT_TIME
  };

  const IMAGE_TYPES = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif'
  };
  const EXTENSION_FOR = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/bmp': '.bmp', 'image/avif': '.avif'
  };

  const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const fail = (error) => Promise.resolve({ ok: false, error });
  const readJson = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* best effort */ } };
  const extensionOf = (name) => { const at = String(name).lastIndexOf('.'); return at === -1 ? '' : String(name).slice(at).toLowerCase(); };

  /* ---------------------------------------------------------------- the phone's copy */

  const rel = (path) => `${LOCAL}/${path}`;

  const local = {
    async list() {
      try {
        const { files } = await Filesystem.readdir({ path: LOCAL, directory: DIR });
        return files.filter(file => file.type === 'file').map(file => ({ name: file.name, size: Number(file.size) || 0, mtimeMs: Number(file.mtime) || 0 }));
      } catch {
        return [];
      }
    },
    async readText(name) {
      try {
        const { data } = await Filesystem.readFile({ path: rel(name), directory: DIR, encoding: 'utf8' });
        return String(data);
      } catch {
        return null;
      }
    },
    /* Written beside the day and renamed over it, so an app killed mid-save leaves the
       previous version rather than half of the new one. */
    async writeText(name, text) {
      const partial = rel(`.${name}.part`);
      await Filesystem.writeFile({ path: partial, directory: DIR, data: String(text), encoding: 'utf8', recursive: true });
      await Filesystem.rename({ from: partial, to: rel(name), directory: DIR, toDirectory: DIR });
    },
    async remove(name) {
      try { await Filesystem.deleteFile({ path: rel(name), directory: DIR }); } catch { /* already gone */ }
    },
    async removeDir(path) {
      try { await Filesystem.rmdir({ path: rel(path), directory: DIR, recursive: true }); } catch { /* not there */ }
    },
    async makeDir(path) {
      try { await Filesystem.mkdir({ path: rel(path), directory: DIR, recursive: true }); } catch { /* already there */ }
    },
    async exists(path) {
      try { await Filesystem.stat({ path: rel(path), directory: DIR }); return true; } catch { return false; }
    },
    async stat(path) {
      try {
        const info = await Filesystem.stat({ path: rel(path), directory: DIR });
        return { size: Number(info.size) || 0, mtimeMs: Number(info.mtime) || 0 };
      } catch {
        return null;
      }
    },
    fileRef: (path) => rel(path),
    typeOf: (path) => IMAGE_TYPES[extensionOf(path)] || 'application/octet-stream'
  };

  const stateStore = {
    async load() {
      try {
        const { data } = await Filesystem.readFile({ path: STATE_FILE, directory: DIR, encoding: 'utf8' });
        return JSON.parse(String(data));
      } catch {
        return null;
      }
    },
    async save(value) {
      await Filesystem.writeFile({ path: `.${STATE_FILE}.part`, directory: DIR, data: JSON.stringify(value), encoding: 'utf8' });
      await Filesystem.rename({ from: `.${STATE_FILE}.part`, to: STATE_FILE, directory: DIR, toDirectory: DIR });
    }
  };

  async function wipeLocal() {
    try { await Filesystem.rmdir({ path: LOCAL, directory: DIR, recursive: true }); } catch { /* nothing there */ }
    try { await Filesystem.deleteFile({ path: STATE_FILE, directory: DIR }); } catch { /* nothing there */ }
    await local.makeDir('');
  }

  /* ---------------------------------------------------------------- the server */

  const transport = (request) => Nextcloud.request({ ...request, auth: true });

  let account = null;     // { server, user, folder }
  let engine = null;

  const davRoot = (who) => `${who.server}/remote.php/dav/files/${encodeURIComponent(who.user)}`;

  function connect(who) {
    account = who;
    const dav = window.diaryDav.create({ transport, root: davRoot(who) });
    engine = window.diarySync.create({ dav, local, store: stateStore, folder: who.folder });
  }

  const displayPath = () => {
    if (!account) return '';
    let host = account.server;
    try { host = new URL(account.server).host; } catch { /* keep it whole */ }
    return `${account.user}@${host}/${account.folder}`;
  };

  /* ---------------------------------------------------------------- syncing */

  const listeners = { changed: [], flush: [], menu: [] };
  const fanOut = (bucket, ...args) => {
    for (const handler of bucket) {
      try { handler(...args); } catch { /* one bad listener must not stop the others */ }
    }
  };

  let status = { state: 'idle', message: '' };
  function paintStatus(next) {
    status = next;
    const box = document.querySelector('.storage');
    if (!box) return;
    box.classList.toggle('offline', next.state === 'offline');
    box.classList.toggle('sync-error', next.state === 'error');
    box.classList.toggle('syncing', next.state === 'syncing');
    box.title = next.message || 'Where your diary is stored';
  }

  let reauthOpen = false;

  async function syncNow() {
    if (!engine) return { ok: false };
    paintStatus({ state: 'syncing', message: 'Syncing with Nextcloud…' });
    const result = await engine.sync();
    if (result.ok) {
      const waiting = await engine.pendingCount();
      paintStatus({ state: 'idle', message: waiting ? `${waiting} change(s) waiting to upload` : `In sync with ${displayPath()}` });
    } else if (result.offline) {
      paintStatus({ state: 'offline', message: 'Offline — what you write is kept on this phone and uploads when Nextcloud is reachable' });
    } else {
      paintStatus({ state: 'error', message: result.error || 'Could not sync' });
      if (result.status === 401 && !reauthOpen) {
        reauthOpen = true;
        runSetup({ mode: 'reauth' }).finally(() => { reauthOpen = false; });
      }
    }
    if (result.changed && result.changed.length) {
      fanOut(listeners.changed);
      /* A day written on another device should silence tonight's reminder here too. */
      scheduleReminders();
    }
    return result;
  }

  let soonTimer = null;
  const syncSoon = (delay = 2000) => {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => { syncNow(); }, delay);
  };

  let everyTimer = null;
  const startTicking = () => {
    clearInterval(everyTimer);
    everyTimer = setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60000);
  };

  /* ---------------------------------------------------------------- setup */

  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  function setBootMessage(text) {
    const message = document.getElementById('bootMessage');
    if (message) message.textContent = text;
  }

  /* Returns the account it ended up with, or null when cancelled. Connecting to a
     different account or folder starts the phone's copy from nothing. */
  async function runSetup(options) {
    /* Get everything written here onto the server before the phone's copy might be
       swapped for another folder's. */
    let unsent = false;
    if (options.mode === 'folder' && engine) {
      const last = await syncNow();
      unsent = !last.ok || (last.conflicts && last.conflicts.length > 0) || (await engine.pendingCount()) > 0;
    }
    const result = await window.diarySetup.run({ ...options, account, nextcloud: Nextcloud });
    if (!result) return null;
    const changedPlace = !account || result.server !== account.server || result.user !== account.user || result.folder !== account.folder;
    if (changedPlace && unsent && window.diaryDialog) {
      const sure = await window.diaryDialog.confirm({
        title: 'Some changes have not reached Nextcloud',
        body: ['This phone could not upload everything written on it. Switching folders now throws those changes away.'],
        confirmLabel: 'Switch anyway',
        danger: true
      });
      if (!sure) {
        if (account) connect(account);
        return null;
      }
    }
    writeJson(ACCOUNT_KEY, { server: result.server, user: result.user, folder: result.folder });
    if (changedPlace) {
      await wipeLocal();
      connect({ server: result.server, user: result.user, folder: result.folder });
      setBootMessage('Downloading your diary from Nextcloud…');
      await syncNow();
    } else {
      connect({ server: result.server, user: result.user, folder: result.folder });
      await syncNow();
    }
    return result;
  }

  async function init() {
    let stored = null;
    try { stored = await Nextcloud.account(); } catch { stored = null; }
    const saved = readJson(ACCOUNT_KEY);
    await local.makeDir('');
    try {
      const { uri } = await Filesystem.getUri({ path: LOCAL, directory: DIR });
      localRoot = String(uri).replace(/\/+$/, '');
    } catch {
      localRoot = '';
    }

    if (stored && stored.server && saved && saved.folder && saved.server === stored.server) {
      connect({ server: saved.server, user: saved.user || stored.user, folder: saved.folder });
      /* A diary already on the phone opens straight away and syncs behind it; a first run
         waits for the download so it does not open onto an empty calendar. */
      if ((await local.list()).length) syncSoon(300);
      else { setBootMessage('Downloading your diary from Nextcloud…'); await syncNow(); }
    } else {
      await runSetup({ mode: 'connect' });
    }
    startTicking();
    readyResolve();
    scheduleReminders();
  }

  /* ---------------------------------------------------------------- bedtime reminder

     Android shows these even when the app is not running, so they are handed to the system
     in advance: one notification per evening for the next month, leaving out any day already
     written. Reschedules on launch, on saving, after a sync brings in a day, and when the
     setting changes — so it goes quiet the moment the entry exists, and keeps going for a
     month even if the app is never opened in between. */

  const REMINDER_IDS = 7000;
  const REMINDER_DAYS = 30;
  const REMINDER_CHANNEL = 'bedtime-reminder';
  let reminderQueue = Promise.resolve();

  function scheduleReminders() {
    reminderQueue = reminderQueue.then(rescheduleReminders).catch(() => {});
    return reminderQueue;
  }

  async function rescheduleReminders() {
    if (!LocalNotifications) return;
    const { notifications: pending } = await LocalNotifications.getPending();
    const ours = pending.filter(item => item.id >= REMINDER_IDS && item.id < REMINDER_IDS + REMINDER_DAYS);
    if (ours.length) await LocalNotifications.cancel({ notifications: ours.map(item => ({ id: item.id })) });

    const settings = loadSettings();
    if (!settings.reminderEnabled) return;
    if ((await LocalNotifications.checkPermissions()).display !== 'granted') return;
    await LocalNotifications.createChannel({
      id: REMINDER_CHANNEL, name: 'Bedtime reminder', description: 'A nudge to write the day before bed', importance: 3
    });

    const written = new Set((await local.list()).map(row => row.name));
    const notifications = [];
    window.diaryReminder.upcoming(new Date(), settings.reminderTime, REMINDER_DAYS).forEach((at, index) => {
      if (written.has(`${window.diaryReminder.dayFor(at, settings.dayStartHour)}.md`)) return;
      notifications.push({
        id: REMINDER_IDS + index,
        title: "Time to write today's entry",
        body: 'A few lines before bed is all it takes.',
        channelId: REMINDER_CHANNEL,
        smallIcon: 'ic_stat_diary',
        schedule: { at, allowWhileIdle: true }
      });
    });
    if (notifications.length) await LocalNotifications.schedule({ notifications });
  }

  /* Asked the moment the switch is turned on, not at launch, so the question comes with its reason. */
  async function mayNotify() {
    if (!LocalNotifications) return false;
    try {
      let { display } = await LocalNotifications.checkPermissions();
      if (display !== 'granted') ({ display } = await LocalNotifications.requestPermissions());
      return display === 'granted';
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------- photos */

  let localRoot = '';

  function assetUrl(id, name) {
    if (!localRoot || !cap || typeof cap.convertFileSrc !== 'function') return '';
    return cap.convertFileSrc(`${localRoot}/${id}-assets/${encodeURIComponent(name)}`);
  }

  /* The reverse, for the way back out to the file: a photo URL of ours becomes the plain
     relative path again. Anything else is not ours (null). */
  function assetPath(src) {
    const match = /\/_capacitor_file_\/.*\/(\d{4}-\d{2}-\d{2})-assets\/([^/?#]+)$/.exec(String(src || ''));
    if (!match) return null;
    let name = match[2];
    try { name = decodeURIComponent(name); } catch { /* keep it encoded */ }
    return `${match[1]}-assets/${name}`;
  }

  const PHOTO_REF_RE = /\]\((\d{4}-\d{2}-\d{2}-assets\/[^)\s]+)\)/g;

  /* Photos are fetched as their day is opened. They arrive after the page has drawn the
     day, so each one is nudged to load again once it is here. */
  function fetchPhotosFor(markdown) {
    if (!engine) return;
    const wanted = [];
    for (const match of String(markdown || '').matchAll(PHOTO_REF_RE)) {
      let path = match[1];
      try { path = decodeURIComponent(path); } catch { /* keep it */ }
      if (!wanted.includes(path)) wanted.push(path);
    }
    if (!wanted.length) return;
    engine.ensurePhotos(wanted).then((fetched) => {
      for (const path of fetched) {
        const [dir, name] = path.split('/');
        const url = assetUrl(dir.slice(0, 10), name);
        for (const image of document.querySelectorAll('img')) {
          if (image.getAttribute('src') === url) image.setAttribute('src', url);
        }
      }
    }).catch(() => {});
  }

  function toBase64(bytes) {
    let binary = '';
    const step = 0x8000;
    for (let index = 0; index < bytes.length; index += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + step));
    }
    return btoa(binary);
  }

  /* photo-143522-a3f9.jpg: the time of day it was added and a little randomness, so a
     photo added here can never take the name of one added on another device before the
     two have synced. */
  async function freePhotoName(id, extension) {
    const now = new Date();
    const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join('');
    for (let attempt = 0; attempt < 20; attempt++) {
      const random = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
      const name = `photo-${stamp}-${random}${extension}`;
      if (!(await local.exists(`${id}-assets/${name}`))) return name;
    }
    throw new Error('Could not find a free name for that photo');
  }

  async function writePhoto(id, extension, bytes) {
    if (!engine) return { ok: false, error: 'Not connected to Nextcloud' };
    const suffix = String(extension || '').toLowerCase();
    if (!IMAGE_TYPES[suffix]) return { ok: false, error: 'That is not an image this app can show' };
    if (!bytes || !bytes.length) return { ok: false, error: 'There was nothing to save' };
    const name = await freePhotoName(id, suffix);
    const path = `${id}-assets/${name}`;
    await Filesystem.writeFile({ path: rel(path), directory: DIR, data: toBase64(bytes), recursive: true });
    await engine.queuePhoto('upload', path);
    syncSoon();
    return { ok: true, name, relative: path, size: bytes.length };
  }

  /* The system picker, through an ordinary file input — the WebView hands it to Android,
     which offers the gallery, files and camera. */
  function pickImages() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.style.display = 'none';
      let settled = false;
      const done = (files) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(files);
      };
      input.addEventListener('change', () => done([...(input.files || [])]));
      input.addEventListener('cancel', () => done([]));
      document.body.append(input);
      input.click();
    });
  }

  let viewer = null;
  function openViewer(url, caption) {
    if (!viewer) {
      viewer = document.createElement('div');
      viewer.className = 'photo-viewer';
      viewer.setAttribute('role', 'dialog');
      viewer.setAttribute('aria-modal', 'true');
      viewer.setAttribute('aria-label', 'Photo');
      viewer.innerHTML = '<img alt=""><button type="button" class="photo-viewer-close" aria-label="Close">×</button>';
      viewer.addEventListener('click', closeViewer);
      document.body.append(viewer);
    }
    const image = viewer.querySelector('img');
    image.src = url;
    image.alt = caption || '';
    viewer.hidden = false;
  }
  function closeViewer() { if (viewer) viewer.hidden = true; }
  const viewerOpen = () => Boolean(viewer && !viewer.hidden);

  /* ---------------------------------------------------------------- the phone's own controls */

  const narrow = () => window.matchMedia('(max-width: 680px)').matches;
  const drawerOpen = () => {
    const shell = document.getElementById('appShell');
    return Boolean(shell && !shell.hidden && !shell.classList.contains('no-sidebar') && narrow());
  };
  const closeDrawer = () => { if (drawerOpen()) document.getElementById('sidebarToggle').click(); };

  function pressEscape() {
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  }

  /* Android's back gesture does what Escape does on the desktop, from the innermost thing
     outwards, and only leaves the app when there is nothing left to close. */
  function onBack() {
    if (window.diarySetup && window.diarySetup.isOpen()) return;
    if (viewerOpen()) { closeViewer(); return; }
    if (overflowOpen()) { closeOverflow(); return; }
    /* Dialogs and the search palette all sit on dialog.js's stack. */
    if (window.diaryDialog && window.diaryDialog.isOpen()) { window.diaryDialog.closeTop(); return; }
    /* A tag being typed, or the list of suggestions under it. */
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#tagRow')) { pressEscape(); return; }
    if (drawerOpen()) { closeDrawer(); return; }
    const results = document.getElementById('tagView');
    if (results && !results.hidden) { pressEscape(); return; }
    if (App) App.minimizeApp();
  }

  /* What the desktop keeps in its menu bar. Each item sends the same action the menu bar
     does, through onMenu, so the page does not need to know which one it came from. */
  let overflow = null;
  const closeOverflow = () => { if (overflow) overflow.hidden = true; };
  const overflowOpen = () => Boolean(overflow && !overflow.hidden);

  function addOverflowMenu() {
    const actions = document.querySelector('.top-actions');
    if (!actions) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-btn';
    button.id = 'overflowBtn';
    button.setAttribute('aria-label', 'More');
    button.setAttribute('aria-haspopup', 'menu');
    button.textContent = '⋮';
    actions.append(button);

    overflow = document.createElement('div');
    overflow.className = 'overflow-menu';
    overflow.setAttribute('role', 'menu');
    overflow.hidden = true;
    const item = (label, run, danger) => {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.setAttribute('role', 'menuitem');
      entry.textContent = label;
      if (danger) entry.className = 'danger';
      entry.addEventListener('click', () => { closeOverflow(); run(); });
      overflow.append(entry);
    };
    const menu = (action) => () => fanOut(listeners.menu, action);
    item('Jump to a date…', menu('jump-to-date'));
    item('Sync now', () => { syncNow(); });
    item('Open in Nextcloud', () => { window.diaryApp.revealFolder(); });
    item('About', menu('about'));
    overflow.append(document.createElement('hr'));
    item('Delete this entry…', menu('delete'), true);
    document.body.append(overflow);

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      overflow.hidden = !overflow.hidden;
      button.setAttribute('aria-expanded', String(!overflow.hidden));
    });
    document.addEventListener('click', (event) => {
      if (overflowOpen() && !overflow.contains(event.target) && event.target !== button) closeOverflow();
    });
  }

  function adaptPage() {
    document.documentElement.classList.add('is-android');
    const hide = (id) => { const node = document.getElementById(id); if (node) node.hidden = true; };
    hide('shortcutsBtn');
    hide('todayKbd');
    hide('revealBtn');
    addOverflowMenu();

    const choose = document.getElementById('bootChoose');
    if (choose) choose.textContent = 'Connect to Nextcloud…';
    const reveal = document.getElementById('settingsReveal');
    if (reveal) reveal.textContent = 'Open in browser';
    const path = document.getElementById('settingsPath');
    const hint = path && path.parentElement && path.parentElement.querySelector('.field-hint');
    if (hint) hint.textContent = 'The folder on your Nextcloud this diary reads and writes. A copy is kept on this phone, so you can write offline.';
    const reminderHint = document.getElementById('reminderHint');
    if (reminderHint) reminderHint.textContent = 'A notification at this time if the day has not been written yet, whether or not the app is open.';

    /* Tapping the reminder opens the app; it should open on the day it was about. */
    if (LocalNotifications) {
      LocalNotifications.addListener('localNotificationActionPerformed', () => fanOut(listeners.menu, 'today'));
    }

    /* Choosing a day from the drawer is the end of what the drawer was opened for. */
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
      sidebar.addEventListener('click', (event) => {
        if (event.target.closest('.cal-day, .entry-list a, .entry-list button, .tag-list button, .tag-list a, #todayBtn, #settingsBtn')) {
          setTimeout(closeDrawer, 0);
        }
      });
    }
    /* A tap on the page beside the open drawer closes it, and does nothing else. */
    document.addEventListener('click', (event) => {
      if (!drawerOpen()) return;
      if (event.target.closest('#sidebar, #sidebarToggle, .dialog-backdrop')) return;
      event.preventDefault();
      event.stopPropagation();
      closeDrawer();
    }, true);

    if (App) {
      App.addListener('backButton', onBack);
      App.addListener('resume', () => { syncNow(); });
      /* Leaving the app is the phone's version of closing the window: save what is on
         screen, then get it to the server while the app still may. */
      App.addListener('pause', () => {
        flushed = null;
        const saved = new Promise((resolve) => { flushed = resolve; setTimeout(resolve, 2000); });
        fanOut(listeners.flush);
        saved.then(() => syncNow());
      });
    }
  }
  let flushed = null;

  /* ---------------------------------------------------------------- settings */

  function loadSettings() {
    return { ...DEFAULT_SETTINGS, ...(readJson(SETTINGS_KEY) || {}), diaryPath: displayPath() || null };
  }

  /* ---------------------------------------------------------------- the bridge */

  const missing = !Filesystem || !Nextcloud;

  window.diaryApp = {
    platform: 'android',
    trashPlace: 'the trash bin on your Nextcloud',
    touch: true,
    version: '0.0.0',   // stamped from package.json by build-www.js

    diaryPath: async () => { await ready; return displayPath(); },
    chooseFolder: async () => {
      const result = await runSetup({ mode: account ? 'folder' : 'connect' });
      return result ? { ok: true, path: displayPath() } : { ok: false, error: 'Cancelled' };
    },
    revealFolder: async () => {
      if (!account) return { ok: false, error: 'Not connected to Nextcloud' };
      await Nextcloud.openUrl({ url: `${account.server}/apps/files/?dir=${encodeURIComponent(`/${account.folder}`)}` });
      return { ok: true };
    },

    list: async () => {
      if (missing) return { ok: false, error: 'This build is missing its Android plugins' };
      await ready;
      const items = [];
      for (const row of await local.list()) {
        const id = window.diaryEntry.idFromFileName(row.name);
        if (id && row.name === `${id}.md`) items.push({ id, mtimeMs: row.mtimeMs, size: row.size });
      }
      items.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      return { ok: true, items };
    },

    read: async (id) => {
      if (!isDate(id)) return fail('That is not a diary date');
      await ready;
      const markdown = await local.readText(`${id}.md`);
      if (markdown === null) return { ok: true, entry: { id, exists: false, markdown: '', mtimeMs: 0 } };
      const stat = await local.stat(`${id}.md`);
      fetchPhotosFor(markdown);
      return { ok: true, entry: { id, exists: true, markdown, mtimeMs: stat ? stat.mtimeMs : 0 } };
    },

    readMany: async (ids) => {
      await ready;
      const entries = [];
      for (const id of (Array.isArray(ids) ? ids : []).filter(isDate).slice(0, 4000)) {
        const markdown = await local.readText(`${id}.md`);
        if (markdown === null) continue;
        const stat = await local.stat(`${id}.md`);
        entries.push({ id, exists: true, markdown, mtimeMs: stat ? stat.mtimeMs : 0 });
      }
      return { ok: true, entries };
    },

    /* Same rule as diary.js: a day with nothing written in it is not created. */
    write: async (id, markdown) => {
      if (!isDate(id) || typeof markdown !== 'string') return fail('That entry could not be saved');
      await ready;
      if (!engine) return fail('Not connected to Nextcloud');
      try {
        const name = `${id}.md`;
        if (window.diaryEntry.isBlank(window.diaryEntry.parse(markdown, id)) && !(await local.exists(name))) {
          return { ok: true, written: false, mtimeMs: 0 };
        }
        await engine.writeEntry(name, markdown);
        const stat = await local.stat(name);
        syncSoon();
        scheduleReminders();
        return { ok: true, written: true, mtimeMs: stat ? stat.mtimeMs : Date.now() };
      } catch (error) {
        return fail((error && error.message) || 'That entry could not be saved');
      }
    },

    /* Deleted here now, and from the server on the next sync — into Nextcloud's trash bin,
       where it can still be restored. */
    remove: async (id) => {
      if (!isDate(id)) return fail('That is not a diary date');
      if (!engine) return fail('Not connected to Nextcloud');
      await engine.deleteEntry(`${id}.md`);
      syncSoon(500);
      return { ok: true, trashed: true };
    },

    exportEntry: async (id, markdown) => {
      if (!isDate(id) || typeof markdown !== 'string') return fail('There is nothing to export');
      try {
        const path = `export/${id}.md`;
        await Filesystem.writeFile({ path, directory: 'CACHE', data: markdown, encoding: 'utf8', recursive: true });
        const { uri } = await Filesystem.getUri({ path, directory: 'CACHE' });
        await Share.share({ title: window.diaryEntry.formatTitle(id, loadSettings().titleStyle), files: [uri] });
        return { ok: true, path: uri };
      } catch (error) {
        const message = String((error && error.message) || '');
        return { ok: false, error: /cancel/i.test(message) ? 'Cancelled' : (message || 'That entry could not be shared') };
      }
    },

    getSettings: async () => loadSettings(),
    setSettings: async (patch) => {
      if (!patch || typeof patch !== 'object') return fail('Nothing to change');
      const before = loadSettings();
      const next = { ...before, ...JSON.parse(JSON.stringify(patch)) };
      delete next.diaryPath;
      let refused = false;
      if (next.reminderEnabled && !before.reminderEnabled && !(await mayNotify())) {
        next.reminderEnabled = false;
        refused = true;
      }
      writeJson(SETTINGS_KEY, next);
      if (['reminderEnabled', 'reminderTime', 'dayStartHour'].some(key => next[key] !== before[key])) scheduleReminders();
      if (refused) return { ok: false, error: 'Notifications are off for daily-diary — allow them in Android settings to get a reminder', settings: loadSettings() };
      return { ok: true, settings: loadSettings() };
    },

    photos: {
      add: async (id) => {
        if (!isDate(id)) return fail('That is not a diary date');
        const files = await pickImages();
        if (!files.length) return { ok: false, error: 'Cancelled' };
        const added = [];
        const failed = [];
        for (const file of files.slice(0, 40)) {
          const type = String(file.type || '').toLowerCase();
          const extension = EXTENSION_FOR[type];
          if (!extension) {
            failed.push(/heic|heif/.test(type) || /\.hei[cf]$/i.test(file.name || '')
              ? `${file.name || 'That photo'} is HEIC, which cannot be shown — set the camera to “Most compatible” / JPEG`
              : `${file.name || 'That file'} is not an image this app can show`);
            continue;
          }
          try {
            const result = await writePhoto(id, extension, new Uint8Array(await file.arrayBuffer()));
            if (result.ok) added.push(result); else failed.push(result.error);
          } catch (error) {
            failed.push((error && error.message) || file.name || 'A photo could not be added');
          }
        }
        return { ok: added.length > 0, added, failed, error: added.length ? '' : (failed[0] || 'Nothing could be added') };
      },
      write: async (id, extension, bytes) => {
        if (!isDate(id)) return fail('That is not a diary date');
        if (!bytes || !(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))) return fail('There was nothing to save');
        const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        try {
          return await writePhoto(id, extension, view);
        } catch (error) {
          return fail((error && error.message) || 'That photo could not be saved');
        }
      },
      remove: async (id, filename) => {
        if (!isDate(id) || typeof filename !== 'string' || !filename || /[/\\]/.test(filename)) return fail('That photo could not be removed');
        const path = `${id}-assets/${filename}`;
        try { await Filesystem.deleteFile({ path: rel(path), directory: DIR }); } catch { /* not downloaded yet */ }
        if (engine) { await engine.queuePhoto('delete', path); syncSoon(); }
        return { ok: true, trashed: true };
      },
      list: async (id) => {
        if (!isDate(id)) return fail('That is not a diary date');
        try {
          const { files } = await Filesystem.readdir({ path: rel(`${id}-assets`), directory: DIR });
          return { ok: true, names: files.map(file => file.name).filter(name => IMAGE_TYPES[extensionOf(name)]).sort() };
        } catch {
          return { ok: true, names: [] };
        }
      },
      open: async (id, filename) => {
        if (!isDate(id) || typeof filename !== 'string' || !filename) return fail('That photo could not be opened');
        openViewer(assetUrl(id, filename), '');
        return { ok: true };
      }
    },

    /* The page's photos live in the app's own storage; these turn a day's relative photo
       path into something the WebView can load, and back. */
    assetUrl,
    assetPath,

    /* A day that changed on the server while this phone had its own unsent changes to it.
       sync.js holds both and uploads neither until the page says which one to keep. */
    heldConflict: async (id) => (engine && isDate(id) ? engine.conflictFor(`${id}.md`) : null),
    resolveConflict: async (id, choice) => {
      if (!engine || !isDate(id)) return { ok: false };
      await engine.resolve(`${id}.md`, choice === 'theirs' ? 'theirs' : 'mine');
      syncSoon(300);
      return { ok: true };
    },

    openExternal: async (url) => {
      try {
        await Nextcloud.openUrl({ url: String(url) });
        return { ok: true };
      } catch (error) {
        return fail((error && error.message) || 'That link could not be opened');
      }
    },

    onMenu: (handler) => { if (typeof handler === 'function') listeners.menu.push(handler); },
    onChanged: (handler) => { if (typeof handler === 'function') listeners.changed.push(handler); },
    onContextMenu: () => {},
    onFlushRequest: (handler) => { if (typeof handler === 'function') listeners.flush.push(handler); },
    flushed: () => { if (flushed) flushed(); },

    /* Android's keyboard does its own spelling suggestions. */
    replaceMisspelling: () => {},
    addToDictionary: () => {}
  };

  if (missing) {
    readyResolve();
    return;
  }
  adaptPage();
  init().catch((error) => {
    setBootMessage((error && error.message) || 'Could not start');
    readyResolve();
  });
})();
