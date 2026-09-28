/* Application menu. Every custom item sends an action string to the focused window; the
   renderer decides what it means. */
'use strict';

const { app, BrowserWindow, Menu } = require('electron');

const CHANNEL = 'diary:menu';
const isMac = process.platform === 'darwin';

function send(action) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(CHANNEL, action);
}

/* Ctrl+B is bold inside the editor, so the sidebar toggle takes Ctrl+\ instead. */
const item = (label, action, accelerator) => ({ label, accelerator, click: () => send(action) });

function buildTemplate(options = {}) {
  const dev = Boolean(options.dev);

  const file = {
    label: '&File',
    submenu: [
      item("Today's Entry", 'today', 'CmdOrCtrl+T'),
      { type: 'separator' },
      item('Save', 'save', 'CmdOrCtrl+S'),
      item('Export This Entry…', 'export', 'CmdOrCtrl+E'),
      item('Delete This Entry…', 'delete', 'CmdOrCtrl+Shift+Backspace'),
      { type: 'separator' },
      item('Choose Diary Folder…', 'choose-folder'),
      item('Open Diary Folder', 'reveal-folder'),
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit', label: 'Exit' }
    ]
  };

  const edit = {
    label: '&Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
      { type: 'separator' },
      item('Add a Photo…', 'add-photo', 'CmdOrCtrl+Shift+P'),
      item('Add a Tag…', 'add-tag', 'CmdOrCtrl+Shift+A'),
      item('Add a Section…', 'add-section'),
      { type: 'separator' },
      item('Search Your Diary…', 'search', 'CmdOrCtrl+K')
    ]
  };

  /* Alt+Arrow rather than Ctrl+Arrow: Ctrl+Left/Right is word-by-word movement inside the
     text, and stealing it would make writing worse to make navigating better. */
  const go = {
    label: '&Go',
    submenu: [
      item('Previous Day', 'previous-day', 'Alt+Left'),
      item('Next Day', 'next-day', 'Alt+Right'),
      { type: 'separator' },
      item('Previous Entry Written', 'previous-entry', 'Alt+Shift+Left'),
      item('Next Entry Written', 'next-entry', 'Alt+Shift+Right'),
      { type: 'separator' },
      item('Jump to Date…', 'jump-to-date', 'CmdOrCtrl+G'),
      item('Today', 'today', 'CmdOrCtrl+Shift+T')
    ]
  };

  const view = {
    label: '&View',
    submenu: [
      item('Toggle Sidebar', 'toggle-sidebar', 'CmdOrCtrl+\\'),
      item('Toggle Dark Mode', 'toggle-theme', 'CmdOrCtrl+Shift+D'),
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(dev ? [{ type: 'separator' }, { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }] : [])
    ]
  };

  const help = {
    label: '&Help',
    role: 'help',
    submenu: [
      item('Settings…', 'settings', 'CmdOrCtrl+,'),
      item('Keyboard Shortcuts', 'shortcuts', 'CmdOrCtrl+/'),
      item(`About ${app.name}`, 'about')
    ]
  };

  const template = [file, edit, go, view, help];

  if (isMac) {
    template.unshift({
      label: app.name,
      submenu: [
        item(`About ${app.name}`, 'about'),
        { type: 'separator' },
        item('Settings…', 'settings', 'Command+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
    template.push({ label: 'Window', role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] });
  }

  return template;
}

function installMenu(options) {
  const menu = Menu.buildFromTemplate(buildTemplate(options));
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { CHANNEL, buildTemplate, installMenu, send };
