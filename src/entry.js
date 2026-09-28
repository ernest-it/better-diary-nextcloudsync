/* A diary entry <-> the Markdown file on disk. Pure: no fs, no Electron, no DOM — it loads
   as a browser global and through require(), so the main process, the renderer and the tests
   all agree on the one file format.

   An entry on disk is deliberately plain, because Nextcloud Notes also renders it:

     # Friday, 18 September 2026

     Tags: Jonah Pike, camping

     ## How the day went

     Today I ...

     ## Notes

     ## Tomorrow

   No frontmatter — Nextcloud Notes would print it as literal text at the top of the note.
   A plain `Tags:` line reads as an ordinary sentence there instead, and is still one grep
   away from anywhere else. Everything the app needs is recoverable from the filename (the
   date), that line, and the headings. */
const diaryEntry = (() => {
  /* The filename IS the identity of an entry. Anything else in the folder — Nextcloud's
     "(conflicted copy)" files, a stray README — is not an entry and is left alone. */
  const ID_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/i;
  const H1_RE = /^#[ \t]+(.*)$/;
  const H2_RE = /^##[ \t]+(.*)$/;
  const FENCE_RE = /^(?:```|~~~)/;
  /* Only ever matched directly under the date, never in the body — see parse(). */
  const TAGS_RE = /^[ \t]*tags[ \t]*:[ \t]*(.*)$/i;
  const MAX_TAGS = 24;
  const MAX_TAG_LENGTH = 60;

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  /* Spelled out rather than handed to Intl so an entry written on one machine gets a title
     byte-for-byte identical to one written on another, whatever locale or ICU build it has. */
  const TITLE_STYLES = ['long', 'us', 'short', 'iso'];
  const DEFAULT_TITLE_STYLE = 'long';

  const DEFAULT_HEADINGS = ['How the day went', 'Notes', 'Tomorrow'];

  const pad = (value) => String(value).padStart(2, '0');
  const isId = (id) => typeof id === 'string' && ID_RE.test(id) && Boolean(toDate(id));

  /* Built in local time on purpose: a date is a calendar square, not an instant, and
     `new Date('2026-09-18')` parses as UTC midnight — an hour that belongs to the 17th
     anywhere west of Greenwich. */
  function toDate(id) {
    const match = ID_RE.exec(String(id || ''));
    if (!match) return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(year, month - 1, day, 12, 0, 0, 0);
    /* Rejects 2026-02-31 and friends, which Date would silently roll into March. */
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
  }

  const idOf = (date) => (date instanceof Date && Number.isFinite(date.getTime())
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : '');

  /* Someone still writing at 1am is writing about yesterday. dayStartHour shifts where the
     app draws the line between one diary day and the next; 0 makes it plain midnight. */
  function todayId(now, dayStartHour) {
    const at = now instanceof Date && Number.isFinite(now.getTime()) ? new Date(now.getTime()) : new Date();
    const hour = Number.isFinite(Number(dayStartHour)) ? Math.min(12, Math.max(0, Math.floor(Number(dayStartHour)))) : 0;
    if (at.getHours() < hour) at.setDate(at.getDate() - 1);
    return idOf(at);
  }

  function shiftId(id, days) {
    const date = toDate(id);
    if (!date) return '';
    date.setDate(date.getDate() + (Number(days) || 0));
    return idOf(date);
  }

  const fileNameFor = (id) => (isId(id) ? `${id}.md` : '');

  function idFromFileName(name) {
    const match = FILE_RE.exec(String(name || ''));
    return match && isId(match[1]) ? match[1] : '';
  }

  function formatTitle(id, style) {
    const date = toDate(id);
    if (!date) return String(id || '');
    const weekday = DAYS[date.getDay()];
    const month = MONTHS[date.getMonth()];
    const day = date.getDate();
    const year = date.getFullYear();
    switch (TITLE_STYLES.includes(style) ? style : DEFAULT_TITLE_STYLE) {
      case 'us':    return `${weekday}, ${month} ${day}, ${year}`;
      case 'short': return `${weekday.slice(0, 3)} ${day} ${month.slice(0, 3)} ${year}`;
      case 'iso':   return id;
      default:      return `${weekday}, ${day} ${month} ${year}`;
    }
  }

  /* ---------- parse ---------- */

  const trimBlankEdges = (lines) => {
    let start = 0;
    let end = lines.length;
    while (start < end && !lines[start].trim()) start++;
    while (end > start && !lines[end - 1].trim()) end--;
    return lines.slice(start, end).join('\n');
  };

  const cleanHeading = (text) => String(text).replace(/[ \t]+#*[ \t]*$/, '').trim();

  /* Returns { id, title, preamble, sections: [{ heading, body }] }. The title is read but
     never trusted — stringify() always rewrites it from the date, so renaming the entry is
     a matter of changing one setting rather than rewriting every file. */
  function parse(markdown, id) {
    const text = String(markdown == null ? '' : markdown).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const entry = { id: isId(id) ? id : '', title: '', tags: [], preamble: '', sections: [] };

    let index = 0;
    while (index < lines.length && !lines[index].trim()) index++;
    const first = index < lines.length ? H1_RE.exec(lines[index]) : null;
    if (first) {
      entry.title = cleanHeading(first[1]);
      index++;
    }

    /* The tags line, and only where it belongs: directly under the date, before any prose.
       A line starting "Tags:" further down the entry is a sentence somebody wrote, not
       metadata, and is left alone in the body where they put it. */
    let peek = index;
    while (peek < lines.length && !lines[peek].trim()) peek++;
    const tagged = peek < lines.length ? TAGS_RE.exec(lines[peek]) : null;
    if (tagged) {
      entry.tags = tagList(tagged[1]);
      index = peek + 1;
    }

    /* A `## ` inside a fenced block is code, not a section break. Nobody is likely to paste
       a shell script into their diary, but silently splitting an entry in half if they did
       would be the kind of corruption you only notice much later. */
    let fenced = false;
    let heading = null;
    let buffer = [];
    const flush = () => {
      if (heading === null) entry.preamble = trimBlankEdges(buffer);
      else entry.sections.push({ heading, body: trimBlankEdges(buffer) });
      buffer = [];
    };

    for (; index < lines.length; index++) {
      const line = lines[index];
      if (FENCE_RE.test(line.trim())) fenced = !fenced;
      const match = fenced ? null : H2_RE.exec(line);
      if (!match) {
        buffer.push(line);
        continue;
      }
      flush();
      heading = cleanHeading(match[1]);
    }
    flush();
    return entry;
  }

  /* ---------- serialise ---------- */

  function stringify(entry, options = {}) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const id = isId(source.id) ? source.id : '';
    const title = id ? formatTitle(id, options.titleStyle) : String(source.title || '').trim();
    const out = [];
    if (title) out.push(`# ${title}`, '');
    const tags = tagList(source.tags);
    if (tags.length) out.push(`Tags: ${tags.join(', ')}`, '');
    const preamble = String(source.preamble || '').trim();
    if (preamble) out.push(preamble, '');
    for (const section of Array.isArray(source.sections) ? source.sections : []) {
      const heading = String((section && section.heading) || '').trim();
      if (!heading) continue;
      out.push(`## ${heading}`, '');
      const body = String((section && section.body) || '').trim();
      if (body) out.push(body, '');
    }
    /* Exactly one trailing newline, no matter how the last section ended. */
    while (out.length && !out[out.length - 1]) out.pop();
    return out.length ? `${out.join('\n')}\n` : '';
  }

  /* ---------- helpers the UI leans on ---------- */

  const headingList = (value) => {
    const list = [];
    for (const item of Array.isArray(value) ? value : []) {
      const heading = String(item == null ? '' : item).replace(/[\r\n]+/g, ' ').trim();
      /* Two sections with the same name would both write into the second one on the way
         back out, so a duplicate is dropped rather than quietly losing what you typed. */
      if (heading && !list.some(existing => existing.toLowerCase() === heading.toLowerCase())) list.push(heading);
    }
    return list;
  };

  /* Accepts either an array or the raw "a, b, c" string off the file, so the parser and the
     UI hand it the same function. Commas are the separator, which is what lets a tag be a
     person's actual name rather than a hyphenated approximation of it. */
  const tagList = (value) => {
    const source = Array.isArray(value)
      ? value
      : String(value == null ? '' : value).split(',');
    const list = [];
    for (const item of source) {
      const tag = String(item == null ? '' : item)
        .replace(/[\r\n,]+/g, ' ')   /* a comma inside a tag would split it on the way back in */
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^#+\s*/, '')        /* typing #camping out of habit means camping */
        .trim()
        .slice(0, MAX_TAG_LENGTH);
      if (!tag) continue;
      if (list.some(existing => existing.toLowerCase() === tag.toLowerCase())) continue;
      list.push(tag);
      if (list.length >= MAX_TAGS) break;
    }
    return list;
  };

  const scaffold = (id, headings) => ({
    id: isId(id) ? id : '',
    title: '',
    tags: [],
    preamble: '',
    sections: (headingList(headings).length ? headingList(headings) : DEFAULT_HEADINGS).map(heading => ({ heading, body: '' }))
  });

  /* Did anybody type anything into the entry itself? Tags deliberately do not count here,
     so that adding a section to a tagged-but-unwritten day still works. */
  const hasWriting = (entry) => {
    const source = entry && typeof entry === 'object' ? entry : {};
    if (String(source.preamble || '').trim()) return true;
    return (Array.isArray(source.sections) ? source.sections : []).some(section => String((section && section.body) || '').trim());
  };

  /* Whether the file is worth creating at all. Tagging a day is a deliberate act, so a day
     with nothing but tags on it is still an entry. */
  const isBlank = (entry) => {
    const source = entry && typeof entry === 'object' ? entry : {};
    return !hasWriting(source) && !tagList(source.tags).length;
  };

  /* Only ever fills in an entry that has nothing in it. A file you have already written in
     keeps the headings it was written with, even if the setting has changed since — the app
     does not reach into last week's entry to add a section to it. */
  function ensureSections(entry, headings) {
    const wanted = headingList(headings);
    if (!wanted.length || hasWriting(entry)) return entry;
    const have = new Set((entry.sections || []).map(section => String(section.heading || '').toLowerCase()));
    const sections = (entry.sections || []).slice();
    for (const heading of wanted) if (!have.has(heading.toLowerCase())) sections.push({ heading, body: '' });
    return { ...entry, sections };
  }

  /* Flattened text for the search index — heading names included, so "tomorrow" finds the
     section as well as the word. Markdown punctuation is stripped so a search for "Wren"
     still matches "**Wren**". */
  function plainText(entry) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const parts = [String(source.preamble || '')];
    for (const section of Array.isArray(source.sections) ? source.sections : []) {
      parts.push(String((section && section.heading) || ''), String((section && section.body) || ''));
    }
    return parts.join('\n')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~>#|]/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  /* What search matches against. Tags ride along so typing a person's name finds every day
     you tagged with them as well as every day you mentioned them. */
  const searchText = (entry) => {
    const source = entry && typeof entry === 'object' ? entry : {};
    const tags = tagList(source.tags).join(' ');
    const body = plainText(source);
    return tags ? `${tags}\n${body}` : body;
  };

  const wordCount = (entry) => {
    const text = plainText(entry).replace(/^[-\d.\s]+$/gm, ' ');
    const words = text.match(/[\p{L}\p{N}'’-]+/gu);
    return words ? words.length : 0;
  };

  return {
    ID_RE, FILE_RE, DEFAULT_HEADINGS, TITLE_STYLES, DEFAULT_TITLE_STYLE,
    isId, toDate, idOf, todayId, shiftId, fileNameFor, idFromFileName, formatTitle,
    parse, stringify, scaffold, ensureSections, isBlank, hasWriting,
    headingList, tagList, plainText, searchText, wordCount
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = diaryEntry;
/* A top-level `const` in a classic script lives in script scope, not on the window, so the
   modules that reach for `window.diaryEntry` would otherwise find nothing there. */
if (typeof window !== 'undefined') window.diaryEntry = diaryEntry;
