/* UI wiring: the day you are reading, the writing areas, the calendar and lists, autosave,
   and what to do when the same day changes underneath you on another device. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const api = window.diaryApp || null;

  const el = {
    boot: $('bootScreen'), bootTitle: $('bootTitle'), bootMessage: $('bootMessage'),
    bootActions: $('bootActions'), bootRetry: $('bootRetry'), bootChoose: $('bootChoose'),
    shell: $('appShell'), sidebar: $('sidebar'), sidebarToggle: $('sidebarToggle'),
    todayBtn: $('todayBtn'), todayKbd: $('todayKbd'),
    calPrev: $('calPrev'), calNext: $('calNext'), calTitle: $('calTitle'), calGrid: $('calGrid'), calFoot: $('calFoot'),
    recentList: $('recentList'), recentCount: $('recentCount'), onThisDayList: $('onThisDayList'),
    settingsBtn: $('settingsBtn'), shortcutsBtn: $('shortcutsBtn'), storagePath: $('storagePath'),
    prevDay: $('prevDay'), nextDay: $('nextDay'), dayLabel: $('dayLabel'),
    savedWrap: $('savedWrap'), savedState: $('savedState'),
    searchBtn: $('searchBtn'), exportBtn: $('exportBtn'), revealBtn: $('revealBtn'),
    toolbar: $('toolbar'), wordCount: $('wordCount'), workspace: $('workspace'),
    notice: $('notice'), noticeText: $('noticeText'), noticeKeep: $('noticeKeep'), noticeLoad: $('noticeLoad'),
    eyebrow: $('entryEyebrow'), entryDate: $('entryDate'), entryMeta: $('entryMeta'), tagRow: $('tagRow'),
    tagList: $('tagList'), tagCount: $('tagCount'),
    page: null, tagView: $('tagView'), tagViewTitle: $('tagViewTitle'),
    tagViewTally: $('tagViewTally'), tagViewList: $('tagViewList'), tagViewClose: $('tagViewClose'),
    sections: $('sections'), addSection: $('addSection'),
    toast: $('toast'), contextMenu: $('contextMenu'),
    settingsDialog: $('settingsDialog'), shortcutsDialog: $('shortcutsDialog'), shortcutTable: $('shortcutTable')
  };

  /* ---------------------------------------------------------------- state */

  let settings = diarySettings.get();
  let currentId = '';
  let preamble = '';        /* anything the file had above its first heading, kept as it was */
  let tags = [];            /* the open entry's tags, the one part of it not held in the DOM */
  let tagFilter = '';       /* when set, the main panel lists every entry carrying this tag */
  let searchQuery = '';     /* when set, the main panel lists every entry matching it */
  let baseline = '';        /* the markdown as of the last render or save — "nothing changed" */
  let diskText = '';        /* the exact bytes we last saw on disk for currentId */
  let dirty = false;
  let saveTimer = null;
  let inFlight = Promise.resolve();
  let lastEditor = null;
  let calCursor = null;     /* { year, month } — the month the calendar is showing */
  let booted = false;

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const isMac = api && api.platform === 'darwin';
  const mod = isMac ? '⌘' : 'Ctrl';

  /* ---------------------------------------------------------------- toast */

  let toastTimer = null;
  function toast(message, isError) {
    el.toast.textContent = String(message || '');
    el.toast.classList.toggle('error', Boolean(isError));
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), isError ? 5200 : 2600);
  }

  /* ---------------------------------------------------------------- dates */

  const todayId = () => diaryEntry.todayId(new Date(), settings.dayStartHour);

  /* "Today" and "Yesterday" are how you think about the last two days; past that, the date
     itself is more use than counting backwards. */
  function relativeLabel(id) {
    const today = todayId();
    if (id === today) return 'Today';
    if (id === diaryEntry.shiftId(today, -1)) return 'Yesterday';
    if (id === diaryEntry.shiftId(today, 1)) return 'Tomorrow';
    return '';
  }

  function shortDate(id) {
    const date = diaryEntry.toDate(id);
    if (!date) return id;
    const day = DOW[(date.getDay() + 6) % 7];
    const thisYear = new Date().getFullYear();
    const year = date.getFullYear() === thisYear ? '' : ` ${date.getFullYear()}`;
    return `${day} ${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)}${year}`;
  }

  /* ---------------------------------------------------------------- sections */

  const PLACEHOLDERS = [
    [/(day went|did today|happened|^today)/i, 'What happened today?'],
    [/(note|remember|todo|to do|reminder)/i, 'Anything worth remembering…'],
    [/(tomorrow|next|coming up|plan)/i, 'What’s coming up…'],
    [/(grateful|gratitude|good thing|highlight|win)/i, 'One good thing…'],
    [/(mood|feel|felt)/i, 'How are you feeling?']
  ];

  function placeholderFor(heading) {
    for (const [pattern, text] of PLACEHOLDERS) if (pattern.test(heading)) return text;
    return 'Write here…';
  }

  /* ---------------------------------------------------------------- photos

     On disk an entry says `![caption](2026-09-20-assets/photo-1.jpg)` — an ordinary relative
     path, so the folder still makes sense without this app. The page cannot load that path,
     so on the way into the editor it becomes a diary-asset: URL that main.js serves, and on
     the way back out it becomes the relative path again. */

  const ASSET_DIR_RE = /^(\d{4}-\d{2}-\d{2})-assets\/([^/]+)$/;

  /* The Android app keeps photos in its own storage and has its own URL for them; it says
     so by providing assetUrl/assetPath on the bridge. */
  const assetUrl = (id, name) => (api && typeof api.assetUrl === 'function'
    ? api.assetUrl(id, name)
    : `diary-asset://entry/${encodeURIComponent(id)}/${encodeURIComponent(name)}`);

  /* file -> editor. Anything that is not one of our relative asset paths is left as it is,
     so an http:// image somebody pasted in still points where they put it. */
  function toDisplaySrc(dest) {
    const match = ASSET_DIR_RE.exec(String(dest || ''));
    return match ? assetUrl(match[1], match[2]) : '';
  }

  /* editor -> file. */
  function toStoredSrc(src) {
    const raw = String(src || '');
    if (api && typeof api.assetPath === 'function') {
      const mapped = api.assetPath(raw);
      if (mapped !== null) return mapped;
    }
    if (!raw.startsWith('diary-asset://')) return raw;
    try {
      const url = new URL(raw);
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (url.hostname !== 'entry' || parts.length !== 2) return '';
      return `${parts[0]}-assets/${parts[1]}`;
    } catch {
      return '';
    }
  }

  /* The day and file a rendered <img> came from, or null if it is not one of ours. */
  function assetOf(image) {
    const match = ASSET_DIR_RE.exec(toStoredSrc(image.getAttribute('src') || ''));
    return match ? { id: match[1], name: match[2] } : null;
  }

  const isEmptyEditor = (editor) => !editor.textContent.trim() && !editor.querySelector('img, hr');

  function paintEmpty(editor) {
    editor.dataset.empty = isEmptyEditor(editor) ? 'true' : 'false';
  }

  function makeEditor(bodyMarkdown, placeholder, label) {
    const editor = document.createElement('div');
    editor.className = 'editor';
    editor.contentEditable = 'true';
    editor.spellcheck = Boolean(settings.spellcheck);
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    editor.setAttribute('aria-label', label);
    editor.dataset.placeholder = placeholder;
    editor.innerHTML = diaryMarkdown.toEditor(bodyMarkdown || '', { onImage: toDisplaySrc });
    paintEmpty(editor);
    editor.addEventListener('input', () => { paintEmpty(editor); markDirty(); });
    editor.addEventListener('focus', () => { lastEditor = editor; paintToolbar(); });
    editor.addEventListener('keyup', paintToolbar);
    editor.addEventListener('mouseup', paintToolbar);
    /* Paste as plain text. A diary is prose, and pasting a wall of somebody else's fonts and
       colours into it is never what was meant — the sanitiser would strip most of it anyway,
       so doing it up front is both calmer and more predictable. */
    editor.addEventListener('paste', (event) => {
      const data = event.clipboardData;
      /* A screenshot or a copied photo comes through as a file on the clipboard. */
      const image = data && [...(data.files || [])].find(file => String(file.type || '').startsWith('image/'));
      if (image) {
        event.preventDefault();
        lastEditor = editor;
        addPhotoBlob(image);
        return;
      }
      event.preventDefault();
      const text = (data && data.getData('text/plain')) || '';
      if (text) document.execCommand('insertText', false, text);
    });

    /* Dropping photos straight onto the day you are writing. */
    editor.addEventListener('dragover', (event) => {
      if (![...(event.dataTransfer.types || [])].includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      editor.classList.add('drop-target');
    });
    editor.addEventListener('dragleave', () => editor.classList.remove('drop-target'));
    editor.addEventListener('drop', async (event) => {
      const files = [...(event.dataTransfer.files || [])].filter(file => String(file.type || '').startsWith('image/'));
      if (!files.length) return;
      event.preventDefault();
      editor.classList.remove('drop-target');
      lastEditor = editor;
      for (const file of files.slice(0, 40)) await addPhotoBlob(file);
    });

    /* Click a photo to select it; then Delete removes it, or double-click opens it full
       size in whatever the desktop uses for pictures. */
    editor.addEventListener('click', (event) => {
      const image = event.target.closest('img');
      for (const other of el.sections.querySelectorAll('img.selected')) {
        if (other !== image) other.classList.remove('selected');
      }
      if (image) image.classList.toggle('selected', true);
    });
    editor.addEventListener('dblclick', (event) => {
      const image = event.target.closest('img');
      const asset = image && assetOf(image);
      if (asset && api) api.photos.open(asset.id, asset.name);
    });
    editor.addEventListener('keydown', (event) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const image = editor.querySelector('img.selected');
      if (!image) return;
      event.preventDefault();
      removePhoto(image);
    });
    return editor;
  }

  /* Where a photo should land: the editor the caret is in, or the first one if the caret is
     somewhere else entirely. */
  function targetEditor() {
    if (lastEditor && document.contains(lastEditor)) return lastEditor;
    return el.sections.querySelector('.editor');
  }

  function insertPhoto(relative, caption) {
    const editor = targetEditor();
    if (!editor) return;
    const match = ASSET_DIR_RE.exec(relative);
    if (!match) return;
    editor.focus();
    const alt = String(caption || '').replace(/[[\]]/g, '');
    const html = `<figure-less><img src="${assetUrl(match[1], match[2])}" alt="${alt.replace(/"/g, '&quot;')}" class="pasted-image"></figure-less>`;
    /* insertHTML rather than building nodes by hand, so it lands at the caret and undo
       still knows about it. The wrapper is stripped straight back out — it exists only to
       stop execCommand dropping a bare <img> into an inline context. */
    document.execCommand('insertHTML', false, html.replace(/figure-less/g, 'p'));
    paintEmpty(editor);
    markDirty();
    saveNow();
  }

  async function addPhotos() {
    if (!currentId || !api) return;
    const result = await api.photos.add(currentId);
    if (!result.ok) {
      if (result.error && result.error !== 'Cancelled') toast(result.error, true);
      return;
    }
    for (const photo of result.added) insertPhoto(photo.relative, '');
    if (result.failed && result.failed.length) {
      toast(result.failed.length === 1 ? result.failed[0] : `${result.failed.length} files could not be added`, true);
    } else {
      toast(result.added.length === 1 ? 'Photo added' : `${result.added.length} photos added`);
    }
  }

  /* Bytes off the clipboard or a drop. */
  async function addPhotoBlob(file) {
    if (!currentId || !api || !file) return false;
    const type = String(file.type || '').toLowerCase();
    const extension = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
      'image/webp': '.webp', 'image/bmp': '.bmp', 'image/avif': '.avif'
    }[type];
    if (!extension) {
      toast(/heic|heif/.test(type) || /\.heic$/i.test(file.name || '')
        ? 'HEIC photos cannot be shown — convert it to JPEG first'
        : 'That is not an image this app can show', true);
      return false;
    }
    const bytes = await file.arrayBuffer();
    const result = await api.photos.write(currentId, extension, bytes);
    if (!result.ok) { toast(result.error || 'That photo could not be saved', true); return false; }
    insertPhoto(result.relative, '');
    return true;
  }

  async function removePhoto(image) {
    const asset = assetOf(image);
    const block = image.closest('p, div, figure');
    image.remove();
    if (block && !block.textContent.trim() && !block.querySelector('img')) block.remove();
    markDirty();
    await saveNow();
    if (asset && api) {
      const result = await api.photos.remove(asset.id, asset.name);
      toast(result.trashed ? 'Photo moved to trash' : 'Photo removed');
    }
  }

  function buildSection(heading, bodyMarkdown) {
    const section = document.createElement('section');
    section.className = 'section';

    const head = document.createElement('div');
    head.className = 'section-head';

    const title = document.createElement('input');
    title.type = 'text';
    title.className = 'section-title';
    title.value = heading;
    title.setAttribute('aria-label', 'Section heading');
    title.addEventListener('input', () => {
      const editor = section.querySelector('.editor');
      if (editor) editor.dataset.placeholder = placeholderFor(title.value);
      markDirty();
    });
    title.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); const editor = section.querySelector('.editor'); if (editor) editor.focus(); }
    });

    const tools = document.createElement('div');
    tools.className = 'section-tools';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn';
    remove.title = 'Remove this section from today';
    remove.setAttribute('aria-label', `Remove the ${heading} section`);
    remove.textContent = '×';
    remove.addEventListener('click', () => removeSection(section));
    tools.append(remove);

    head.append(title, tools);
    section.append(head, makeEditor(bodyMarkdown, placeholderFor(heading), heading || 'Section'));
    return section;
  }

  async function removeSection(section) {
    const title = section.querySelector('.section-title');
    const editor = section.querySelector('.editor');
    const heading = (title && title.value.trim()) || 'this section';
    if (editor && !isEmptyEditor(editor)) {
      const sure = await diaryDialog.confirm({
        title: `Remove “${heading}”?`,
        body: ['What you wrote in it will be removed from this entry too.'],
        confirmLabel: 'Remove',
        danger: true
      });
      if (!sure) return;
    }
    section.remove();
    markDirty();
    saveNow();
  }

  async function addSection() {
    const heading = await diaryDialog.prompt({
      title: 'Add a section',
      body: ['It is added to this entry only. To have it in every new entry, add it in Settings.'],
      label: 'Heading',
      confirmLabel: 'Add'
    });
    if (!heading) return;
    const existing = [...el.sections.querySelectorAll('.section-title')].map(node => node.value.trim().toLowerCase());
    if (existing.includes(heading.trim().toLowerCase())) {
      toast('This entry already has a section with that name', true);
      return;
    }
    const section = buildSection(heading.trim(), '');
    el.sections.append(section);
    markDirty();
    section.querySelector('.editor').focus();
  }

  /* ---------------------------------------------------------------- the current entry */

  function readSections() {
    const sections = [];
    for (const node of el.sections.querySelectorAll('.section:not(.lead)')) {
      const title = node.querySelector('.section-title');
      const editor = node.querySelector('.editor');
      if (!editor) continue;
      const heading = title ? title.value.trim() : '';
      if (!heading) continue;
      sections.push({ heading, body: diaryMarkdown.fromEditor(editor, { onImage: toStoredSrc }).trim() });
    }
    return sections;
  }

  /* The preamble — anything the file had above its first `##`, which only a file written by
     hand elsewhere normally has — lives in a headingless editor at the top. It is read from
     that editor rather than from the parse, so clearing it actually clears it. */
  function currentEntry() {
    const lead = el.sections.querySelector('.section.lead .editor');
    return {
      id: currentId,
      title: '',
      tags,
      preamble: lead ? diaryMarkdown.fromEditor(lead, { onImage: toStoredSrc }).trim() : '',
      sections: readSections()
    };
  }

  const currentMarkdown = () => diaryEntry.stringify(currentEntry(), { titleStyle: settings.titleStyle });

  /* ---------------------------------------------------------------- rendering a day */

  function renderEntry(entry) {
    preamble = String(entry.preamble || '');
    tags = diaryEntry.tagList(entry.tags);
    el.sections.textContent = '';

    if (preamble) {
      const lead = document.createElement('section');
      lead.className = 'section lead';
      lead.append(makeEditor(preamble, 'Write here…', 'Opening note'));
      el.sections.append(lead);
    }
    for (const section of entry.sections) el.sections.append(buildSection(section.heading, section.body));

    el.entryDate.textContent = diaryEntry.formatTitle(currentId, settings.titleStyle);
    const relative = relativeLabel(currentId);
    el.eyebrow.textContent = relative || shortDate(currentId);
    el.dayLabel.textContent = relative || shortDate(currentId);

    paintTagRow();
    paintMeta();
    paintWordCount();
  }

  /* ---------------------------------------------------------------- tags on the entry */

  /* Set while the add-a-tag field is open, so anything that rebuilds the row can take the
     field and its dropdown down with it. Without this, changing day while the field is open
     wipes the row but leaves the suggestion panel floating over the page, attached to an
     input that no longer exists. */
  let dismissTagInput = null;

  function paintTagRow() {
    if (dismissTagInput) {
      const dismiss = dismissTagInput;
      dismissTagInput = null;
      dismiss();
    }
    el.tagRow.textContent = '';
    for (const tag of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = tag;

      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'drop';
      drop.textContent = '×';
      drop.title = `Remove the ${tag} tag`;
      drop.setAttribute('aria-label', `Remove the ${tag} tag`);
      drop.addEventListener('click', () => removeTag(tag));

      chip.append(label, drop);
      el.tagRow.append(chip);
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tag-add';
    add.textContent = tags.length ? '+ Tag' : '+ Add a tag';
    add.title = 'Tag this entry with a person, a place, an activity…';
    add.addEventListener('click', () => openTagInput(add));
    el.tagRow.append(add);
  }

  function setTags(next) {
    const cleaned = diaryEntry.tagList(next);
    if (cleaned.join('\u0000') === tags.join('\u0000')) return;
    tags = cleaned;
    paintTagRow();
    markDirty();
    saveNow();
  }

  const removeTag = (tag) => setTags(tags.filter(existing => existing !== tag));

  /* The field replaces the button in place, so the row does not jump while you type, and a
     list of tags already in the diary hangs under it — the point of tags is that the same
     person gets the same one every time. */
  function openTagInput(anchor) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tag-input';
    input.placeholder = 'person, place, activity…';
    input.setAttribute('aria-label', 'New tag');
    input.autocomplete = 'off';
    input.spellcheck = false;

    const suggest = document.createElement('div');
    suggest.className = 'tag-suggest';
    suggest.hidden = true;
    document.body.append(suggest);

    let cursor = -1;
    let options = [];

    const place = () => {
      const box = input.getBoundingClientRect();
      suggest.style.left = `${Math.min(box.left, window.innerWidth - suggest.offsetWidth - 8)}px`;
      suggest.style.top = `${box.bottom + 4}px`;
    };

    const paintSuggest = () => {
      const typed = input.value.trim().toLowerCase();
      const taken = new Set(tags.map(tag => tag.toLowerCase()));
      options = diaryStore.allTags()
        .filter(row => !taken.has(row.tag.toLowerCase()))
        .filter(row => !typed || row.tag.toLowerCase().includes(typed))
        .slice(0, 8);
      suggest.textContent = '';
      if (!options.length) { suggest.hidden = true; return; }
      options.forEach((row, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = index === cursor ? 'on' : '';
        const name = document.createElement('span');
        name.textContent = row.tag;
        const tally = document.createElement('span');
        tally.className = 'tally';
        tally.textContent = String(row.count);
        button.append(name, tally);
        /* mousedown, not click: blur would tear the field down before a click landed. */
        button.addEventListener('mousedown', (event) => { event.preventDefault(); commit(row.tag); });
        suggest.append(button);
      });
      suggest.hidden = false;
      place();
    };

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      dismissTagInput = null;
      suggest.remove();
      if (input.parentNode) input.replaceWith(anchor);
    };

    const commit = (value) => {
      /* The blur that follows a dismissal must not then add whatever was half-typed. */
      if (closed) return;
      const tag = String(value == null ? input.value : value).trim();
      close();
      if (tag) setTags([...tags, tag]);
      else paintTagRow();
    };

    input.addEventListener('input', () => { cursor = -1; paintSuggest(); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); paintTagRow(); return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        commit(cursor >= 0 && options[cursor] ? options[cursor].tag : undefined);
        return;
      }
      /* A comma is how tags are separated in the file, so it reads as "and another one". */
      if (event.key === ',') { event.preventDefault(); commit(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!options.length) return;
        event.preventDefault();
        cursor = event.key === 'ArrowDown'
          ? (cursor + 1) % options.length
          : (cursor <= 0 ? options.length - 1 : cursor - 1);
        paintSuggest();
      }
    });
    input.addEventListener('blur', () => { commit(); });

    dismissTagInput = close;
    anchor.replaceWith(input);
    input.focus();
    paintSuggest();
  }

  function paintMeta() {
    const known = diaryStore.known(currentId);
    const words = diaryEntry.wordCount(currentEntry());
    const bits = [];
    bits.push(words === 1 ? '1 word' : `${words} words`);
    if (known) {
      const when = new Date(known.mtimeMs);
      if (Number.isFinite(when.getTime()) && known.mtimeMs) {
        bits.push(`last saved ${when.toLocaleString([], { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })}`);
      }
    } else {
      bits.push('not written yet');
    }
    el.entryMeta.textContent = '';
    bits.forEach((bit, index) => {
      if (index) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.textContent = '·';
        el.entryMeta.append(dot);
      }
      const span = document.createElement('span');
      span.textContent = bit;
      el.entryMeta.append(span);
    });
  }

  function paintWordCount() {
    const words = diaryEntry.wordCount(currentEntry());
    el.wordCount.textContent = words === 1 ? '1 word' : `${words} words`;
  }

  /* The one way into a different day. Whatever is unsaved in the day you are leaving is
     written first, so switching can never lose a sentence. */
  async function openDay(id, options = {}) {
    if (!diaryEntry.isId(id)) return;
    if (id === currentId && !options.force) return;
    /* Navigating away would either discard what is unsaved or settle the conflict by
       writing it — and the two buttons that settle it properly are right there. */
    if (pendingRemote && dirty && !options.force) {
      toast('Choose which version of this entry to keep first');
      return;
    }
    if (currentId && dirty) await saveNow();

    currentId = id;
    hideNotice();
    closeTagView();

    const result = await api.read(id);
    const record = result && result.ok ? result.entry : { exists: false, markdown: '', mtimeMs: 0 };
    diskText = record.exists ? String(record.markdown || '') : '';

    const parsed = record.exists
      ? diaryEntry.parse(diskText, id)
      : diaryEntry.scaffold(id, settings.headings);
    const entry = diaryEntry.ensureSections(parsed, settings.headings);

    renderEntry(entry);
    baseline = currentMarkdown();
    dirty = false;
    paintSaved('saved');
    await surfaceHeldConflict();

    const date = diaryEntry.toDate(id);
    if (date) calCursor = { year: date.getFullYear(), month: date.getMonth() };
    paintSidebar();
    el.workspace.scrollTop = 0;

    /* On a phone, focusing throws the on-screen keyboard over the day you came to read. */
    if (options.focus !== false && !(api && api.touch)) {
      const first = el.sections.querySelector('.editor');
      if (first) placeCaretAtEnd(first);
    }
  }

  function placeCaretAtEnd(editor) {
    editor.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // Focus alone is enough; the caret lands somewhere sensible on its own.
    }
  }

  /* ---------------------------------------------------------------- saving */

  function paintSaved(state, detail) {
    el.savedWrap.classList.toggle('dirty', state === 'dirty');
    el.savedWrap.classList.toggle('held', state === 'held');
    el.savedWrap.classList.toggle('failed', state === 'failed');
    if (state === 'failed') el.savedState.textContent = detail || 'Not saved';
    else if (state === 'held') el.savedState.textContent = 'Not saved yet';
    else if (state === 'dirty') el.savedState.textContent = 'Saving…';
    else el.savedState.textContent = diaryStore.known(currentId) ? 'Saved' : 'Nothing written yet';
  }

  let countTimer = null;
  function markDirty() {
    dirty = true;
    paintSaved(pendingRemote ? 'held' : 'dirty');
    /* Counting words means rebuilding the Markdown for every section, so it trails the
       typing rather than running on each keystroke. */
    clearTimeout(countTimer);
    countTimer = setTimeout(paintWordCount, 250);
    clearTimeout(saveTimer);
    if (pendingRemote) return;   // an unresolved conflict holds every write — see saveNow()
    saveTimer = setTimeout(() => { saveNow(); }, settings.autosaveMs);
  }

  function saveNow(options = {}) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!currentId || !api) return Promise.resolve();

    /* Two versions of this day exist and the person has not said which one wins yet.
       Writing now would answer that for them, silently, while the notice is still on screen
       asking. The one exception is the app closing: there, losing what they just typed is
       the worse outcome, and the version that arrived is still on the device that wrote it
       (and in Nextcloud's own file history). */
    if (pendingRemote && !options.force) {
      paintSaved('held');
      return Promise.resolve();
    }

    const id = currentId;
    const markdown = currentMarkdown();
    if (markdown === baseline) {
      if (id === currentId) { dirty = false; paintSaved('saved'); }
      return Promise.resolve();
    }

    const run = inFlight.then(async () => {
      const result = await api.write(id, markdown);
      if (!result || !result.ok) {
        if (id === currentId) paintSaved('failed', 'Not saved');
        toast((result && result.error) || 'That entry could not be saved', true);
        return;
      }
      diaryStore.record(id, markdown, result.mtimeMs);
      if (id === currentId) {
        baseline = markdown;
        diskText = markdown;
        dirty = false;
        paintSaved('saved');
        paintMeta();
      }
      paintSidebar();
    });
    inFlight = run.catch(() => {});
    return run;
  }

  /* ---------------------------------------------------------------- changes from elsewhere */

  function showNotice(text) {
    el.noticeText.textContent = text;
    el.notice.hidden = false;
  }
  const hideNotice = () => { el.notice.hidden = true; };

  let pendingRemote = '';

  /* The Android app is its own sync client, so a day can change on the server while the
     phone still holds an unsent version of it. Its sync keeps both, uploads neither, and
     asks through here: the same notice and the same two answers as a day changing under
     you mid-sentence. Returns true while such a day is open. */
  async function surfaceHeldConflict() {
    if (!api || typeof api.heldConflict !== 'function' || !currentId) return false;
    const id = currentId;
    const theirs = await api.heldConflict(id);
    if (theirs === null || theirs === undefined || id !== currentId) return false;
    if (pendingRemote === theirs) return true;
    pendingRemote = String(theirs);
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = null;
    paintSaved('held');
    showNotice('This entry changed on another device before this phone could upload its own changes to it.');
    return true;
  }

  /* Tells the Android app's sync which version won; the desktop has no such thing. */
  const settleHeld = (choice) => (api && typeof api.resolveConflict === 'function'
    ? api.resolveConflict(currentId, choice)
    : Promise.resolve());

  /* Called whenever the folder changes — the watcher, the poll, or coming back to the
     window. The lists are always refreshed; the open day is only touched if it really is
     different from what we last saw, and never silently if you were mid-sentence. */
  async function folderChanged() {
    await diaryStore.refresh();
    paintSidebar();
    if (!currentId) return;
    if (await surfaceHeldConflict()) return;

    const result = await api.read(currentId);
    if (!result || !result.ok) return;
    const text = result.entry.exists ? String(result.entry.markdown || '') : '';
    if (text === diskText) return;

    if (!dirty) {
      diskText = text;
      const parsed = text ? diaryEntry.parse(text, currentId) : diaryEntry.scaffold(currentId, settings.headings);
      renderEntry(diaryEntry.ensureSections(parsed, settings.headings));
      baseline = currentMarkdown();
      paintSaved('saved');
      hideNotice();
      toast(text ? 'Updated from your other device' : 'This entry was removed elsewhere');
      return;
    }

    pendingRemote = text;
    /* Nothing more is written to this day until the notice is answered, so say so straight
       away rather than leaving "Saving…" on screen for a save that will not happen. */
    clearTimeout(saveTimer);
    saveTimer = null;
    paintSaved('held');
    showNotice('This entry also changed somewhere else. Your version is still here and unsaved.');
  }

  el.noticeKeep.addEventListener('click', async () => {
    hideNotice();
    /* Taking the arrived copy as what we last saw is what makes the next save overwrite it
       rather than keep reporting the same conflict. Clearing pendingRemote also releases
       the hold that saveNow() puts on writes. */
    diskText = pendingRemote;
    pendingRemote = '';
    await settleHeld('mine');
    markDirty();
    await saveNow();
    /* On Android the phone's copy already was this version, so there may have been
       nothing to save; what is on disk is what we last saw, not the version we declined. */
    if (typeof api.heldConflict === 'function' && !dirty) {
      const result = await api.read(currentId);
      if (result && result.ok) diskText = result.entry.exists ? String(result.entry.markdown || '') : '';
    }
  });

  el.noticeLoad.addEventListener('click', async () => {
    const text = pendingRemote;
    pendingRemote = '';
    hideNotice();
    await settleHeld('theirs');
    dirty = false;
    diskText = text;
    const parsed = text ? diaryEntry.parse(text, currentId) : diaryEntry.scaffold(currentId, settings.headings);
    renderEntry(diaryEntry.ensureSections(parsed, settings.headings));
    baseline = currentMarkdown();
    paintSaved('saved');
    toast('Loaded the other version');
  });

  /* ---------------------------------------------------------------- calendar */

  function paintCalendar() {
    if (!calCursor) {
      const date = diaryEntry.toDate(currentId) || new Date();
      calCursor = { year: date.getFullYear(), month: date.getMonth() };
    }
    const { year, month } = calCursor;
    el.calTitle.textContent = `${MONTHS[month]} ${year}`;

    el.calGrid.textContent = '';
    for (const day of DOW) {
      const cell = document.createElement('div');
      cell.className = 'cal-dow';
      cell.setAttribute('aria-hidden', 'true');
      cell.textContent = day.charAt(0);
      el.calGrid.append(cell);
    }

    const first = new Date(year, month, 1);
    /* The week starts on Monday, which is how the dates in these entries are written. */
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - lead);
    const written = diaryStore.dates();
    const today = todayId();

    for (let index = 0; index < 42; index++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
      const id = diaryEntry.idOf(date);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cal-day';
      button.dataset.id = id;
      button.textContent = String(date.getDate());
      if (date.getMonth() !== month) button.classList.add('other');
      if (id > today) button.classList.add('future');
      if (written.has(id)) button.classList.add('has-entry');
      if (id === today) button.classList.add('today');
      if (id === currentId) { button.classList.add('current'); button.setAttribute('aria-current', 'date'); }
      button.title = diaryEntry.formatTitle(id, settings.titleStyle) + (written.has(id) ? '' : ' — nothing written');
      button.setAttribute('aria-label', button.title);
      el.calGrid.append(button);
    }

    const inMonth = [...written].filter(id => id.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`)).length;
    const run = diaryStore.streak(today);
    el.calFoot.textContent = '';
    const left = document.createElement('span');
    left.textContent = `${inMonth} this month`;
    el.calFoot.append(left);
    if (run > 1) {
      const dot = document.createElement('span');
      dot.textContent = '·';
      const right = document.createElement('span');
      right.textContent = `${run} days in a row`;
      el.calFoot.append(dot, right);
    }
  }

  el.calGrid.addEventListener('click', (event) => {
    const button = event.target.closest('.cal-day');
    if (button && button.dataset.id) openDay(button.dataset.id);
  });
  el.calPrev.addEventListener('click', () => { stepMonth(-1); });
  el.calNext.addEventListener('click', () => { stepMonth(1); });
  el.calTitle.addEventListener('click', () => {
    const date = diaryEntry.toDate(currentId);
    if (date) { calCursor = { year: date.getFullYear(), month: date.getMonth() }; paintCalendar(); }
  });

  function stepMonth(delta) {
    const date = new Date(calCursor.year, calCursor.month + delta, 1);
    calCursor = { year: date.getFullYear(), month: date.getMonth() };
    paintCalendar();
  }

  /* ---------------------------------------------------------------- sidebar lists */

  /* What was actually written in an entry, headings left out. plainText() folds the heading
     names in too, which would make every preview read "How the day went … Notes … Tomorrow". */
  function bodyOf(id) {
    const row = diaryStore.known(id);
    if (!row) return '';
    const parts = [String(row.entry.preamble || ''), ...(row.entry.sections || []).map(section => String(section.body || ''))];
    return diaryEntry
      .plainText({ sections: parts.filter(part => part.trim()).map(body => ({ heading: '', body })) });
  }

  /* One line, for the previews in the lists. bodyOf() keeps the paragraph breaks, which the
     search results need in order to show you the separate places a word turns up. */
  const bodyTextOf = (id) => bodyOf(id).replace(/\n+/g, ' ');

  const peekOf = (id) => bodyTextOf(id).slice(0, 90);

  function entryRow(id, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'entry-row';
    button.dataset.id = id;
    if (id === currentId) { button.classList.add('current'); button.setAttribute('aria-current', 'true'); }
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = label;
    const peek = document.createElement('span');
    peek.className = 'peek';
    peek.textContent = peekOf(id);
    button.append(when, peek);

    /* One chip plus a count. An entry normally carries a single tag, and a second chip on
       the same row is what starts crowding the preview out. */
    const rowTags = diaryStore.tagsOf(id);
    if (rowTags.length) {
      const holder = document.createElement('span');
      holder.className = 'row-tags';
      for (const tag of rowTags.slice(0, 1)) {
        const chip = document.createElement('span');
        chip.className = 'row-tag';
        chip.textContent = tag;
        holder.append(chip);
      }
      if (rowTags.length > 1) {
        const more = document.createElement('span');
        more.className = 'row-more';
        more.textContent = `+${rowTags.length - 1}`;
        holder.append(more);
      }
      button.append(holder);
    }

    const title = diaryEntry.formatTitle(id, settings.titleStyle);
    button.title = rowTags.length ? `${title}\n${rowTags.join(', ')}` : title;
    return button;
  }

  function paintLists() {
    const ids = diaryStore.listing().map(row => row.id);
    el.recentCount.textContent = ids.length ? String(ids.length) : '';

    el.recentList.textContent = '';
    if (!ids.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'Nothing yet. Write a line about today and it appears here.';
      el.recentList.append(empty);
    } else {
      for (const id of ids.slice(0, 8)) el.recentList.append(entryRow(id, shortDate(id)));
    }

    const past = diaryStore.onThisDay(currentId);
    el.onThisDayList.textContent = '';
    if (!past.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'Once you have a year of entries, this shows the same day in years gone by.';
      el.onThisDayList.append(empty);
    } else {
      for (const id of past.slice(0, 6)) el.onThisDayList.append(entryRow(id, id.slice(0, 4)));
    }

    paintTagMenu();
  }

  function paintTagMenu() {
    const all = diaryStore.allTags();
    el.tagCount.textContent = all.length ? String(all.length) : '';
    el.tagList.textContent = '';

    if (!all.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'Tag an entry with a person, a place or an activity and it turns up here.';
      el.tagList.append(empty);
      return;
    }

    for (const row of all.slice(0, 14)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tag-row-item';
      button.dataset.tag = row.tag;
      const active = row.tag.toLowerCase() === tagFilter.toLowerCase();
      if (active) { button.classList.add('on'); button.setAttribute('aria-pressed', 'true'); }
      else button.setAttribute('aria-pressed', 'false');

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = row.tag;
      const tally = document.createElement('span');
      tally.className = 'tally';
      tally.textContent = String(row.count);

      button.append(dot, name, tally);
      button.title = active
        ? `Stop showing only ${row.tag}`
        : `Show the ${row.count === 1 ? 'entry' : `${row.count} entries`} tagged ${row.tag}`;
      el.tagList.append(button);
    }
  }

  /* ---------------------------------------------------------------- the results view

     One view in the main panel, reached two ways: clicking a tag, or asking search to show
     everything rather than jumping to one day. Both are "here is a set of entries, read
     them", which the sidebar is far too narrow for. */

  async function openResults(next) {
    /* The editor is about to be hidden, so anything unsaved goes to disk first. */
    if (dirty) await saveNow();
    tagFilter = next.tag || '';
    searchQuery = next.query || '';
    paintResults();
    paintTagMenu();
  }

  /* Clicking the tag you are already reading goes back to the entry, so one control gets
     you both in and out. */
  function toggleTagFilter(tag) {
    const next = String(tag || '');
    if (next.toLowerCase() === tagFilter.toLowerCase()) { closeResults(); return; }
    openResults({ tag: next });
  }

  function paintResults() {
    const searching = Boolean(searchQuery);
    const found = searching ? diaryStore.searchAll(searchQuery) : { terms: [], hits: [] };
    const ids = searching ? found.hits.map(hit => hit.id) : diaryStore.byTag(tagFilter);

    el.tagViewTitle.textContent = searching ? `“${searchQuery}”` : tagFilter;
    el.tagViewTally.textContent = ids.length === 1 ? '1 entry' : `${ids.length} entries`;
    el.tagViewList.textContent = '';

    if (!ids.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = searching
        ? `Nothing in your diary matches “${searchQuery}”.`
        : 'Nothing carries this tag any more.';
      el.tagViewList.append(empty);
    }

    for (const id of ids) {
      const hit = document.createElement('button');
      hit.type = 'button';
      hit.className = 'tag-hit';
      hit.dataset.id = id;

      const head = document.createElement('div');
      head.className = 'hit-head';
      const date = document.createElement('div');
      date.className = 'hit-date';
      date.textContent = diaryEntry.formatTitle(id, settings.titleStyle);
      head.append(date);

      /* Counted from the same text the highlights come from, so the number always equals
         what is marked on screen. A day that matched only on its tag says so instead. */
      const parts = searching ? diaryStore.passages(bodyOf(id), found.terms) : [];
      const marks = searching ? diaryStore.countMatches(parts.join('\n'), found.terms) : 0;
      if (searching && marks) {
        const tally = document.createElement('span');
        tally.className = 'hit-count';
        tally.textContent = marks === 1 ? '1 match' : `${marks} matches`;
        head.append(tally);
      }
      hit.append(head);

      const body = document.createElement('div');
      body.className = 'hit-body';
      if (searching) {
        /* Every paragraph the word appears in, with every appearance marked — not one
           snippet, because the point of reading these together is seeing each time you
           mentioned it. */
        parts.forEach((part, index) => {
          const paragraph = document.createElement('p');
          paragraph.className = 'hit-passage';
          paragraph.append(diaryStore.highlight(part, found.terms));
          body.append(paragraph);
          if (index < parts.length - 1) {
            const gap = document.createElement('div');
            gap.className = 'hit-gap';
            gap.textContent = '⋯';
            body.append(gap);
          }
        });
        /* A hit can come from a tag or a heading alone, with nothing in the prose. */
        if (!parts.length) {
          const paragraph = document.createElement('p');
          paragraph.className = 'hit-passage quiet';
          paragraph.textContent = 'Matched on a tag — nothing in the writing itself.';
          body.append(paragraph);
        }
      } else {
        body.textContent = bodyTextOf(id);
      }
      hit.append(body);

      const rowTags = diaryStore.tagsOf(id);
      if (rowTags.length) {
        const holder = document.createElement('div');
        holder.className = 'hit-tags';
        for (const tag of rowTags) {
          const chip = document.createElement('span');
          const marked = searching
            ? found.terms.some(term => tag.toLowerCase().includes(term))
            : tag.toLowerCase() === tagFilter.toLowerCase();
          chip.className = marked ? 'hit-tag is-this' : 'hit-tag';
          chip.textContent = tag;
          holder.append(chip);
        }
        hit.append(holder);
      }
      el.tagViewList.append(hit);
    }

    showTagView(true);
  }

  /* Swaps the whole middle of the window. The formatting toolbar and the word count belong
     to an entry being written, so they go with it. */
  function showTagView(on) {
    if (!el.page) el.page = document.querySelector('.page');
    el.page.hidden = on;
    el.tagView.hidden = !on;
    el.toolbar.hidden = on;
    el.workspace.scrollTop = 0;
  }

  function closeResults() {
    if (!tagFilter && !searchQuery) return;
    tagFilter = '';
    searchQuery = '';
    showTagView(false);
    paintTagMenu();
  }

  /* Kept under the old name because openDay() and Escape both call it. */
  const closeTagView = closeResults;

  el.tagList.addEventListener('click', (event) => {
    const row = event.target.closest('.tag-row-item');
    if (row && row.dataset.tag) toggleTagFilter(row.dataset.tag);
  });

  el.tagViewClose.addEventListener('click', closeResults);

  el.tagViewList.addEventListener('click', (event) => {
    const hit = event.target.closest('.tag-hit');
    if (hit && hit.dataset.id) openDay(hit.dataset.id);
  });

  for (const list of [el.recentList, el.onThisDayList]) {
    list.addEventListener('click', (event) => {
      const row = event.target.closest('.entry-row');
      if (row && row.dataset.id) openDay(row.dataset.id);
    });
  }

  function paintSidebar() {
    paintCalendar();
    paintLists();
    el.prevDay.disabled = !currentId;
    el.nextDay.disabled = !currentId;
  }

  /* ---------------------------------------------------------------- toolbar */

  const COMMAND_STATE = ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList'];

  function paintToolbar() {
    for (const button of el.toolbar.querySelectorAll('button[data-cmd]')) {
      const cmd = button.dataset.cmd;
      if (!COMMAND_STATE.includes(cmd)) continue;
      let on = false;
      try { on = document.queryCommandState(cmd); } catch { on = false; }
      button.classList.toggle('on', on);
    }
    const inMark = Boolean(selectionMark());
    const highlight = el.toolbar.querySelector('button[data-cmd="hiliteColor"]');
    if (highlight) highlight.classList.toggle('on', inMark);
  }

  /* execCommand('hiliteColor') leaves a styled <span>, and the sanitiser drops inline styles
     on the way to Markdown — so the highlight would vanish on the next save. A real <mark>
     element is what round-trips as `==text==`. */
  function selectionMark() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return null;
    let node = selection.getRangeAt(0).startContainer;
    while (node && node !== document.body) {
      if (node.nodeType === 1 && node.tagName === 'MARK') return node;
      node = node.parentNode;
    }
    return null;
  }

  function toggleHighlight() {
    const existing = selectionMark();
    if (existing) {
      const parent = existing.parentNode;
      while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
      parent.removeChild(existing);
      parent.normalize();
      markDirty();
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = selection.toString();
    if (!text) return;
    document.execCommand('insertHTML', false, `<mark>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</mark>`);
    markDirty();
  }

  /* mousedown rather than click, so pressing a button never takes the caret out of the text
     it is about to act on. */
  el.toolbar.addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) event.preventDefault();
  });

  el.toolbar.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-cmd]');
    if (!button) return;
    const editor = lastEditor && document.contains(lastEditor) ? lastEditor : el.sections.querySelector('.editor');
    if (!editor) return;
    editor.focus();
    const cmd = button.dataset.cmd;
    if (cmd === 'hiliteColor') { toggleHighlight(); paintToolbar(); return; }
    try {
      document.execCommand(cmd, false, button.dataset.value || null);
    } catch {
      // A command the engine will not run is not worth an error message.
    }
    paintEmpty(editor);
    markDirty();
    paintToolbar();
  });

  el.workspace.addEventListener('scroll', () => {
    el.toolbar.classList.toggle('stuck', el.workspace.scrollTop > 4);
  });

  document.addEventListener('selectionchange', () => {
    if (lastEditor && document.activeElement === lastEditor) paintToolbar();
  });

  /* ---------------------------------------------------------------- context menu */

  function closeContextMenu() { el.contextMenu.hidden = true; el.contextMenu.textContent = ''; }

  document.addEventListener('pointerdown', (event) => {
    if (!el.contextMenu.hidden && !el.contextMenu.contains(event.target)) closeContextMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeContextMenu();
    /* Only when no dialog is up — dialog.js owns Escape while one is open. */
    if ((tagFilter || searchQuery) && !diaryDialog.isOpen()) closeResults();
  });

  function openContextMenu(params) {
    closeContextMenu();
    const items = [];
    for (const word of params.suggestions) {
      items.push({ label: word, className: 'suggestion', run: () => api.replaceMisspelling(word) });
    }
    if (params.misspelledWord) {
      items.push({ separator: true });
      items.push({ label: 'Add to dictionary', run: () => api.addToDictionary(params.misspelledWord) });
    }
    if (params.editable) {
      if (items.length) items.push({ separator: true });
      items.push({ label: 'Cut', run: () => document.execCommand('cut') });
      items.push({ label: 'Copy', run: () => document.execCommand('copy') });
      items.push({ label: 'Paste', run: () => document.execCommand('paste') });
    } else {
      items.push({ label: 'Copy', run: () => document.execCommand('copy') });
    }
    if (!items.length) return;

    for (const item of items) {
      if (item.separator) { el.contextMenu.append(document.createElement('hr')); continue; }
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      if (item.className) button.className = item.className;
      button.textContent = item.label;
      button.addEventListener('click', () => { closeContextMenu(); item.run(); markDirty(); });
      el.contextMenu.append(button);
    }

    el.contextMenu.hidden = false;
    const rect = el.contextMenu.getBoundingClientRect();
    el.contextMenu.style.left = `${Math.min(params.x, window.innerWidth - rect.width - 8)}px`;
    el.contextMenu.style.top = `${Math.min(params.y, window.innerHeight - rect.height - 8)}px`;
  }

  /* ---------------------------------------------------------------- settings dialog */

  let headingDraft = [];

  function paintHeadingRows() {
    const host = $('headingRows');
    host.textContent = '';
    headingDraft.forEach((heading, index) => {
      const row = document.createElement('div');
      row.className = 'heading-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = heading;
      input.placeholder = 'Section heading';
      input.setAttribute('aria-label', `Section ${index + 1}`);
      input.addEventListener('input', () => { headingDraft[index] = input.value; commitHeadings(); });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn';
      remove.textContent = '×';
      remove.title = 'Remove this section';
      remove.setAttribute('aria-label', `Remove section ${index + 1}`);
      remove.disabled = headingDraft.length <= 1;
      remove.addEventListener('click', () => {
        headingDraft.splice(index, 1);
        paintHeadingRows();
        commitHeadings();
      });
      row.append(input, remove);
      host.append(row);
    });
  }

  let headingTimer = null;
  function commitHeadings() {
    clearTimeout(headingTimer);
    headingTimer = setTimeout(() => {
      const list = headingDraft.map(heading => heading.trim()).filter(Boolean);
      if (list.length) applySettings({ headings: list });
    }, 350);
  }

  function paintSettingsDialog() {
    for (const button of $('themeSeg').querySelectorAll('button')) {
      button.classList.toggle('on', button.dataset.theme === settings.theme);
    }
    for (const button of $('bodyFontSeg').querySelectorAll('button')) {
      button.classList.toggle('on', button.dataset.bodyFont === settings.bodyFont);
    }
    $('fontScale').value = String(settings.fontScale);
    $('fontScaleValue').textContent = `${Math.round(settings.fontScale * 100)}%`;
    $('autosaveMs').value = String(settings.autosaveMs);
    $('autosaveValue').textContent = `${settings.autosaveMs} ms`;
    $('spellcheckToggle').checked = Boolean(settings.spellcheck);
    $('titleStyle').value = settings.titleStyle;
    $('dayStartHour').value = String(settings.dayStartHour);
    $('titleStylePreview').textContent = `Today reads: ${diaryEntry.formatTitle(todayId(), settings.titleStyle)}`;
    $('settingsPath').textContent = settings.diaryPath || '';
    headingDraft = settings.headings.slice();
    paintHeadingRows();
  }

  function applySettings(patch) {
    diarySettings.set(patch).then((result) => {
      if (!result.ok) toast(result.error, true);
    });
  }

  function onSettingsChanged(next) {
    const before = settings;
    settings = next;
    for (const editor of el.sections.querySelectorAll('.editor')) editor.spellcheck = Boolean(settings.spellcheck);
    if (booted && before.titleStyle !== settings.titleStyle) {
      el.entryDate.textContent = diaryEntry.formatTitle(currentId, settings.titleStyle);
      /* The title is rewritten from the date on every save, so changing this makes the open
         entry differ from disk — which is exactly what should then be written. */
      if (currentMarkdown() !== baseline) markDirty();
    }
    if (booted) {
      paintSidebar();
      if (!diaryDialog.isOpen($('settingsDialog'))) return;
      $('titleStylePreview').textContent = `Today reads: ${diaryEntry.formatTitle(todayId(), settings.titleStyle)}`;
      $('settingsPath').textContent = settings.diaryPath || '';
    }
  }

  function wireSettingsDialog() {
    $('themeSeg').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-theme]');
      if (button) { applySettings({ theme: button.dataset.theme }); paintSettingsDialog(); }
    });
    $('bodyFontSeg').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-body-font]');
      if (button) { applySettings({ bodyFont: button.dataset.bodyFont }); paintSettingsDialog(); }
    });
    $('fontScale').addEventListener('input', (event) => {
      const value = Number(event.target.value);
      $('fontScaleValue').textContent = `${Math.round(value * 100)}%`;
      applySettings({ fontScale: value });
    });
    $('autosaveMs').addEventListener('input', (event) => {
      const value = Number(event.target.value);
      $('autosaveValue').textContent = `${value} ms`;
      applySettings({ autosaveMs: value });
    });
    $('spellcheckToggle').addEventListener('change', (event) => applySettings({ spellcheck: event.target.checked }));
    $('titleStyle').addEventListener('change', (event) => {
      applySettings({ titleStyle: event.target.value });
      $('titleStylePreview').textContent = `Today reads: ${diaryEntry.formatTitle(todayId(), event.target.value)}`;
    });
    $('dayStartHour').addEventListener('change', (event) => applySettings({ dayStartHour: Number(event.target.value) }));
    $('headingAdd').addEventListener('click', () => {
      headingDraft.push('');
      paintHeadingRows();
      const inputs = $('headingRows').querySelectorAll('input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    $('settingsReveal').addEventListener('click', () => api.revealFolder());
    $('settingsChoose').addEventListener('click', chooseFolder);

    for (const dialog of [el.settingsDialog, el.shortcutsDialog]) {
      dialog.addEventListener('click', (event) => {
        if (event.target.closest('[data-close-dialog]')) diaryDialog.close(dialog);
      });
    }
  }

  function openSettings() {
    paintSettingsDialog();
    diaryDialog.open(el.settingsDialog);
  }

  /* ---------------------------------------------------------------- shortcuts dialog */

  const SHORTCUTS = [
    ["Today's entry", `${mod} T`],
    ['Previous / next day', 'Alt ← / Alt →'],
    ['Previous / next entry written', 'Alt ⇧ ← / Alt ⇧ →'],
    ['Jump to a date', `${mod} G`],
    ['Add a photo', `${mod} ⇧ P`],
    ['Add a tag', `${mod} ⇧ A`],
    ['Search your diary', `${mod} K`],
    ['Save now', `${mod} S`],
    ['Export this entry', `${mod} E`],
    ['Delete this entry', `${mod} ⇧ ⌫`],
    ['Bold / italic / underline', `${mod} B / I / U`],
    ['Settings', `${mod} ,`],
    ['Toggle the sidebar', `${mod} \\`],
    ['Toggle dark mode', `${mod} ⇧ D`]
  ];

  function openShortcuts() {
    el.shortcutTable.textContent = '';
    for (const [label, keys] of SHORTCUTS) {
      const row = document.createElement('tr');
      const what = document.createElement('td');
      what.textContent = label;
      const how = document.createElement('td');
      for (const key of keys.split(' ')) {
        if (key === '/') { how.append(document.createTextNode(' / ')); continue; }
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        how.append(kbd, document.createTextNode(' '));
      }
      row.append(what, how);
      el.shortcutTable.append(row);
    }
    diaryDialog.open(el.shortcutsDialog);
  }

  /* ---------------------------------------------------------------- actions */

  async function chooseFolder() {
    const result = await api.chooseFolder();
    if (!result || !result.ok) {
      if (result && result.error && result.error !== 'Cancelled') toast(result.error, true);
      return;
    }
    await paintStorage();
    await diaryStore.refresh();
    await openDay(currentId || todayId(), { force: true, focus: false });
    toast('Diary folder changed');
  }

  async function exportEntry() {
    if (!currentId) return;
    await saveNow();
    const result = await api.exportEntry(currentId, currentMarkdown());
    if (result && result.ok) toast('Exported');
    else if (result && result.error && result.error !== 'Cancelled') toast(result.error, true);
  }

  async function deleteEntry() {
    if (!currentId || !diaryStore.known(currentId)) { toast('There is nothing written on this day'); return; }
    const sure = await diaryDialog.confirm({
      title: `Delete ${diaryEntry.formatTitle(currentId, settings.titleStyle)}?`,
      body: [`It goes to ${(api && api.trashPlace) || 'your system trash'}, so you can still get it back from there.`],
      confirmLabel: 'Delete',
      danger: true
    });
    if (!sure) return;
    const result = await api.remove(currentId);
    if (!result || !result.ok) { toast((result && result.error) || 'That entry could not be deleted', true); return; }
    diaryStore.forget(currentId);
    await openDay(currentId, { force: true, focus: false });
    toast(result.trashed ? 'Moved to trash' : 'Deleted');
  }

  async function jumpToDate() {
    const answer = await diaryDialog.prompt({
      title: 'Jump to a date',
      body: ['Type a date as YYYY-MM-DD.'],
      label: 'Date',
      value: currentId,
      confirmLabel: 'Go'
    });
    if (!answer) return;
    const id = String(answer).trim();
    if (!diaryEntry.isId(id)) { toast('That is not a date the diary understands', true); return; }
    openDay(id);
  }

  function toggleSidebar() {
    const hidden = el.shell.classList.toggle('no-sidebar');
    el.sidebarToggle.setAttribute('aria-expanded', String(!hidden));
    applySettings({ sidebarVisible: !hidden });
  }

  const MENU_ACTIONS = {
    today: () => openDay(todayId()),
    save: () => saveNow().then(() => toast('Saved')),
    export: exportEntry,
    delete: deleteEntry,
    'choose-folder': chooseFolder,
    'reveal-folder': () => api.revealFolder(),
    'add-section': addSection,
    'add-photo': addPhotos,
    'add-tag': () => {
      const add = el.tagRow.querySelector('.tag-add');
      if (add) openTagInput(add);
    },
    search: () => diarySearch.open(''),
    'previous-day': () => openDay(diaryEntry.shiftId(currentId, -1)),
    'next-day': () => openDay(diaryEntry.shiftId(currentId, 1)),
    'previous-entry': () => {
      const id = diaryStore.neighbour(currentId, -1);
      if (id) openDay(id); else toast('Nothing written before this day');
    },
    'next-entry': () => {
      const id = diaryStore.neighbour(currentId, 1);
      if (id) openDay(id); else toast('Nothing written after this day');
    },
    'jump-to-date': jumpToDate,
    'toggle-sidebar': toggleSidebar,
    'toggle-theme': () => {
      const dark = document.documentElement.dataset.theme === 'dark'
        || (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
      applySettings({ theme: dark ? 'light' : 'dark' });
      paintSettingsDialog();
    },
    settings: openSettings,
    shortcuts: openShortcuts,
    about: () => diaryDialog.message({
      title: 'daily-diary',
      body: [
        `Version ${api ? api.version : '0.0.0'}`,
        'One Markdown file per day, in a folder you own.',
        settings.diaryPath || ''
      ].filter(Boolean)
    })
  };

  /* ---------------------------------------------------------------- boot */

  async function paintStorage() {
    const path = await api.diaryPath();
    el.storagePath.textContent = path;
    el.storagePath.title = path;
    $('settingsPath').textContent = path;
  }

  function bootFailed(message) {
    el.boot.hidden = false;
    el.shell.hidden = true;
    el.bootTitle.textContent = 'Your diary folder could not be opened';
    el.bootMessage.textContent = message;
    el.bootActions.hidden = false;
  }

  async function boot() {
    if (!api) {
      bootFailed('This page is not running inside the app.');
      return;
    }
    settings = await diarySettings.ready;

    const result = await diaryStore.refresh();
    if (!result.ok) {
      bootFailed(result.error || 'The folder could not be read.');
      return;
    }

    await paintStorage();
    el.shell.classList.toggle('no-sidebar', !settings.sidebarVisible);
    el.sidebarToggle.setAttribute('aria-expanded', String(Boolean(settings.sidebarVisible)));
    el.todayKbd.textContent = `${mod} T`;

    el.boot.hidden = true;
    el.shell.hidden = false;
    booted = true;

    await openDay(todayId(), { focus: true });
  }

  /* ---------------------------------------------------------------- wiring */

  diarySettings.subscribe(onSettingsChanged);

  el.todayBtn.addEventListener('click', () => openDay(todayId()));
  el.prevDay.addEventListener('click', () => openDay(diaryEntry.shiftId(currentId, -1)));
  el.nextDay.addEventListener('click', () => openDay(diaryEntry.shiftId(currentId, 1)));
  el.sidebarToggle.addEventListener('click', toggleSidebar);
  el.searchBtn.addEventListener('click', () => diarySearch.open(''));
  el.exportBtn.addEventListener('click', exportEntry);
  el.revealBtn.addEventListener('click', () => api && api.revealFolder());
  el.settingsBtn.addEventListener('click', openSettings);
  el.shortcutsBtn.addEventListener('click', openShortcuts);
  el.addSection.addEventListener('click', addSection);
  $('photoBtn').addEventListener('click', addPhotos);
  el.bootRetry.addEventListener('click', () => { el.bootActions.hidden = true; boot(); });
  el.bootChoose.addEventListener('click', async () => { await chooseFolder(); boot(); });

  wireSettingsDialog();
  diarySearch.init({
    onOpen: (id) => openDay(id),
    onShowAll: (query) => openResults({ query })
  });

  if (api) {
    api.onMenu((action) => {
      const run = MENU_ACTIONS[action];
      if (run) run();
    });
    api.onChanged(() => { folderChanged().catch(() => {}); });
    api.onContextMenu(openContextMenu);
    api.onFlushRequest(() => {
      saveNow({ force: true }).finally(() => api.flushed());
    });
  }

  /* Leaving the window is as good a moment to write as any — it is usually what somebody
     does right before closing the lid. */
  window.addEventListener('blur', () => { if (dirty) saveNow(); });
  /* A last-ditch attempt if the window is torn down without the flush handshake. */
  window.addEventListener('beforeunload', () => { if (dirty) saveNow(); });

  /* The diary day can roll over while the window is simply left open overnight. */
  setInterval(() => {
    if (!booted || diaryDialog.isOpen()) return;
    const relative = relativeLabel(currentId);
    if (el.dayLabel.textContent !== (relative || shortDate(currentId))) {
      el.dayLabel.textContent = relative || shortDate(currentId);
      el.eyebrow.textContent = relative || shortDate(currentId);
      paintCalendar();
    }
  }, 60000);

  boot().catch((error) => bootFailed((error && error.message) || String(error)));
})();
