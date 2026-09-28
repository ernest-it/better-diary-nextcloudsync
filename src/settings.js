/* Renderer-side settings. The main process owns the file on disk, but a copy is mirrored
   into localStorage so the very first paint can pick the theme up synchronously — waiting
   for the async getSettings() round trip would flash a white window at somebody opening
   their diary at midnight. */
const diarySettings = (() => {
  const KEY = 'daily-diary:settings';
  const THEMES = ['system', 'light', 'dark'];
  const TITLE_STYLES = ['long', 'us', 'short', 'iso'];
  const BODY_FONTS = ['sans', 'serif'];
  const DEFAULTS = {
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

  const listeners = new Set();
  let current = { ...DEFAULTS };
  let watching = false;

  const bridge = () => (window.diaryApp && typeof window.diaryApp.getSettings === 'function' ? window.diaryApp : null);

  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  };

  const headingList = (value) => {
    const list = [];
    for (const item of Array.isArray(value) ? value : []) {
      const heading = String(item == null ? '' : item).replace(/[\r\n]+/g, ' ').trim();
      if (heading && !list.some(existing => existing.toLowerCase() === heading.toLowerCase())) list.push(heading);
    }
    return list;
  };

  /* Never trust a stored payload: a truncated write or a hand-edited settings.json must not
     be able to take the app down, so every field falls back to the current value. */
  function sanitise(patch, base) {
    const next = { ...base };
    if (!patch || typeof patch !== 'object') return next;
    if (THEMES.includes(patch.theme)) next.theme = patch.theme;
    if (TITLE_STYLES.includes(patch.titleStyle)) next.titleStyle = patch.titleStyle;
    if (BODY_FONTS.includes(patch.bodyFont)) next.bodyFont = patch.bodyFont;
    if ('fontScale' in patch) next.fontScale = Math.round(clamp(patch.fontScale, 0.85, 1.4, base.fontScale) * 100) / 100;
    if ('autosaveMs' in patch) next.autosaveMs = Math.round(clamp(patch.autosaveMs, 200, 10000, base.autosaveMs));
    if ('dayStartHour' in patch) next.dayStartHour = Math.round(clamp(patch.dayStartHour, 0, 12, base.dayStartHour));
    if ('diaryPath' in patch) next.diaryPath = typeof patch.diaryPath === 'string' && patch.diaryPath ? patch.diaryPath : null;
    if ('spellcheck' in patch) next.spellcheck = Boolean(patch.spellcheck);
    if ('sidebarVisible' in patch) next.sidebarVisible = Boolean(patch.sidebarVisible);
    if ('headings' in patch) {
      const list = headingList(patch.headings).slice(0, 12);
      next.headings = list.length ? list : base.headings.slice();
    }
    return next;
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
  }

  function writeLocal(value) {
    try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* the main process copy is the real one */ }
  }

  function notify() {
    const snapshot = { ...current };
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch (error) { console.warn('diarySettings subscriber failed', error); }
    }
  }

  /* The three hooks the stylesheet reads on <html>: data-theme, data-body-font, and the
     --font-scale custom property. 'system' removes the attribute so the prefers-color-scheme query wins. */
  function apply() {
    const root = document.documentElement;
    if (current.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = current.theme;
    if (current.bodyFont === 'serif') root.dataset.bodyFont = 'serif';
    else delete root.dataset.bodyFont;
    root.style.setProperty('--font-scale', String(current.fontScale));
    return { ...current };
  }

  function watchSystemTheme() {
    if (watching || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (current.theme !== 'system') return;
      apply();
      notify();
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
    else if (typeof media.addListener === 'function') media.addListener(onChange);
    watching = true;
  }

  async function load() {
    current = sanitise(readLocal(), DEFAULTS);
    apply();
    const api = bridge();
    if (api) {
      let stored = null;
      try { stored = await api.getSettings(); } catch { stored = null; }
      if (stored && typeof stored === 'object') {
        current = sanitise(stored, current);
        writeLocal(current);
        apply();
      }
    }
    notify();
    return { ...current };
  }

  /* Applies and notifies straight away, then persists. Resolves with { ok, settings } so a
     caller that cares can report a failed write; ignoring the promise is safe. */
  function set(patch) {
    current = sanitise(patch, current);
    apply();
    writeLocal(current);
    notify();
    const api = bridge();
    if (!api || typeof api.setSettings !== 'function') return Promise.resolve({ ok: true, settings: { ...current } });
    return Promise.resolve()
      .then(() => api.setSettings({ ...current }))
      .then((result) => (result && result.ok
        ? { ok: true, settings: { ...current } }
        : { ok: false, error: (result && result.error) || 'Settings could not be saved', settings: { ...current } }))
      .catch((error) => ({ ok: false, error: (error && error.message) || String(error), settings: { ...current } }));
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  current = sanitise(readLocal(), DEFAULTS);
  apply();
  watchSystemTheme();

  return {
    get: () => ({ ...current }),
    defaults: () => ({ ...DEFAULTS }),
    set,
    subscribe,
    apply,
    load,
    ready: load()
  };
})();

window.diarySettings = diarySettings;
