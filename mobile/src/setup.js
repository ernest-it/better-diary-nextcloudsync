/* Connecting the phone to a Nextcloud, and choosing which folder on it is the diary.

   Logging in is Nextcloud's Login Flow v2: the server's own login page opens in the phone's
   browser — where the person's password manager and two-factor app already are — and the
   server hands this app a password of its own. This app never sees the real password, and
   the app password can be revoked on its own from Nextcloud's Settings ▸ Security.

   run({ mode }) resolves with { server, user, folder } or null when cancelled.
     mode 'connect' — first run: log in, then pick the folder
     'folder'       — already connected: pick a different folder, or sign out
     'reauth'       — the server stopped accepting our app password: log in again */
const diarySetup = (() => {
  'use strict';

  const DEFAULT_FOLDER = 'Notes/Diary';
  const POLL_MS = 2000;
  const POLL_FOR_MS = 20 * 60 * 1000;

  let root = null;
  let open = false;

  const isOpen = () => open;

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function screen(...children) {
    if (!root) {
      root = h('div', { class: 'setup', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'setupTitle' });
      document.body.append(root);
    }
    root.hidden = false;
    root.textContent = '';
    root.append(h('div', { class: 'setup-card' }, h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '❦'), ...children));
    /* Only the address field opens the keyboard; on the folder screen it would cover the list. */
    const first = root.querySelector('input[type=url], .btn.primary');
    if (first) setTimeout(() => first.focus(), 50);
  }

  function close() {
    open = false;
    if (root) { root.hidden = true; root.textContent = ''; }
  }

  /* ---------------------------------------------------------------- talking to the server */

  /* What people type: "cloud.example.com", "https://cloud.example.com/", or a link they
     copied out of the browser with /apps/files/… or /index.php/… on the end. */
  function normaliseServer(input) {
    let text = String(input || '').trim();
    if (!text) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
    let url;
    try { url = new URL(text); } catch { return ''; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    let path = url.pathname.replace(/\/(index\.php|apps|login|remote\.php|ocs)(\/.*)?$/, '').replace(/\/+$/, '');
    if (path === '/') path = '';
    return `${url.protocol}//${url.host}${path}`;
  }

  const json = (text) => { try { return JSON.parse(text); } catch { return null; } };

  /* ---------------------------------------------------------------- the screens */

  function connectScreen(nextcloud, message) {
    return new Promise((resolve) => {
      const error = h('p', { class: 'setup-error', role: 'alert' }, message || '');
      const input = h('input', {
        type: 'url', id: 'setupServer', class: 'setup-input', inputmode: 'url', autocomplete: 'url',
        autocapitalize: 'off', spellcheck: 'false', placeholder: 'cloud.example.com', 'aria-describedby': 'setupServerHint'
      });
      const button = h('button', { type: 'submit', class: 'btn primary' }, 'Log in');

      const form = h('form', { class: 'setup-form', novalidate: true, onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        const server = normaliseServer(input.value);
        if (!server) { error.textContent = 'Type the address you use to open Nextcloud in a browser.'; return; }
        button.disabled = true;
        button.textContent = 'Connecting…';
        const started = await nextcloud.request({ method: 'POST', url: `${server}/index.php/login/v2`, headers: {}, body: '' }).catch(() => null);
        button.disabled = false;
        button.textContent = 'Log in';
        const flow = started && started.status === 200 ? json(started.text) : null;
        if (!started || started.status === 0) {
          error.textContent = /cleartext|CLEARTEXT/.test(String(started && started.error))
            ? 'That address is plain http. Your login has to go over https.'
            : `Could not reach ${server}. Check the address and that the phone is online.`;
          return;
        }
        if (!flow || !flow.poll || !flow.login) {
          error.textContent = 'That address answered, but not like a Nextcloud server. Check it is the one you open in a browser.';
          return;
        }
        resolve({ server, flow });
      } },
      h('label', { class: 'field-label', for: 'setupServer' }, 'Your Nextcloud address'),
      input,
      h('div', { class: 'field-hint', id: 'setupServerHint' }, 'The address you open Nextcloud at in a browser.'),
      error,
      h('div', { class: 'setup-actions' }, button));

      screen(
        h('h2', { id: 'setupTitle' }, 'Connect to your Nextcloud'),
        h('p', {}, 'Your diary is kept in a folder on your Nextcloud, one Markdown file per day — the same folder the desktop app writes to.'),
        form
      );
    });
  }

  /* Opens the server's login page in the browser and waits for it to hand over an app
     password. Resolves null if cancelled or it times out. */
  function waitForLogin(nextcloud, server, flow) {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (value) => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } };
      const openLogin = () => nextcloud.openUrl({ url: flow.login }).catch(() => {});
      const note = h('p', { class: 'setup-error', role: 'alert' });

      screen(
        h('h2', { id: 'setupTitle' }, 'Log in in your browser'),
        h('p', {}, `Your browser is showing ${server}. Log in there and grant access to daily-diary, then come back here.`),
        h('div', { class: 'setup-waiting', role: 'status' }, h('span', { class: 'setup-spinner', 'aria-hidden': 'true' }), 'Waiting for Nextcloud…'),
        note,
        h('div', { class: 'setup-actions' },
          h('button', { type: 'button', class: 'btn ghost', onclick: () => finish(null) }, 'Cancel'),
          h('button', { type: 'button', class: 'btn', onclick: openLogin }, 'Open the login page again'))
      );

      const deadline = Date.now() + POLL_FOR_MS;
      let timer = null;
      const poll = async () => {
        if (finished) return;
        if (Date.now() > deadline) { finish(null); return; }
        const reply = await nextcloud.request({
          method: 'POST',
          url: flow.poll.endpoint,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `token=${encodeURIComponent(flow.poll.token)}`
        }).catch(() => null);
        if (finished) return;
        const granted = reply && reply.status === 200 ? json(reply.text) : null;
        if (granted && granted.appPassword && granted.loginName) { finish(granted); return; }
        note.textContent = reply && reply.status === 0 ? 'Offline — waiting for the connection to come back…' : '';
        timer = setTimeout(poll, POLL_MS);
      };
      openLogin();
      timer = setTimeout(poll, POLL_MS);
    });
  }

  /* Walks the server's folders. Starts in Notes/Diary if it is there — it is where the
     desktop app looks first — and otherwise wherever the path gets furthest. */
  async function folderScreen(nextcloud, who, { current, canCancel, canSignOut }) {
    const davRoot = `${who.server}/remote.php/dav/files/${encodeURIComponent(who.user)}`;
    const transport = (request) => nextcloud.request({ ...request, auth: true });
    const dav = window.diaryDav.create({ transport, root: davRoot });

    let path = '';
    for (const candidate of [current, DEFAULT_FOLDER, 'Notes'].filter(Boolean)) {
      try {
        if (await dav.list(candidate)) { path = candidate; break; }
      } catch { /* try the next */ }
    }
    const wanted = path || DEFAULT_FOLDER;

    return new Promise((resolve) => {
      const error = h('p', { class: 'setup-error', role: 'alert' });
      const list = h('div', { class: 'setup-folders', role: 'list' });
      const summary = h('div', { class: 'field-hint', 'aria-live': 'polite' });
      const input = h('input', {
        type: 'text', id: 'setupFolder', class: 'setup-input', autocapitalize: 'off', spellcheck: 'false', value: wanted
      });
      let shown = null;

      async function show(folder) {
        shown = folder;
        input.value = folder || '';
        list.textContent = '';
        summary.textContent = 'Looking…';
        error.textContent = '';
        let rows;
        try {
          rows = await dav.list(folder);
        } catch (failure) {
          if (shown !== folder) return;
          summary.textContent = '';
          error.textContent = (failure && failure.message) || 'That folder could not be read';
          return;
        }
        if (shown !== folder) return;
        if (rows === null) {
          summary.textContent = 'This folder does not exist yet — it will be created.';
          return;
        }
        const entries = rows.filter(row => !row.isDir && /^\d{4}-\d{2}-\d{2}\.md$/.test(row.name)).length;
        summary.textContent = entries
          ? `${entries} diary ${entries === 1 ? 'entry' : 'entries'} in this folder.`
          : 'No diary entries in this folder yet.';
        if (folder) {
          const up = folder.split('/').slice(0, -1).join('/');
          list.append(h('button', { type: 'button', class: 'setup-folder up', role: 'listitem', onclick: () => show(up) },
            h('span', { 'aria-hidden': 'true' }, '↰'), up ? `Up to ${up}` : 'Up to your files'));
        }
        for (const row of rows.filter(item => item.isDir && !/-assets$/.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
          const next = folder ? `${folder}/${row.name}` : row.name;
          list.append(h('button', { type: 'button', class: 'setup-folder', role: 'listitem', onclick: () => show(next) },
            h('span', { 'aria-hidden': 'true' }, '🗀'), row.name));
        }
      }

      input.addEventListener('change', () => show(input.value.split('/').map(part => part.trim()).filter(Boolean).join('/')));

      const use = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        const folder = input.value.split('/').map(part => part.trim()).filter(Boolean).join('/');
        if (!folder) { error.textContent = 'Choose a folder rather than the top of your files.'; return; }
        use.disabled = true;
        try {
          if ((await dav.list(folder)) === null) await dav.makeFolders(folder);
          resolve({ folder });
        } catch (failure) {
          error.textContent = (failure && failure.message) || 'That folder could not be used';
          use.disabled = false;
        }
      } }, 'Use this folder');

      screen(
        h('h2', { id: 'setupTitle' }, 'Where is your diary?'),
        h('p', {}, 'Choose the folder on your Nextcloud that holds the diary. If the desktop app already writes one, pick the same folder.'),
        h('label', { class: 'field-label', for: 'setupFolder' }, 'Folder'),
        input,
        summary,
        list,
        error,
        h('div', { class: 'setup-actions' },
          canSignOut ? h('button', { type: 'button', class: 'btn ghost', onclick: () => resolve({ signOut: true }) }, 'Sign out') : null,
          canCancel ? h('button', { type: 'button', class: 'btn', onclick: () => resolve(null) }, 'Cancel') : null,
          use)
      );
      show(wanted);
    });
  }

  /* ---------------------------------------------------------------- the whole thing */

  async function logIn(nextcloud, message) {
    for (;;) {
      const { server, flow } = await connectScreen(nextcloud, message);
      const granted = await waitForLogin(nextcloud, server, flow);
      if (!granted) { message = ''; continue; }

      /* The server may name itself differently from what was typed (a redirect to https,
         a trailing path); what it says is what its app password is valid for. */
      const confirmed = normaliseServer(granted.server) || server;
      await nextcloud.saveAccount({ server: confirmed, user: granted.loginName, loginName: granted.loginName, password: granted.appPassword });
      /* The login name can be an email address; WebDAV paths use the account's id. */
      const me = await nextcloud.request({
        method: 'GET', url: `${confirmed}/ocs/v2.php/cloud/user?format=json`,
        headers: { 'OCS-APIRequest': 'true', Accept: 'application/json' }, auth: true
      }).catch(() => null);
      const id = me && me.status === 200 ? ((json(me.text) || {}).ocs || {}).data : null;
      const user = id && id.id ? String(id.id) : granted.loginName;
      if (user !== granted.loginName) {
        await nextcloud.saveAccount({ server: confirmed, user, loginName: granted.loginName, password: granted.appPassword });
      }
      return { server: confirmed, user };
    }
  }

  async function run({ mode, account, nextcloud }) {
    open = true;
    try {
      let who = null;
      if (mode === 'folder' && account) {
        who = { server: account.server, user: account.user };
      } else {
        who = await logIn(nextcloud, mode === 'reauth' ? 'Nextcloud no longer accepts this phone’s login — it may have been revoked. Log in again to keep syncing.' : '');
        if (mode === 'reauth' && account && who.server === account.server && who.user === account.user) {
          return { ...who, folder: account.folder };
        }
      }

      for (;;) {
        const choice = await folderScreen(nextcloud, who, {
          current: account && account.server === who.server && account.user === who.user ? account.folder : '',
          canCancel: mode === 'folder',
          canSignOut: mode === 'folder'
        });
        if (!choice) return null;
        if (choice.signOut) {
          await nextcloud.clearAccount();
          who = await logIn(nextcloud, '');
          account = null;
          continue;
        }
        return { ...who, folder: choice.folder };
      }
    } finally {
      close();
    }
  }

  return { run, isOpen, normaliseServer };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = diarySetup;
if (typeof window !== 'undefined') window.diarySetup = diarySetup;
