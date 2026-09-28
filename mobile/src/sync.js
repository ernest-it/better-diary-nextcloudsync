/* The phone keeps a copy of the diary folder, and this keeps that copy and the one on the
   Nextcloud server in step.

   The desktop app never needed this: the Nextcloud client does it there. On the phone the
   app is its own sync client, so the rules the desktop app keeps for the open day have to
   hold for every day, including ones written offline:

   - For every day, `base` is the version both sides last agreed on: the server's etag, and
     a hash of the text. A day whose local text no longer matches the hash was written on the
     phone; a day whose etag moved was written somewhere else.
   - Written here only: upload it, conditional on the server still holding `base`.
   - Written there only: bring it down.
   - Written in both places: neither wins. The server's copy is held beside the phone's as a
     conflict, nothing about that day is uploaded, and the page asks which one to keep —
     the same question the desktop app asks, with the same two answers.
   - Deleted here, untouched there: deleted there too (into Nextcloud's trash bin).
     Deleted in one place but edited in the other: the edit wins, because an unwanted day
     is easier to delete again than a lost one is to write again.

   Photos are simpler. A photo's name is never reused, so it is only ever added or
   removed; those wait in a queue until the server is reachable.

   Pure: the server is `dav` (dav.js), the phone's folder is `local`, and the bookkeeping
   is loaded and saved through `store`. The tests run it against a fake server under node. */
