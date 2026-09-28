/* An in-memory mirror of the diary folder, kept in the renderer.

   The folder is the truth; this is a cache over it so the calendar, "on this day", and
   search do not hit the disk on every keystroke. Every refresh compares mtime and size
   against what it already holds and re-reads only the days that actually changed, which is
   what keeps a folder you have been writing in for years cheap to open. */
const diaryStore = (() => {
  const entries = new Map();   // id -> { id, mtimeMs, size, markdown, entry, text }
  let order = [];              // ids, newest first
  let loadedAll = false;

  const api = () => (window.diaryApp && typeof window.diaryApp.list === 'function' ? window.diaryApp : null);
  const model = () => window.diaryEntry;

  const known = (id) => entries.get(id) || null;
  const dates = () => new Set(entries.keys());
  const listing = () => order.map(id => entries.get(id)).filter(Boolean);
  const count = () => order.length;

  function put(id, markdown, mtimeMs, size) {
    const parsed = model().parse(markdown, id);
    entries.set(id, {
      id,
      mtimeMs: Number(mtimeMs) || 0,
      size: Number.isFinite(Number(size)) ? Number(size) : markdown.length,
      markdown,
      entry: parsed,
      tags: parsed.tags || [],
      /* The preview lists read this; search reads `haystack`, which has the tags folded in. */
      text: model().plainText(parsed),
      haystack: model().searchText(parsed).toLowerCase()
    });
  }

  /* Called after the app itself writes, so the cache does not have to wait for the next
     refresh to agree with the disk. */
  function record(id, markdown, mtimeMs) {
    if (!model().isId(id)) return;
    const text = String(markdown == null ? '' : markdown);
    /* An entry whose sections are all empty was never written to disk (see diary.js write()),
       so the cache must not start claiming that day has an entry either. */
    if (!text.trim() || model().isBlank(model().parse(text, id))) {
      entries.delete(id);
      order = order.filter(other => other !== id);
      return;
    }
    const existed = entries.has(id);
    put(id, text, mtimeMs, text.length);
    if (!existed) {
      order.push(id);
      order.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    }
  }

  function forget(id) {
    entries.delete(id);
    order = order.filter(other => other !== id);
  }

  /* Returns the ids whose contents changed, so the caller can tell "somebody else's entry
     arrived" from "the folder listing merely got re-read". */
  async function refresh() {
    const bridge = api();
    if (!bridge) return { ok: false, error: 'Not running in the app', changed: [] };
    const result = await bridge.list();
    if (!result || !result.ok) return { ok: false, error: (result && result.error) || 'The diary folder could not be read', changed: [] };

    const items = Array.isArray(result.items) ? result.items : [];
    const seen = new Set();
    const stale = [];
    for (const item of items) {
      if (!model().isId(item && item.id)) continue;
      seen.add(item.id);
      const cached = entries.get(item.id);
      if (!cached || cached.mtimeMs !== item.mtimeMs || cached.size !== item.size) stale.push(item);
    }

    const changed = [];
    for (const id of [...entries.keys()]) {
      if (!seen.has(id)) {
        entries.delete(id);
        changed.push(id);
      }
    }

    if (stale.length) {
      const read = await bridge.readMany(stale.map(item => item.id));
      const bySize = new Map(stale.map(item => [item.id, item.size]));
      for (const row of (read && read.ok && Array.isArray(read.entries)) ? read.entries : []) {
        if (!row || !row.exists || !model().isId(row.id)) continue;
        put(row.id, String(row.markdown || ''), row.mtimeMs, bySize.get(row.id));
        changed.push(row.id);
      }
    }

    order = [...entries.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    loadedAll = true;
    return { ok: true, changed };
  }

  const ready = () => loadedAll;

  /* ---------- navigation ---------- */

  /* The nearest day you actually wrote on, in the given direction. Stepping one calendar day
     at a time is what the arrow keys do; this is for skipping the gaps. */
  function neighbour(id, direction) {
    if (!model().isId(id)) return '';
    const back = Number(direction) < 0;
    let best = '';
    for (const other of entries.keys()) {
      if (back ? other >= id : other <= id) continue;
      if (!best || (back ? other > best : other < best)) best = other;
    }
    return best;
  }

  const latest = () => (order.length ? order[0] : '');

  /* Same day of the year, any earlier year. Sorted newest first, so "a year ago" comes
     before "three years ago". */
  function onThisDay(id) {
    if (!model().isId(id)) return [];
    const suffix = id.slice(4);           // '-09-18'
    const year = id.slice(0, 4);
    return order.filter(other => other.slice(4) === suffix && other.slice(0, 4) !== year);
  }

  /* ---------- tags ---------- */

  /* Every tag in the diary with how often it is used, most-used first and alphabetical
     within a count — so the list is stable as you scroll it rather than reshuffling on
     every tie. Case is folded for counting, but the spelling you used most often wins,
     so "Jonah Pike" does not become "jonah pike" because of one hurried entry. */
  function allTags() {
    const seen = new Map();   // lowercase -> { count, spellings: Map<spelling, count> }
    for (const row of entries.values()) {
      for (const tag of row.tags) {
        const key = tag.toLowerCase();
        const record = seen.get(key) || { count: 0, spellings: new Map() };
        record.count += 1;
        record.spellings.set(tag, (record.spellings.get(tag) || 0) + 1);
        seen.set(key, record);
      }
    }
    const out = [];
    for (const record of seen.values()) {
      let best = '';
      let bestCount = -1;
      for (const [spelling, count] of record.spellings) {
        if (count > bestCount) { best = spelling; bestCount = count; }
      }
      out.push({ tag: best, count: record.count });
    }
    out.sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' }));
    return out;
  }

  const tagsOf = (id) => {
    const row = entries.get(id);
    return row ? row.tags.slice() : [];
  };

  /* The entries carrying a tag, newest first. Matched case-insensitively, so a tag typed
     in a hurry still lands with the rest of them. */
  function byTag(tag) {
    const key = String(tag || '').trim().toLowerCase();
    if (!key) return [];
    return order.filter(id => {
      const row = entries.get(id);
      return row && row.tags.some(existing => existing.toLowerCase() === key);
    });
  }

  /* ---------- search ---------- */

  const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* Every term has to appear somewhere in the entry, in any order — typing two words should
     narrow the results rather than find nothing. The snippet is built around the first term
     that matched, with a little room either side. */
  function search(query, limit = 40) {
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return [];

    const results = [];
    for (const id of order) {
      const row = entries.get(id);
      if (!row) continue;
      /* Matching includes the tags; the snippet is still built from the prose, because a
         snippet made of tag names tells you nothing about the day. */
      if (!terms.every(term => row.haystack.includes(term))) continue;
      const haystack = row.text.toLowerCase();

      let at = -1;
      let hit = terms[0];
      for (const term of terms) {
        const index = haystack.indexOf(term);
        if (index !== -1 && (at === -1 || index < at)) { at = index; hit = term; }
      }
      if (at === -1) at = 0;

      const from = Math.max(0, at - 42);
      const to = Math.min(row.text.length, at + hit.length + 118);
      results.push({
        id,
        title: model().formatTitle(id, (window.diarySettings ? window.diarySettings.get().titleStyle : 'long')),
        snippet: `${from > 0 ? '…' : ''}${row.text.slice(from, to).replace(/\n+/g, ' ')}${to < row.text.length ? '…' : ''}`,
        tags: row.tags,
        match: hit,
        terms
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  /* Highlights every term inside a snippet. Returns a DocumentFragment rather than HTML so
     nothing from a diary entry is ever parsed as markup. */
  function highlight(snippet, terms) {
    const fragment = document.createDocumentFragment();
    const list = (Array.isArray(terms) ? terms : []).filter(Boolean);
    if (!list.length) {
      fragment.append(document.createTextNode(String(snippet || '')));
      return fragment;
    }
    const pattern = new RegExp(`(${list.map(escapeRe).join('|')})`, 'ig');
    let index = 0;
    const text = String(snippet || '');
    for (const match of text.matchAll(pattern)) {
      if (match.index > index) fragment.append(document.createTextNode(text.slice(index, match.index)));
      const mark = document.createElement('mark');
      mark.textContent = match[0];
      fragment.append(mark);
      index = match.index + match[0].length;
    }
    if (index < text.length) fragment.append(document.createTextNode(text.slice(index)));
    return fragment;
  }

  /* Every entry matching a query, newest first, with how many times the terms appear.
     Unlike search() this is for reading rather than jumping, so it does not stop at a
     handful and it counts every hit instead of finding the first one. */
  function searchAll(query) {
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return { terms: [], hits: [] };

    const hits = [];
    for (const id of order) {
      const row = entries.get(id);
      if (!row) continue;
      /* Matched against everything, tags included, so a day tagged with the word turns up
         even when the word is nowhere in the prose. The caller counts and highlights
         against the prose alone, so the number it shows matches what is on screen. */
      if (terms.every(term => row.haystack.includes(term))) hits.push({ id });
    }
    return { terms, hits };
  }

  /* How many times any of the terms appears in a piece of text. */
  function countMatches(text, terms) {
    const haystack = String(text || '').toLowerCase();
    let count = 0;
    for (const term of (Array.isArray(terms) ? terms : [])) {
      const needle = String(term || '').toLowerCase();
      if (!needle) continue;
      let at = haystack.indexOf(needle);
      while (at !== -1) { count++; at = haystack.indexOf(needle, at + needle.length); }
    }
    return count;
  }

  /* The paragraphs of an entry that actually contain one of the terms. Showing a whole
     entry would bury the match in a day you wrote a lot on; showing one snippet hides the
     other times you mentioned it. Every paragraph that matches, and nothing that does not. */
  function passages(text, terms) {
    const list = (Array.isArray(terms) ? terms : []).filter(Boolean).map(term => term.toLowerCase());
    const paragraphs = String(text || '').split(/\n+/).map(part => part.trim()).filter(Boolean);
    if (!list.length) return paragraphs;
    return paragraphs.filter(part => {
      const lower = part.toLowerCase();
      return list.some(term => lower.includes(term));
    });
  }

  /* ---------- streak ---------- */

  /* How many days in a row up to and including `id` have an entry. Shown quietly under the
     calendar; it is a nudge, never a scold, so a broken streak just reads as "1 day". */
  function streak(id) {
    if (!model().isId(id)) return 0;
    let cursor = entries.has(id) ? id : model().shiftId(id, -1);
    let total = 0;
    while (cursor && entries.has(cursor) && total < 20000) {
      total += 1;
      cursor = model().shiftId(cursor, -1);
    }
    return total;
  }

  return { refresh, ready, known, dates, listing, count, record, forget, neighbour, latest, onThisDay,
           allTags, tagsOf, byTag, search, searchAll, passages, countMatches, highlight, streak };
})();

window.diaryStore = diaryStore;
