/* Remembers where the window was, and refuses to restore it onto a monitor that is gone. */
'use strict';

const { app, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = 'window-state.json';
const DEFAULTS = { width: 1440, height: 900, maximized: false };
const MIN = { width: 680, height: 480 };

const statePath = () => path.join(app.getPath('userData'), FILE);

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);

/* A window is only "visible" if a decent slice of it lands on a connected display —
   bounds saved on a second monitor must not reopen off-screen. */
function onScreen(bounds) {
  let displays = [];
  try {
    displays = screen.getAllDisplays();
  } catch {
    return false;
  }
  return displays.some(display => {
    const area = display.workArea;
    const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const height = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    if (width <= 0 || height <= 0) return false;
    return width * height >= Math.min(bounds.width * bounds.height * 0.3, 240 * 160);
  });
}

/* Returns BrowserWindow options plus a `maximized` hint the caller applies after creation. */
function restore() {
  const saved = read();
  const width = Math.max(MIN.width, number(saved.width) || DEFAULTS.width);
  const height = Math.max(MIN.height, number(saved.height) || DEFAULTS.height);
  const state = { width, height, maximized: Boolean(saved.maximized) };
  const x = number(saved.x);
  const y = number(saved.y);
  if (x !== null && y !== null && onScreen({ x, y, width, height })) {
    state.x = x;
    state.y = y;
  }
  return state;
}

function manage(win) {
  let timer = null;
  const save = () => {
    try {
      const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
      const payload = { ...bounds, maximized: win.isMaximized() };
      fs.mkdirSync(path.dirname(statePath()), { recursive: true });
      fs.writeFileSync(statePath(), `${JSON.stringify(payload, null, 2)}\n`);
    } catch {
      // Losing the window position is never worth an error dialog.
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) win.on(event, schedule);
  win.on('close', () => {
    clearTimeout(timer);
    save();
  });
}

module.exports = { restore, manage };
