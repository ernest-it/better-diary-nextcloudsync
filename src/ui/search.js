/* Search across every entry. Opened with Ctrl/Cmd K. The store owns the matching and the
   snippet; this only has to render it and handle the keyboard. */
const diarySearch = (() => {
  let overlay = null;
  let input = null;
  let list = null;
  let onOpen = null;
  let onShowAll = null;
  let rows = [];
  let cursor = 0;
  let query = '';

  /* With nothing typed, the palette is a way back to what you last wrote rather than an
     empty box — the most common reason to open it is "where was that entry". */
  function collect(value) {
    if (!value) {
      return diaryStore.listing().slice(0, 10).map(row => ({
        id: row.id,
        title: diaryEntry.formatTitle(row.id, diarySettings.get().titleStyle),
        snippet: row.text.replace(/\n+/g, ' ').slice(0, 150),
        tags: row.tags,
        terms: []
      }));
    }
    try {
      return diaryStore.search(value) || [];
    } catch {
      return [];
    }
  }

  function render() {
    list.textContent = '';
    rows = collect(query);
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = query
        ? `Nothing in your diary matches “${query}”`
        : 'Nothing written yet — press Escape and start today.';
      list.append(empty);
      input.removeAttribute('aria-activedescendant');
      return;
    }
    cursor = Math.min(cursor, rows.length - 1);
    rows.forEach((row, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-row';
      button.id = `search-row-${index}`;
      button.setAttribute('role', 'option');
      button.dataset.index = String(index);

      const date = document.createElement('div');
      date.className = 'row-date';
      date.textContent = row.title;

      const snippet = document.createElement('div');
      snippet.className = 'row-snippet';
      snippet.append(diaryStore.highlight(row.snippet, row.terms));

      button.append(date, snippet);

      /* Shown because a hit can come from a tag alone, and then the snippet on its own
         looks like the search matched nothing in particular. */
      if (row.tags && row.tags.length) {
        const holder = document.createElement('div');
        holder.className = 'row-tags';
        for (const tag of row.tags) {
          const chip = document.createElement('span');
          chip.className = 'row-tag';
          chip.append(diaryStore.highlight(tag, row.terms));
          holder.append(chip);
        }
        button.append(holder);
      }
      list.append(button);
    });
    select(cursor);
  }

  function select(index) {
    const items = [...list.querySelectorAll('.search-row')];
    if (!items.length) return;
    cursor = (index + items.length) % items.length;
    items.forEach((item, at) => {
      const on = at === cursor;
      item.classList.toggle('on', on);
      item.setAttribute('aria-selected', String(on));
      if (on) {
        item.scrollIntoView({ block: 'nearest' });
        input.setAttribute('aria-activedescendant', item.id);
      }
    });
  }

  /* Reading every match, rather than jumping to one of them. */
  function showAll() {
    const value = query.trim();
    if (!value) return;
    close();
    if (onShowAll) onShowAll(value);
  }

  function choose(index) {
    const row = rows[index];
    if (!row) return;
    close();
    if (onOpen) onOpen(row.id);
  }

  function paintShowAll() {
    const all = document.getElementById('searchShowAll');
    if (all) all.hidden = !query.trim();
  }

  function open(initial = '') {
    if (!overlay || diaryDialog.isOpen(overlay)) return;
    query = String(initial || '').trim();
    cursor = 0;
    input.value = initial || '';
    render();
    paintShowAll();
    diaryDialog.open(overlay, { initialFocus: input });
    input.select();
  }

  const close = () => { if (overlay) diaryDialog.close(overlay); };
  const isOpen = () => Boolean(overlay) && diaryDialog.isOpen(overlay);

  function init(options = {}) {
    overlay = document.getElementById('searchOverlay');
    input = document.getElementById('searchInput');
    list = document.getElementById('searchResults');
    if (!overlay || !input || !list) return;
    onOpen = options.onOpen || null;
    onShowAll = options.onShowAll || null;

    const all = document.getElementById('searchShowAll');
    if (all) all.addEventListener('click', showAll);

    input.addEventListener('input', () => { query = input.value.trim(); cursor = 0; render(); });
    input.addEventListener('input', paintShowAll);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); select(cursor + 1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); select(cursor - 1); }
      else if (event.key === 'Home' && rows.length) { event.preventDefault(); select(0); }
      else if (event.key === 'End' && rows.length) { event.preventDefault(); select(rows.length - 1); }
      else if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        showAll();
      } else if (event.key === 'Enter') { event.preventDefault(); choose(cursor); }
    });
    list.addEventListener('click', (event) => {
      const row = event.target.closest('.search-row');
      if (row) choose(Number(row.dataset.index));
    });
    list.addEventListener('mousemove', (event) => {
      const row = event.target.closest('.search-row');
      if (row && Number(row.dataset.index) !== cursor) select(Number(row.dataset.index));
    });
  }

  return { init, open, close, isOpen };
})();

window.diarySearch = diarySearch;
