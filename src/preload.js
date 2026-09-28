/* The whole renderer-visible surface. No fs, no ipcRenderer and no node global leaks past
   this file — everything crossing it is re-typed on the way through. */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const DEFAULT_SETTINGS = {
  theme: 'system',
  fontScale: 1,
  diaryPath: null,
  autosaveMs: 700,
  spellcheck: true,
  sidebarVisible: true,
  headings: ['How the day went', 'Notes', 'Tomorrow'],
  titleStyle: 'long',
  dayStartHour: 4,
  bodyFont: 'sans'
};

/* Nothing here may reject: callers branch on result.ok, never on a catch. */
async function call(channel, ...args) {
  try {
    const result = await ipcRenderer.invoke(channel, ...args);
    return result === undefined ? { ok: false, error: 'No response from the app' } : result;
  } catch (error) {
    return { ok: false, error: (error && error.message) || 'The app could not complete that' };
  }
}

const fail = (error) => Promise.resolve({ ok: false, error });
const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/* Synchronous so `platform` and `version` are plain values on the exposed object. */
let info = { version: '0.0.0', platform: process.platform };
try {
  const reply = ipcRenderer.sendSync('diary:app-info');
  if (reply && typeof reply === 'object') info = { ...info, ...reply };
} catch {
  // Fall back to the defaults above.
}

const listeners = { menu: [], changed: [], context: [], flush: [] };
const fanOut = (bucket) => (...args) => {
  for (const handler of bucket) {
    try {
      handler(...args);
    } catch {
      // One bad listener must not stop the others.
    }
  }
};

ipcRenderer.on('diary:menu', (_event, action) => fanOut(listeners.menu)(String(action || '')));
ipcRenderer.on('diary:changed', () => fanOut(listeners.changed)());
ipcRenderer.on('diary:flush', () => fanOut(listeners.flush)());
ipcRenderer.on('diary:context-menu', (_event, params) => fanOut(listeners.context)({
  x: Number(params && params.x) || 0,
  y: Number(params && params.y) || 0,
  editable: Boolean(params && params.editable),
  misspelledWord: String((params && params.misspelledWord) || ''),
  suggestions: Array.isArray(params && params.suggestions) ? params.suggestions.map(String) : []
}));

contextBridge.exposeInMainWorld('diaryApp', {
  platform: info.platform,
  version: info.version,

  diaryPath: async () => {
    const result = await call('diary:path');
    return result && result.ok && typeof result.path === 'string' ? result.path : '';
  },
  chooseFolder: () => call('diary:choose'),
  revealFolder: () => call('diary:reveal'),

  list: () => call('diary:list'),
  read: (id) => (isDate(id) ? call('diary:read', String(id)) : fail('That is not a diary date')),
  readMany: (ids) => call('diary:read-many', (Array.isArray(ids) ? ids : []).filter(isDate).map(String)),
  write: (id, markdown) => (isDate(id) && typeof markdown === 'string'
    ? call('diary:write', String(id), String(markdown))
    : fail('That entry could not be saved')),
  remove: (id) => (isDate(id) ? call('diary:delete', String(id)) : fail('That is not a diary date')),
  exportEntry: (id, markdown) => (isDate(id) && typeof markdown === 'string'
    ? call('diary:export', String(id), String(markdown))
    : fail('There is nothing to export')),

  getSettings: async () => {
    const result = await call('settings:get');
    return result && typeof result === 'object' && !result.error ? { ...DEFAULT_SETTINGS, ...result } : { ...DEFAULT_SETTINGS };
  },
  setSettings: (patch) => (patch && typeof patch === 'object'
    ? call('settings:set', JSON.parse(JSON.stringify(patch)))
    : fail('Nothing to change')),

  /* ---- photos ----
     Files are copied into <date>-assets/ beside the entry. The page never sees a path,
     only the name it got back and the diary-asset: URL it can render. */
  photos: {
    add: (id) => (isDate(id) ? call('photo:add', String(id)) : fail('That is not a diary date')),
    write: (id, extension, bytes) => {
      if (!isDate(id)) return fail('That is not a diary date');
      if (!bytes || !(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))) return fail('There was nothing to save');
      const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return call('photo:write', String(id), String(extension || '').toLowerCase(), view);
    },
    remove: (id, filename) => (isDate(id) && typeof filename === 'string' && filename
      ? call('photo:remove', String(id), String(filename))
      : fail('That photo could not be removed')),
    list: (id) => (isDate(id) ? call('photo:list', String(id)) : fail('That is not a diary date')),
    open: (id, filename) => (isDate(id) && typeof filename === 'string' && filename
      ? call('photo:open', String(id), String(filename))
      : fail('That photo could not be opened'))
  },

  openExternal: (url) => (typeof url === 'string' && url.trim() ? call('shell:open-external', String(url)) : fail('That is not a valid link')),

  onMenu: (handler) => { if (typeof handler === 'function') listeners.menu.push(handler); },
  onChanged: (handler) => { if (typeof handler === 'function') listeners.changed.push(handler); },
  onContextMenu: (handler) => { if (typeof handler === 'function') listeners.context.push(handler); },
  /* The app is closing: save now, then say so. */
  onFlushRequest: (handler) => { if (typeof handler === 'function') listeners.flush.push(handler); },
  flushed: () => ipcRenderer.send('diary:flushed'),

  replaceMisspelling: (word) => {
    if (typeof word === 'string' && word.trim()) ipcRenderer.send('diary:spell', 'replace', String(word));
  },
  addToDictionary: (word) => {
    if (typeof word === 'string' && word.trim()) ipcRenderer.send('diary:spell', 'add', String(word));
  }
});