const diarySync = (() => {
  const ENTRY_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
  const ASSET_DIR_RE = /^\d{4}-\d{2}-\d{2}-assets$/;

  /* FNV-1a, with the length alongside. Only ever compared with itself, to answer "is this
     the text we last agreed on" without keeping a second copy of the whole diary. */
  function hash(text) {
    const value = String(text == null ? '' : text);
    let h = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
      h ^= value.charCodeAt(index);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${value.length}:${h.toString(16)}`;
  }

  function create({ dav, local, store, folder }) {
    const root = String(folder || '').split('/').filter(Boolean).join('/');
    const remotePath = (name) => (root ? `${root}/${name}` : name);

    let state = null;
    const blank = () => ({ files: {}, conflicts: {}, queue: [] });

    async function load() {
      if (state) return state;
      let stored = null;
      try { stored = await store.load(); } catch { stored = null; }
      state = blank();
      if (stored && typeof stored === 'object') {
        if (stored.files && typeof stored.files === 'object') state.files = stored.files;
        if (stored.conflicts && typeof stored.conflicts === 'object') state.conflicts = stored.conflicts;
        if (Array.isArray(stored.queue)) state.queue = stored.queue.filter(item => item && typeof item.path === 'string');
      }
      return state;
    }

    const save = () => store.save(JSON.parse(JSON.stringify(state)));

    /* Local check-then-write, one day at a time: a save from the page and a download from
       the server must not interleave on the same file. The network is never waited on
       while holding it. */
    const locks = new Map();
    function withLock(name, task) {
      const previous = locks.get(name) || Promise.resolve();
      const next = previous.then(task, task);
      const settled = next.catch(() => {});
      locks.set(name, settled);
      settled.then(() => { if (locks.get(name) === settled) locks.delete(name); });
      return next;
    }

    /* The page's own writes. The text is what the page just saved; the stat is whatever
       the phone's folder now says, which is what the next sync compares against. */
    async function writeEntry(name, text) {
      return withLock(name, () => local.writeText(name, text));
    }

    async function deleteEntry(name) {
      await load();
      await withLock(name, () => local.remove(name));
      const base = state.files[name];
      delete state.conflicts[name];
      if (base) base.deleted = true;
      /* Its photos go with it, on the server as well as here. Uploads still waiting for a
         photo of this day are pointless now. */
      const dir = name.replace(/\.md$/, '-assets');
      state.queue = state.queue.filter(item => !(item.op === 'upload' && item.path.startsWith(`${dir}/`)));
      if (base) state.queue.push({ op: 'delete', path: dir });
      await local.removeDir(dir);
      await save();
    }

    async function queuePhoto(op, path) {
      await load();
      if (op === 'delete') {
        /* Removing a photo that never reached the server just cancels its upload. */
        const before = state.queue.length;
        state.queue = state.queue.filter(item => !(item.op === 'upload' && item.path === path));
        if (state.queue.length === before) state.queue.push({ op: 'delete', path });
      } else {
        state.queue.push({ op: 'upload', path });
      }
      await save();
    }

    /* ---------------------------------------------------------------- conflicts */

    async function conflictFor(name) {
      await load();
      const held = state.conflicts[name];
      return held ? String(held.text) : null;
    }

    /* 'mine': the phone's version goes up over the server's. 'theirs': the server's
       version replaces the phone's. Either way the day syncs normally again afterwards. */
    async function resolve(name, choice) {
      await load();
      const held = state.conflicts[name];
      if (!held) return;
      delete state.conflicts[name];
      if (choice === 'theirs') {
        await withLock(name, () => local.writeText(name, held.text));
        const stat = await local.stat(name);
        state.files[name] = { etag: held.etag, hash: hash(held.text), size: stat ? stat.size : -1, mtimeMs: stat ? stat.mtimeMs : -1 };
      } else {
        /* Agreeing on their etag with a hash that matches nothing makes the next pass
           upload ours with If-Match on theirs — which still refuses if a third version
           has arrived in the meantime. */
        state.files[name] = { etag: held.etag, hash: '', size: -1, mtimeMs: -1 };
      }
      await save();
    }

    /* ---------------------------------------------------------------- photos */

    async function runQueue() {
      const remaining = [];
      const made = new Set();
      for (let index = 0; index < state.queue.length; index++) {
        const item = state.queue[index];
        try {
          if (item.op === 'upload') {
            const dir = item.path.slice(0, item.path.lastIndexOf('/'));
            if (!(await local.exists(item.path))) continue;   // removed again before it went up
            if (!made.has(dir)) {
              await dav.makeFolders(remotePath(dir));
              made.add(dir);
            }
            await dav.upload(remotePath(item.path), local.fileRef(item.path), local.typeOf(item.path));
          } else if (item.op === 'delete') {
            await dav.remove(remotePath(item.path));
          }
        } catch (error) {
          /* Offline, or the server said no: keep this and everything after it for next time,
             in order, so a delete never overtakes the upload it was meant to undo. */
          remaining.push(...state.queue.slice(index));
          state.queue = remaining;
          throw error;
        }
      }
      state.queue = remaining;
    }

    /* Photos are fetched when a day is opened rather than all at once — a diary with years
       of full-resolution photos in it would otherwise fill the phone the first time it
       synced. Anything already here is left alone. */
    async function ensurePhotos(paths) {
      await load();
      const fetched = [];
      for (const path of paths) {
        if (await local.exists(path)) continue;
        if (state.queue.some(item => item.path === path)) continue;
        try {
          await local.makeDir(path.slice(0, path.lastIndexOf('/')));
          const result = await dav.download(remotePath(path), local.fileRef(path));
          if (result.ok) fetched.push(path);
        } catch {
          // Offline: the caption shows where the photo will be, and it comes next time.
        }
      }
      return fetched;
    }

    /* ---------------------------------------------------------------- the pass */

    let running = null;
    let again = false;

    /* One pass at a time; asking while one is running schedules exactly one more, so a
       save made mid-pass is never left waiting for the next timer. */
    function sync() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        let result;
        do {
          again = false;
          result = await pass();
        } while (again && result.ok);
        return result;
      })().finally(() => { running = null; });
      return running;
    }

    async function pass() {
      await load();
      const changed = new Set();
      const conflicts = [];
      try {
        const listing = await dav.list(root);
        if (listing === null) return { ok: false, missing: true, error: 'The diary folder is not on your Nextcloud any more', changed: [] };

        const remote = new Map();
        for (const row of listing) {
          if (!row.isDir && ENTRY_RE.test(row.name)) remote.set(row.name, row);
        }
        const here = new Map();
        for (const row of await local.list()) {
          if (ENTRY_RE.test(row.name)) here.set(row.name, row);
        }

        const names = new Set([...remote.keys(), ...here.keys(), ...Object.keys(state.files)]);
        for (const name of [...names].sort()) {
          const outcome = await reconcile(name, remote.get(name) || null, here.get(name) || null);
          if (outcome === 'changed') changed.add(name);
          if (outcome === 'conflict') { changed.add(name); conflicts.push(name); }
        }

        await runQueue();
        await save();
        return { ok: true, changed: [...changed].map(name => name.slice(0, 10)), conflicts: conflicts.map(name => name.slice(0, 10)) };
      } catch (error) {
        await save().catch(() => {});
        return {
          ok: false,
          offline: !error || !error.status,
          status: (error && error.status) || 0,
          error: (error && error.message) || 'Could not sync with Nextcloud',
          changed: [...changed].map(name => name.slice(0, 10))
        };
      }
    }

    /* Did the page write this day since we last agreed with the server? The folder's own
       size and mtime answer that for almost every day without reading it. */
    async function localText(name, row, base) {
      if (!row) return { exists: false, text: '', dirty: false };
      if (base && !base.deleted && base.size === row.size && base.mtimeMs === row.mtimeMs) {
        return { exists: true, text: null, dirty: false };
      }
      const text = await local.readText(name);
      if (text === null) return { exists: false, text: '', dirty: false };
      return { exists: true, text, dirty: !base || base.deleted || hash(text) !== base.hash };
    }

    async function agree(name, etag, text) {
      const stat = await local.stat(name);
      state.files[name] = { etag: etag || '', hash: hash(text), size: stat ? stat.size : -1, mtimeMs: stat ? stat.mtimeMs : -1 };
    }

    /* Writes what came from the server into the phone's folder, unless the page wrote to
       that day in the moments since we looked — in which case nothing is lost and the
       next pass sees a day changed in both places. */
    async function takeRemote(name, text, etag, expectedHash) {
      return withLock(name, async () => {
        const now = await local.readText(name);
        if ((now === null ? null : hash(now)) !== expectedHash) return false;
        if (now !== text) await local.writeText(name, text);
        await agree(name, etag, text);
        return now !== text;
      });
    }

    async function upload(name, text, expect) {
      const put = await dav.putText(remotePath(name), text, expect || null);
      if (!put.ok) return false;
      await agree(name, put.etag, text);
      return true;
    }

    async function reconcile(name, remote, row) {
      const base = state.files[name] || null;
      const held = state.conflicts[name];

      if (held) {
        /* Waiting on the person. If the server's copy moved on again, show them the newest. */
        if (remote && remote.etag !== held.etag) {
          const fresh = await dav.getText(remotePath(name));
          if (fresh) state.conflicts[name] = { text: fresh.text, etag: fresh.etag || remote.etag };
          return 'conflict';
        }
        return 'held';
      }

      const mine = await localText(name, row, base);

      /* The server has what we last agreed on. */
      if (remote && base && remote.etag === base.etag) {
        if (base.deleted) {
          const gone = await dav.remove(remotePath(name), base.etag);
          if (gone.ok) delete state.files[name];
          return 'same';
        }
        if (!mine.exists) {
          /* Gone from the phone without being deleted here — a cleared cache. Fetch it. */
          const fresh = await dav.getText(remotePath(name));
          if (!fresh) return 'same';
          return (await takeRemote(name, fresh.text, fresh.etag || remote.etag, null)) ? 'changed' : 'same';
        }
        /* A refused upload means it changed on the server after all; the next pass sees
           that properly. */
        if (mine.dirty) await upload(name, mine.text, base.etag);
        return 'same';
      }

      /* The server has something we have not seen. */
      if (remote) {
        const fresh = await dav.getText(remotePath(name));
        if (!fresh) return 'same';
        const etag = fresh.etag || remote.etag;

        if (!mine.exists || (base && base.deleted)) {
          if (base && base.deleted) delete state.files[name];
          return (await takeRemote(name, fresh.text, etag, null)) ? 'changed' : 'same';
        }
        if (!mine.dirty) {
          const text = mine.text === null ? await local.readText(name) : mine.text;
          return (await takeRemote(name, fresh.text, etag, text === null ? null : hash(text))) ? 'changed' : 'same';
        }
        if (fresh.text === mine.text) {
          await agree(name, etag, mine.text);
          return 'same';
        }
        state.conflicts[name] = { text: fresh.text, etag };
        return 'conflict';
      }

      /* Not on the server. */
      if (base) {
        if (base.deleted || !mine.exists) {
          delete state.files[name];
          return 'same';
        }
        if (mine.dirty) {
          /* Deleted there, written here: the writing wins. */
          await upload(name, mine.text, null);
          return 'same';
        }
        /* Deleted elsewhere and untouched here. */
        const removed = await withLock(name, async () => {
          const now = await local.readText(name);
          if (now !== null && hash(now) !== base.hash) return false;
          await local.remove(name);
          return true;
        });
        if (removed) {
          delete state.files[name];
          await local.removeDir(name.replace(/\.md$/, '-assets'));
          return 'changed';
        }
        return 'same';
      }

      /* New on the phone. */
      if (mine.exists) await upload(name, mine.text, null);
      return 'same';
    }

    async function pendingCount() {
      await load();
      return state.queue.length + Object.values(state.files).filter(base => base.deleted).length;
    }

    return {
      sync, writeEntry, deleteEntry, queuePhoto, ensurePhotos, conflictFor, resolve, pendingCount,
      /* for the tests */
      _state: async () => JSON.parse(JSON.stringify(await load()))
    };
  }

  return { create, hash, ENTRY_RE, ASSET_DIR_RE };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = diarySync;
if (typeof window !== 'undefined') window.diarySync = diarySync;
