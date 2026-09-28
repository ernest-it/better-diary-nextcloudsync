/* Markdown <-> daily-diary editor HTML. Loads as a browser global and via require(). */
const diaryMarkdown = (() => {
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;
  const COMMENT_NODE = 8;
  /* Guards against a hostile note blowing the stack in the recursive walkers. */
  const MAX_DEPTH = 400;
  const MAX_LIST_DEPTH = 64;

  /* ---------- entities and escaping ---------- */

  const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003',
    thinsp: '\u2009', shy: '\u00ad', copy: '©', reg: '®', trade: '™', hellip: '…',
    mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    laquo: '«', raquo: '»', bull: '•', middot: '·', deg: '°', times: '×',
    divide: '÷', plusmn: '±', frac12: '½', frac14: '¼', sup2: '²', sup3: '³',
    larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', dagger: '†',
    sect: '§', para: '¶', euro: '€', pound: '£', yen: '¥', cent: '¢'
  };
  const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

  const decodeEntities = (text) => text.indexOf('&') === -1 ? text : text.replace(ENTITY_RE, (match, body) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
      return code === 0 ? '\ufffd' : String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const escapeHtml = (text) => String(text).replace(/[&<>]/g, ch => HTML_ESCAPES[ch]);
  const escapeAttribute = (text) => String(text).replace(/[&<>"]/g, ch => HTML_ESCAPES[ch]);

  /* ---------- a DOM-shaped node tree so fromEditor() has one implementation ---------- */

  class LeafText {
    constructor(value) { this.nodeType = TEXT_NODE; this.nodeValue = value; this.parentNode = null; }
    get textContent() { return this.nodeValue; }
  }

  class LeafComment {
    constructor(value) { this.nodeType = COMMENT_NODE; this.nodeValue = value; this.parentNode = null; }
    get textContent() { return ''; }
  }

  class LeafElement {
    constructor(name, attributes) {
      this.nodeType = ELEMENT_NODE;
      this.localName = String(name).toLowerCase();
      this.tagName = this.localName.toUpperCase();
      this.attributes = attributes || new Map();
      this.childNodes = [];
      this.parentNode = null;
      this.nodeValue = null;
    }
    get children() { return this.childNodes.filter(node => node.nodeType === ELEMENT_NODE); }
    get firstElementChild() { const kids = this.children; return kids.length ? kids[0] : null; }
    get lastElementChild() { const kids = this.children; return kids.length ? kids[kids.length - 1] : null; }
    get classList() {
      const value = this.attributes.get('class') || '';
      if (!this._classList || this._classSource !== value) {
        const names = new Set(value.split(/\s+/).filter(Boolean));
        this._classSource = value;
        this._classList = { contains: (name) => names.has(name) };
      }
      return this._classList;
    }
    getAttribute(name) {
      const value = this.attributes.get(String(name).toLowerCase());
      return value === undefined ? null : value;
    }
    hasAttribute(name) { return this.attributes.has(String(name).toLowerCase()); }
    setAttribute(name, value) { this.attributes.set(String(name).toLowerCase(), String(value)); }
    removeAttribute(name) { this.attributes.delete(String(name).toLowerCase()); }
    append(child) { child.parentNode = this; this.childNodes.push(child); }
    get textContent() {
      let out = '';
      for (const child of this.childNodes) out += child.textContent;
      return out;
    }
    querySelector(selector) { const all = querySelectorAll(this, selector, true); return all.length ? all[0] : null; }
    querySelectorAll(selector) { return querySelectorAll(this, selector, false); }
  }

  /* Compound selectors (tag/.class/#id) with optional descendant combinators — all the app uses. */
  const parseSelector = (selector) => String(selector).split(',').map(group => group.trim()).filter(Boolean).map(group =>
    group.split(/\s+/).map(compound => {
      const tag = /^[A-Za-z][A-Za-z0-9-]*/.exec(compound);
      const spec = { tag: tag ? tag[0].toUpperCase() : null, classes: [], id: null };
      const token = /([.#])([A-Za-z0-9_-]+)/g;
      let match;
      while ((match = token.exec(compound))) {
        if (match[1] === '.') spec.classes.push(match[2]);
        else spec.id = match[2];
      }
      return spec;
    })
  );

  const matchesSpec = (el, spec) => {
    if (spec.tag && spec.tag !== '*' && el.tagName !== spec.tag) return false;
    if (spec.id && el.getAttribute('id') !== spec.id) return false;
    return spec.classes.every(name => el.classList.contains(name));
  };

  const matchesChain = (el, chain) => {
    if (!matchesSpec(el, chain[chain.length - 1])) return false;
    let node = el.parentNode;
    for (let index = chain.length - 2; index >= 0; index--) {
      while (node && !matchesSpec(node, chain[index])) node = node.parentNode;
      if (!node) return false;
      node = node.parentNode;
    }
    return true;
  };

  function querySelectorAll(root, selector, first) {
    const chains = parseSelector(selector);
    const found = [];
    const walk = (node, depth) => {
      if (depth > MAX_DEPTH) return true;
      for (const child of node.childNodes) {
        if (child.nodeType !== ELEMENT_NODE) continue;
        if (chains.some(chain => matchesChain(child, chain))) {
          found.push(child);
          if (first) return true;
        }
        if (walk(child, depth + 1)) return true;
      }
      return false;
    };
    walk(root, 0);
    return found;
  }

  /* ---------- HTML parser (linear scan, contenteditable dialect) ---------- */

  const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);
  const IMPLIED_END = {
    li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], p: ['p'], td: ['td', 'th'], th: ['td', 'th'],
    tr: ['tr', 'td', 'th'], option: ['option'], thead: ['td', 'th', 'tr'], tbody: ['td', 'th', 'tr', 'thead'],
    tfoot: ['td', 'th', 'tr', 'thead', 'tbody']
  };
  const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figcaption',
    'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol',
    'p', 'pre', 'section', 'table', 'ul']);

  /* `<` never belongs to a tag or attribute name — allowing it lets `<scr<script>` smuggle a tag. */
  const TAG_NAME_RE = /([a-zA-Z][^\s/><]*)/y;
  const WHITESPACE_RE = /\s*/y;
  const ATTRIBUTE_RE = /([^\s/><=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s><]*)))?/y;

  function parseHtml(html) {
    const source = String(html == null ? '' : html);
    const root = new LeafElement('#root');
    const stack = [root];
    let pending = '';
    let index = 0;

    const top = () => stack[stack.length - 1];
    const attach = (node) => { node.parentNode = top(); top().childNodes.push(node); };
    const flush = () => { if (pending) { attach(new LeafText(decodeEntities(pending))); pending = ''; } };

    const openTag = (name, attributes, selfClosing) => {
      const implied = IMPLIED_END[name];
      if (implied) while (stack.length > 1 && implied.indexOf(top().localName) !== -1) stack.pop();
      if (CLOSES_P.has(name)) while (stack.length > 1 && top().localName === 'p') stack.pop();
      const el = new LeafElement(name, attributes);
      attach(el);
      if (!selfClosing && !VOID_ELEMENTS.has(name) && stack.length < MAX_DEPTH) stack.push(el);
      return el;
    };

    const closeTag = (name) => {
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth].localName === name) { stack.length = depth; return; }
      }
    };

    while (index < source.length) {
      const lt = source.indexOf('<', index);
      if (lt === -1) { pending += source.slice(index); break; }
      if (lt > index) pending += source.slice(index, lt);

      if (source.startsWith('<!--', lt)) {
        flush();
        const end = source.indexOf('-->', lt + 4);
        attach(new LeafComment(end === -1 ? source.slice(lt + 4) : source.slice(lt + 4, end)));
        index = end === -1 ? source.length : end + 3;
        continue;
      }
      if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
        flush();
        const end = source.indexOf('>', lt);
        index = end === -1 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith('</', lt)) {
        TAG_NAME_RE.lastIndex = lt + 2;
        const name = TAG_NAME_RE.exec(source);
        if (!name) { pending += '<'; index = lt + 1; continue; }
        const end = source.indexOf('>', TAG_NAME_RE.lastIndex);
        flush();
        closeTag(name[1].toLowerCase());
        index = end === -1 ? source.length : end + 1;
        continue;
      }

      TAG_NAME_RE.lastIndex = lt + 1;
      const name = TAG_NAME_RE.exec(source);
      if (!name) { pending += '<'; index = lt + 1; continue; }
      const tag = name[1].toLowerCase();
      const attributes = new Map();
      let cursor = TAG_NAME_RE.lastIndex;
      let selfClosing = false;
      for (;;) {
        WHITESPACE_RE.lastIndex = cursor;
        WHITESPACE_RE.exec(source);
        cursor = WHITESPACE_RE.lastIndex;
        if (cursor >= source.length) break;
        const ch = source.charAt(cursor);
        if (ch === '>') { cursor++; break; }
        if (ch === '/') { selfClosing = true; cursor++; continue; }
        ATTRIBUTE_RE.lastIndex = cursor;
        const attribute = ATTRIBUTE_RE.exec(source);
        if (!attribute || ATTRIBUTE_RE.lastIndex === cursor) { cursor++; continue; }
        cursor = ATTRIBUTE_RE.lastIndex;
        const key = attribute[1].toLowerCase();
        const raw = attribute[2] !== undefined ? attribute[2] : attribute[3] !== undefined ? attribute[3] : attribute[4] !== undefined ? attribute[4] : '';
        if (!attributes.has(key)) attributes.set(key, decodeEntities(raw));
      }

      flush();
      const element = openTag(tag, attributes, selfClosing);
      index = cursor;

      if (RAW_TEXT_ELEMENTS.has(tag) && !selfClosing) {
        const closer = new RegExp('</' + tag + '[^>]*>', 'ig');
        closer.lastIndex = index;
        const end = closer.exec(source);
        const raw = source.slice(index, end ? end.index : source.length);
        if (raw) element.append(new LeafText(raw));
        index = end ? closer.lastIndex : source.length;
        closeTag(tag);
      }
    }
    flush();
    return root;
  }

  /* ---------- serialiser ---------- */

  function serializeNode(node, depth) {
    if (node.nodeType === TEXT_NODE) return escapeHtml(node.nodeValue);
    if (node.nodeType !== ELEMENT_NODE || depth > MAX_DEPTH) return '';
    let attributes = '';
    for (const [key, value] of node.attributes) attributes += ` ${key}="${escapeAttribute(value)}"`;
    const open = `<${node.localName}${attributes}>`;
    if (VOID_ELEMENTS.has(node.localName)) return open;
    return `${open}${serializeChildren(node, depth + 1)}</${node.localName}>`;
  }

  const serializeChildren = (node, depth = 0) => node.childNodes.map(child => serializeNode(child, depth)).join('');

  /* ---------- sanitiser ---------- */

  const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template',
    'svg', 'math', 'form', 'input', 'textarea', 'select', 'button', 'link', 'meta', 'base', 'head', 'title',
    'frame', 'frameset', 'applet', 'audio', 'video', 'source', 'track', 'canvas', 'portal', 'map', 'area']);
  const ALLOWED_ELEMENTS = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
    'dd', 'del', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
    'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span', 'strong',
    'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var', 'wbr']);
  const GLOBAL_ATTRIBUTES = new Set(['class', 'id', 'title', 'dir', 'lang', 'align', 'colspan', 'rowspan',
    'width', 'height', 'start', 'reversed', 'datetime', 'span', 'spellcheck']);
  const ELEMENT_ATTRIBUTES = { a: new Set(['href']), img: new Set(['src', 'alt', 'loading']), ol: new Set(['type']), li: new Set(['value']) };
  const URL_ATTRIBUTES = new Set(['href', 'src']);
  const SAFE_SCHEME_RE = /^(?:https?|mailto|tel):/i;
  const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif|apng);base64,[A-Za-z0-9+/=]*$/i;
  /* The app's own scheme for a photo sitting next to the entry; main.js serves it and will
     not hand back anything outside the diary folder. */
  const ASSET_URL_RE = /^diary-asset:\/\/[A-Za-z0-9._~%/-]*$/i;

  /* Returns the value to keep, or null to drop the attribute. data:image/svg+xml is refused: SVG can script. */
  function safeUrl(value) {
    const raw = String(value == null ? '' : value).trim();
    const probe = raw.replace(/[\u0000- \u007f]/g, '');
    if (!probe) return null;
    if (probe.slice(0, 2) === '//') return null;
    if (/^data:/i.test(probe)) return SAFE_DATA_IMAGE_RE.test(probe) ? probe : null;
    if (/^diary-asset:/i.test(probe)) return ASSET_URL_RE.test(probe) ? raw : null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(probe)) return SAFE_SCHEME_RE.test(probe) ? raw : null;
    return raw;
  }

  const attributeAllowed = (tag, name) => {
    if (/^on/.test(name) || name === 'style' || name === 'srcset' || name === 'formaction') return false;
    if (name.slice(0, 5) === 'data-' || name.slice(0, 5) === 'aria-' || name === 'role') return true;
    const extra = ELEMENT_ATTRIBUTES[tag];
    if (extra && extra.has(name)) return true;
    return GLOBAL_ATTRIBUTES.has(name);
  };

  function sanitizeChildren(parent, depth) {
    const kept = [];
    for (const child of parent.childNodes) {
      if (child.nodeType === TEXT_NODE) { kept.push(child); continue; }
      if (child.nodeType !== ELEMENT_NODE) continue;
      const tag = child.localName;
      if (DROP_WITH_CONTENT.has(tag)) continue;
      if (depth < MAX_DEPTH) sanitizeChildren(child, depth + 1);
      if (!ALLOWED_ELEMENTS.has(tag)) { for (const kid of child.childNodes) { kid.parentNode = parent; kept.push(kid); } continue; }
      for (const key of [...child.attributes.keys()]) {
        if (!attributeAllowed(tag, key)) { child.attributes.delete(key); continue; }
        if (!URL_ATTRIBUTES.has(key)) continue;
        const url = safeUrl(child.attributes.get(key));
        if (url === null) child.attributes.delete(key);
        else child.attributes.set(key, url);
      }
      kept.push(child);
    }
    parent.childNodes = kept;
  }

  function sanitizeHtml(html) {
    const root = html && html.nodeType === ELEMENT_NODE ? html : parseHtml(html);
    sanitizeChildren(root, 0);
    return serializeChildren(root);
  }

  /* ---------- editor HTML -> Markdown ---------- */

  const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE', 'FIGURE']);
  const SPECIAL = ['table', 'callout', 'image-card'];
  const ALIGN_MARKERS = { l: ':---', c: ':---:', r: '---:' };

  const escapeText = (text) => text.replace(/([\\`*_[\]])/g, '\\$1');
  const isBlockish = (node) => node.nodeType === ELEMENT_NODE && (BLOCK_TAGS.has(node.tagName) || SPECIAL.some(name => node.classList.contains(name)));
  const attributeOf = (el, name) => (typeof el.getAttribute === 'function' ? el.getAttribute(name) : null) || '';

  function inline(node, ctx) {
    if (node.nodeType === TEXT_NODE) return escapeText(node.nodeValue.replace(/\s+/g, ' '));
    if (node.nodeType !== ELEMENT_NODE) return '';
    const kids = () => [...node.childNodes].map(child => inline(child, ctx)).join('');
    const wrap = (open, close) => { const text = kids().trim(); return text ? `${open}${text}${close}` : ''; };
    switch (node.tagName) {
      /* A Markdown hard break, not a bare newline: these files are also read by Nextcloud
         Notes, which joins single-newline lines into one paragraph the way Markdown says
         to. The two trailing spaces are what keep a line break a line break there too. */
      case 'BR': return '  \n';
      case 'IMG': return ctx.image(node);
      case 'B': case 'STRONG': return wrap('**', '**');
      case 'I': case 'EM': return wrap('*', '*');
      case 'U': return wrap('<u>', '</u>');
      case 'MARK': return wrap('==', '==');
      case 'S': case 'DEL': return wrap('~~', '~~');
      case 'CODE': return node.textContent ? `\`${node.textContent}\`` : '';
      case 'A': { const href = node.getAttribute('href'); const text = kids().trim(); return href ? `[${text}](${href})` : text; }
      default: return kids();
    }
  }

  function listBlock(list, ctx, ordered, depth = 0) {
    const items = [...list.children].filter(child => child.tagName === 'LI');
    return items.map((item, index) => {
      const nested = [...item.children].filter(child => child.tagName === 'UL' || child.tagName === 'OL');
      const text = [...item.childNodes].filter(node => !nested.includes(node)).map(node => inline(node, ctx)).join('').trim();
      const marker = ordered ? `${index + 1}.` : '-';
      const lines = [`${marker} ${text}`.trimEnd()];
      for (const sub of nested) lines.push(listBlock(sub, ctx, sub.tagName === 'OL', depth + 1).split('\n').map(line => `  ${line}`).join('\n'));
      return lines.join('\n');
    }).join('\n');
  }

  function tableBlock(el, ctx) {
    const rows = [...el.querySelectorAll('.tr, tr')].map(row => [...row.children].map(cell => inline(cell, ctx).trim().replace(/\|/g, '\\|')));
    if (!rows.length) return [];
    const width = Math.max(...rows.map(row => row.length));
    const line = (cells) => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`;
    /* data-align is written by toEditor(); editor-authored tables have none and stay `---`. */
    const spec = attributeOf(el, 'data-align').split(',');
    const divider = Array.from({ length: width }, (unused, index) => ALIGN_MARKERS[spec[index]] || '---');
    const [head, ...body] = rows;
    return [[line(head), line(divider), ...body.map(line)].join('\n')];
  }

  function quoteBlock(el, ctx) {
    const body = el.classList.contains('callout') ? (el.lastElementChild || el) : el;
    const text = inline(body, ctx).replace(/[ \t]*\n[ \t]*/g, '\n').trim();
    if (!text) return [];
    return [text.split('\n').map(line => `> ${line}`.trimEnd()).join('\n')];
  }

  function cardBlock(el, ctx) {
    const image = el.querySelector('img');
    if (image) return [ctx.image(image)].filter(Boolean);
    const caption = el.querySelector('.image-caption');
    if (!caption) return [];
    const parts = [...caption.children].map(node => node.textContent.trim()).filter(text => /[a-z0-9]/i.test(text));
    return parts.length ? [`*${parts.join(' — ')}*`] : [];
  }

  function blockFor(el, ctx) {
    const tag = el.tagName;
    if (el.classList.contains('table')) return tableBlock(el, ctx);
    if (el.classList.contains('callout')) return quoteBlock(el, ctx);
    if (el.classList.contains('image-card')) return cardBlock(el, ctx);
    if (/^H[1-6]$/.test(tag)) { const text = inline(el, ctx).trim(); return text ? [`${'#'.repeat(Number(tag[1]))} ${text}`] : []; }
    if (tag === 'UL' || tag === 'OL') { const text = listBlock(el, ctx, tag === 'OL'); return text ? [text] : []; }
    if (tag === 'BLOCKQUOTE') return quoteBlock(el, ctx);
    if (tag === 'PRE') return ['```' + attributeOf(el, 'data-lang') + '\n' + el.textContent.replace(/\n+$/, '') + '\n```'];
    if (tag === 'HR') return ['---'];
    if (tag === 'TABLE') return tableBlock(el, ctx);
    if (tag === 'IMG') return [ctx.image(el)].filter(Boolean);
    if (tag === 'P') { const text = inline(el, ctx).trim(); if (!text) return []; return [el.classList.contains('bullet') ? `- ${text}` : text]; }
    if (BLOCK_TAGS.has(tag) && [...el.children].some(isBlockish)) return blocks(el, ctx);
    const text = inline(el, ctx).trim();
    return text ? [text] : [];
  }

  function blocks(root, ctx) {
    const out = [];
    for (const child of root.childNodes) {
      if (child.nodeType === TEXT_NODE) { const text = child.nodeValue.trim(); if (text) out.push(escapeText(text)); continue; }
      if (child.nodeType !== ELEMENT_NODE) continue;
      out.push(...blockFor(child, ctx));
    }
    // Adjacent bullet paragraphs are one list, so keep them tight rather than blank-line separated.
    const merged = [];
    for (const block of out) {
      const previous = merged[merged.length - 1];
      if (previous && /^- /.test(previous.split('\n').pop()) && /^- /.test(block)) merged[merged.length - 1] = `${previous}\n${block}`;
      else merged.push(block);
    }
    return merged;
  }

  /* onImage(src, alt) returns the Markdown link target, or '' to drop the image. */
  function fromEditor(root, options = {}) {
    const ctx = {
      image(node) {
        const src = node.getAttribute('src') || '';
        /* An empty alt stays empty: `![](photo-1.jpg)` reads better in the file than a
           caption of the word "image" on every photo somebody never captioned. */
        const alt = String(node.getAttribute('alt') || '').replace(/[[\]]/g, '');
        const target = options.onImage ? options.onImage(src, alt) : src;
        return target ? `![${alt}](${target})` : '';
      }
    };
    return blocks(root, ctx).filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  const fromEditorHtml = (html, options = {}) => fromEditor(parseHtml(html), options);

  /* ---------- Markdown -> editor HTML ---------- */

  const PUNCTUATION_RE = /[\\`*_[\]{}()#+\-.!>~=|"'$%&,/:;<?@^]/;
  const ESCAPE_RE = /\\([\\`*_[\]{}()#+\-.!>~=|"'$%&,/:;<?@^])/g;
  const unescapeBackslashes = (text) => text.replace(ESCAPE_RE, '$1');

  const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/;
  const FENCE_END_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
  const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
  const THEMATIC_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const QUOTE_RE = /^ {0,3}>/;
  const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
  const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
  const RAW_INLINE_RE = /^<(\/?)(u|br)[ \t]*\/?>/i;
  const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/;
  const EMAIL_RE = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;

  const DELIMITER_CHARS = /[*_~=]/;
  const DELIMITERS = [
    { mark: '***', open: '<b><i>', close: '</i></b>' },
    { mark: '___', open: '<b><i>', close: '</i></b>', word: true },
    { mark: '**', open: '<b>', close: '</b>' },
    { mark: '__', open: '<b>', close: '</b>', word: true },
    { mark: '~~', open: '<s>', close: '</s>' },
    { mark: '==', open: '<mark>', close: '</mark>' },
    { mark: '*', open: '<i>', close: '</i>' },
    { mark: '_', open: '<i>', close: '</i>', word: true }
  ];

  function matchCodeSpan(text, start) {
    let run = 0;
    while (text.charAt(start + run) === '`') run++;
    const marker = '`'.repeat(run);
    let cursor = start + run;
    while (cursor < text.length) {
      const found = text.indexOf(marker, cursor);
      if (found === -1) return null;
      let after = found + run;
      if (text.charAt(after) === '`') { while (text.charAt(after) === '`') after++; cursor = after; continue; }
      let code = text.slice(start + run, found);
      if (code.length > 2 && code.charAt(0) === ' ' && code.charAt(code.length - 1) === ' ' && code.trim()) code = code.slice(1, -1);
      return { code, next: after };
    }
    return null;
  }

  function matchBracketed(text, start, openChar, closeChar) {
    let depth = 0;
    for (let index = start; index < text.length; index++) {
      const ch = text.charAt(index);
      if (ch === '\\') { index++; continue; }
      if (ch === '`') { const span = matchCodeSpan(text, index); if (span) { index = span.next - 1; continue; } }
      if (ch === openChar) depth++;
      else if (ch === closeChar) { depth--; if (depth === 0) return index; }
    }
    return -1;
  }

  function matchLinkTarget(text, start) {
    let cursor = start + 1;
    const skipSpace = () => { while (cursor < text.length && /[ \t]/.test(text.charAt(cursor))) cursor++; };
    skipSpace();
    let dest = '';
    if (text.charAt(cursor) === '<') {
      const close = text.indexOf('>', cursor + 1);
      if (close === -1) return null;
      dest = text.slice(cursor + 1, close);
      cursor = close + 1;
    } else {
      const from = cursor;
      let depth = 0;
      while (cursor < text.length) {
        const ch = text.charAt(cursor);
        if (ch === '\\') { cursor += 2; continue; }
        if (/\s/.test(ch)) break;
        if (ch === '(') depth++;
        else if (ch === ')') { if (depth === 0) break; depth--; }
        cursor++;
      }
      dest = text.slice(from, cursor);
    }
    skipSpace();
    let title = '';
    const quote = text.charAt(cursor);
    if (quote === '"' || quote === '\'') {
      const close = text.indexOf(quote, cursor + 1);
      if (close === -1) return null;
      title = unescapeBackslashes(text.slice(cursor + 1, close));
      cursor = close + 1;
      skipSpace();
    }
    if (text.charAt(cursor) !== ')') return null;
    return { dest: unescapeBackslashes(dest), title, next: cursor + 1 };
  }

  const isWordChar = (ch) => Boolean(ch) && /[A-Za-z0-9]/.test(ch);

  function inlineToHtml(source) {
    const text = String(source == null ? '' : source);
    const memo = new Map();
    const budget = { steps: 400000 };

    const matchEmphasis = (start) => {
      if (memo.has(start)) return memo.get(start);
      let result = null;
      for (const delimiter of DELIMITERS) {
        const mark = delimiter.mark;
        if (!text.startsWith(mark, start)) continue;
        const after = text.charAt(start + mark.length);
        if (!after || /\s/.test(after)) continue;
        if (delimiter.word && isWordChar(text.charAt(start - 1))) continue;
        let cursor = start + mark.length;
        while (cursor < text.length) {
          if (budget.steps-- < 0) break;
          const ch = text.charAt(cursor);
          if (ch === '\\') { cursor += 2; continue; }
          if (ch === '`') { const span = matchCodeSpan(text, cursor); if (span) { cursor = span.next; continue; } }
          if (text.startsWith(mark, cursor) && !/\s/.test(text.charAt(cursor - 1))) {
            if (delimiter.word && isWordChar(text.charAt(cursor + mark.length))) { cursor += mark.length; continue; }
            break;
          }
          const nested = DELIMITER_CHARS.test(ch) ? matchEmphasis(cursor) : null;
          if (nested && nested.next > cursor) { cursor = nested.next; continue; }
          cursor++;
        }
        if (cursor >= text.length || !text.startsWith(mark, cursor)) continue;
        const content = text.slice(start + mark.length, cursor);
        if (!content) continue;
        result = { html: delimiter.open + inlineToHtml(content) + delimiter.close, next: cursor + mark.length };
        break;
      }
      memo.set(start, result);
      return result;
    };

    function scan() {
      let out = '';
      let literal = '';
      let index = 0;
      let openUnderline = 0;
      const flush = () => { if (literal) { out += escapeHtml(literal); literal = ''; } };
      while (index < text.length) {
        const ch = text.charAt(index);
        if (ch === '\\' && PUNCTUATION_RE.test(text.charAt(index + 1))) { literal += text.charAt(index + 1); index += 2; continue; }
        if (ch === '`') {
          const span = matchCodeSpan(text, index);
          if (span) { flush(); out += `<code>${escapeHtml(span.code)}</code>`; index = span.next; continue; }
        }
        if (ch === '<') {
          const tail = text.slice(index);
          const raw = RAW_INLINE_RE.exec(tail);
          /* Only a balanced <u>..</u> pair is honoured; a lone tag is text the user typed. */
          const balanced = raw && raw[2].toLowerCase() === 'u'
            ? (raw[1] ? openUnderline > 0 : /<\/u[ \t]*>/i.test(tail))
            : Boolean(raw);
          if (balanced) {
            flush();
            if (raw[2].toLowerCase() === 'br') out += '<br>';
            else { openUnderline += raw[1] ? -1 : 1; out += `<${raw[1]}u>`; }
            index += raw[0].length;
            continue;
          }
          const scheme = AUTOLINK_RE.exec(tail);
          const email = scheme ? null : EMAIL_RE.exec(tail);
          const link = scheme || email;
          if (link) {
            flush();
            out += `<a href="${escapeAttribute(email ? `mailto:${link[1]}` : link[1])}">${escapeHtml(link[1])}</a>`;
            index += link[0].length;
            continue;
          }
        }
        if (ch === '!' && text.charAt(index + 1) === '[') {
          const close = matchBracketed(text, index + 1, '[', ']');
          const target = close !== -1 && text.charAt(close + 1) === '(' ? matchLinkTarget(text, close + 1) : null;
          if (target) {
            const alt = unescapeBackslashes(text.slice(index + 2, close));
            const title = target.title ? ` title="${escapeAttribute(target.title)}"` : '';
            flush();
            /* The file says `photo-1.jpg`, relative to the entry. The page cannot load that
               path directly, so the caller maps it to something the window can fetch. */
            const src = (imageResolver && imageResolver(target.dest, alt)) || target.dest;
            out += `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}"${title} class="pasted-image">`;
            index = target.next;
            continue;
          }
        }
        if (ch === '[') {
          const close = matchBracketed(text, index, '[', ']');
          const target = close !== -1 && text.charAt(close + 1) === '(' ? matchLinkTarget(text, close + 1) : null;
          if (target) {
            const title = target.title ? ` title="${escapeAttribute(target.title)}"` : '';
            flush();
            out += `<a href="${escapeAttribute(target.dest)}"${title}>${inlineToHtml(text.slice(index + 1, close))}</a>`;
            index = target.next;
            continue;
          }
        }
        const emphasis = matchEmphasis(index);
        if (emphasis) { flush(); out += emphasis.html; index = emphasis.next; continue; }
        literal += ch;
        index++;
      }
      flush();
      return out;
    }

    return scan();
  }

  const measureIndent = (text) => text.replace(/\t/g, '    ').length;

  function matchListItem(line) {
    const match = LIST_ITEM_RE.exec(line);
    if (!match) return null;
    return { indent: measureIndent(match[1]), ordered: /\d/.test(match[2]), content: match[3] === undefined ? '' : match[3].trim() };
  }

  function splitRow(line) {
    const trimmed = line.trim();
    const cells = [];
    let current = '';
    for (let index = 0; index < trimmed.length; index++) {
      const ch = trimmed.charAt(index);
      if (ch === '\\' && index + 1 < trimmed.length) { current += ch + trimmed.charAt(index + 1); index++; continue; }
      if (ch === '|') { cells.push(current); current = ''; continue; }
      current += ch;
    }
    cells.push(current);
    if (cells.length > 1 && trimmed.charAt(0) === '|') cells.shift();
    if (cells.length > 1 && cells[cells.length - 1].trim() === '' && trimmed.charAt(trimmed.length - 1) === '|') cells.pop();
    return cells.map(cell => cell.trim());
  }

  function tableAlignment(line) {
    if (line.indexOf('|') === -1) return null;
    const cells = splitRow(line);
    if (!cells.length) return null;
    const spec = [];
    for (const cell of cells) {
      if (!/^:?-+:?$/.test(cell)) return null;
      const left = cell.charAt(0) === ':';
      const right = cell.charAt(cell.length - 1) === ':';
      spec.push(left && right ? 'c' : right ? 'r' : left ? 'l' : '');
    }
    return spec;
  }

  const isTableStart = (lines, index, end) => index + 1 < end && lines[index].indexOf('|') !== -1 && tableAlignment(lines[index + 1]) !== null;

  const isBlockStart = (lines, index, end) => {
    const line = lines[index];
    return FENCE_RE.test(line) || ATX_RE.test(line) || THEMATIC_RE.test(line) || QUOTE_RE.test(line) ||
      Boolean(matchListItem(line)) || isTableStart(lines, index, end);
  };

  function collectList(lines, start, end, depth = 0) {
    const first = matchListItem(lines[start]);
    const list = { ordered: first.ordered, items: [] };
    let index = start;
    while (index < end) {
      const line = lines[index];
      if (!line.trim()) break;
      const item = matchListItem(line);
      if (item) {
        /* Past MAX_LIST_DEPTH deeper items flatten into this level rather than recursing. */
        if (item.indent > first.indent && list.items.length && depth < MAX_LIST_DEPTH) {
          const sub = collectList(lines, index, end, depth + 1);
          list.items[list.items.length - 1].lists.push(sub.list);
          index = sub.next;
          continue;
        }
        if (item.indent < first.indent || (item.indent === first.indent && item.ordered !== list.ordered)) break;
        list.items.push({ text: item.content, lists: [] });
        index++;
        continue;
      }
      if (!list.items.length || isBlockStart(lines, index, end)) break;
      const last = list.items[list.items.length - 1];
      last.text = `${last.text} ${line.trim()}`.trim();
      index++;
    }
    return { list, next: index };
  }

  /* A flat top-level bullet list is <p class="bullet">; anything nested becomes a real <ul>. */
  function renderList(list, top) {
    if (top && !list.ordered && !list.items.some(item => item.lists.length)) {
      return list.items.map(item => `<p class="bullet">${inlineToHtml(item.text)}</p>`).join('');
    }
    const tag = list.ordered ? 'ol' : 'ul';
    const items = list.items.map(item => `<li>${inlineToHtml(item.text)}${item.lists.map(sub => renderList(sub, false)).join('')}</li>`).join('');
    return `<${tag}>${items}</${tag}>`;
  }

  function renderTable(lines, start, end) {
    const spec = tableAlignment(lines[start + 1]);
    const rows = [splitRow(lines[start])];
    let index = start + 2;
    while (index < end && lines[index].trim() && lines[index].indexOf('|') !== -1 && !isBlockStart(lines, index, end)) {
      rows.push(splitRow(lines[index]));
      index++;
    }
    const width = Math.max(...rows.map(row => row.length));
    const align = Array.from({ length: width }, (unused, column) => spec[column] || '');
    const attribute = align.some(Boolean) ? ` data-align="${align.join(',')}"` : '';
    const html = rows.map((row, position) => {
      const cells = Array.from({ length: width }, (unused, column) => `<span>${inlineToHtml(row[column] === undefined ? '' : row[column])}</span>`).join('');
      return `<div class="tr${position === 0 ? ' th' : ''}">${cells}</div>`;
    }).join('');
    return { html: `<div class="table"${attribute}>${html}</div>`, next: index };
  }

  function parseBlocks(lines, start, end) {
    const out = [];
    let index = start;
    while (index < end) {
      const line = lines[index];
      if (!line.trim()) { index++; continue; }

      const fence = FENCE_RE.exec(line);
      if (fence) {
        const info = fence[2].trim();
        const indent = /^ */.exec(line)[0].length;
        let cursor = index + 1;
        const body = [];
        while (cursor < end) {
          const closing = FENCE_END_RE.exec(lines[cursor]);
          if (closing && closing[1].charAt(0) === fence[1].charAt(0) && closing[1].length >= fence[1].length) break;
          body.push(lines[cursor].slice(0, indent).trim() ? lines[cursor] : lines[cursor].slice(indent));
          cursor++;
        }
        const lang = info ? ` data-lang="${escapeAttribute(info)}"` : '';
        out.push(`<pre${lang}>${escapeHtml(body.join('\n').replace(/\n+$/, ''))}</pre>`);
        index = cursor < end ? cursor + 1 : cursor;
        continue;
      }

      const heading = ATX_RE.exec(line);
      if (heading) {
        const level = heading[1].length;
        const text = (heading[2] === undefined ? '' : heading[2]).replace(/[ \t]+#+$/, '').trim();
        out.push(`<h${level}>${inlineToHtml(text)}</h${level}>`);
        index++;
        continue;
      }

      if (THEMATIC_RE.test(line)) { out.push('<hr>'); index++; continue; }

      if (QUOTE_RE.test(line)) {
        const body = [];
        while (index < end) {
          const current = lines[index];
          if (QUOTE_RE.test(current)) { body.push(current.replace(/^ {0,3}> ?/, '')); index++; continue; }
          if (!current.trim() || isBlockStart(lines, index, end)) break;
          body.push(current);
          index++;
        }
        const inner = body.map(inlineToHtml).join('<br>');
        out.push(`<div class="callout"><span aria-hidden="true">✦</span><div>${inner}</div></div>`);
        continue;
      }

      if (matchListItem(line)) {
        const collected = collectList(lines, index, end);
        out.push(renderList(collected.list, true));
        index = collected.next;
        continue;
      }

      if (isTableStart(lines, index, end)) {
        const table = renderTable(lines, index, end);
        out.push(table.html);
        index = table.next;
        continue;
      }

      /* Markdown has two line endings inside a paragraph and they mean different things.
         Two or more trailing spaces, or a trailing odd run of backslashes, is a HARD break
         and becomes a <br>. Anything else is a SOFT wrap — the author's editor filling a
         line — and joins with a space, which is how every Markdown renderer, Nextcloud
         Notes included, lays it out. Treating both as <br> is what turns a paragraph that
         merely happened to be wrapped into one riddled with forced breaks the moment it is
         opened and saved. (This is where this copy diverges from the converter it came from, which only
         ever round trips through its own editor and so never sees a hand-wrapped file.) */
      const buffer = [];
      let heading2 = 0;
      while (index < end) {
        const current = lines[index];
        if (!current.trim()) break;
        if (buffer.length && SETEXT_RE.test(current)) { heading2 = current.trim().charAt(0) === '=' ? 1 : 2; index++; break; }
        if (buffer.length && isBlockStart(lines, index, end)) break;
        const trimmed = current.trim();
        const unescaped = trimmed.replace(/(^|[^\\])((?:\\\\)*)\\$/, '$1$2');
        buffer.push({ text: unescaped, hard: /[ \t]{2,}$/.test(current) || unescaped !== trimmed });
        index++;
      }
      if (!buffer.length) { index++; continue; }
      if (heading2) { out.push(`<h${heading2}>${inlineToHtml(buffer.map(line => line.text).join(' '))}</h${heading2}>`); continue; }
      let paragraph = '';
      buffer.forEach((line, at) => {
        if (at) paragraph += buffer[at - 1].hard ? '<br>' : ' ';
        paragraph += inlineToHtml(line.text);
      });
      out.push(`<p>${paragraph}</p>`);
    }
    return out.join('');
  }

  /* Set only for the duration of one toEditor() call. A module-level slot rather than an
     argument threaded through every block and inline function, which would touch most of
     this file to reach one line. JS is single-threaded, so nothing can interleave. */
  let imageResolver = null;

  /* options.onImage(dest, alt) returns the src to render with, or '' to keep the original. */
  function toEditor(markdown, options = {}) {
    imageResolver = typeof options.onImage === 'function' ? options.onImage : null;
    try {
      const text = String(markdown == null ? '' : markdown).replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
      const lines = text.split('\n');
      const html = parseBlocks(lines, 0, lines.length);
      return sanitizeHtml(html || '<p><br></p>');
    } finally {
      imageResolver = null;
    }
  }

  /* ---------- frontmatter (a strict YAML subset, not a YAML parser) ---------- */

  const FM_OPEN_RE = /^---[ \t]*\r?\n/;
  const FM_CLOSE_RE = /(?:^|\n)(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
  const FM_KEY_RE = /^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:[ \t]*(.*)$/;
  const FM_SEQ_RE = /^[ \t]*-[ \t]+(.*)$/;
  const FM_KEY_ORDER = ['title', 'tags', 'created', 'updated'];
  const FM_QUOTE_RE = /^$|^[\s>|*&!%@`#?{}[\],'"-]|[:#][ \t]|[ \t]$|[\n\r\t]|:$/;
  const FM_RESERVED_RE = /^(?:true|false|null|yes|no|on|off|~)$/i;
  const FM_NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

  function parseScalar(raw) {
    const value = raw.trim();
    if (value.length > 1 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
      return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(["\\/])/g, '$1');
    }
    if (value.length > 1 && value.charAt(0) === '\'' && value.charAt(value.length - 1) === '\'') {
      return value.slice(1, -1).replace(/''/g, '\'');
    }
    return value;
  }

  const toTags = (value) => Array.isArray(value)
    ? value.map(item => String(item).trim()).filter(Boolean)
    : String(value).split(',').map(item => item.trim()).filter(Boolean);

  function parseFrontmatter(fileText) {
    const text = String(fileText == null ? '' : fileText);
    const clean = text.replace(/^\ufeff/, '');
    const open = FM_OPEN_RE.exec(clean);
    if (!open) return { data: {}, body: text };
    const rest = clean.slice(open[0].length);
    const close = FM_CLOSE_RE.exec(rest);
    if (!close) return { data: {}, body: text };
    const block = rest.slice(0, close.index === 0 ? 0 : close.index + 1);
    const body = rest.slice(close.index + close[0].length).replace(/^(?:[ \t]*\r?\n)+/, '');

    const data = {};
    let content = 0;
    let parsed = 0;
    let pendingKey = null;
    for (const line of block.split(/\r?\n/)) {
      if (!line.trim() || /^[ \t]*#/.test(line)) continue;
      content++;
      const sequence = FM_SEQ_RE.exec(line);
      if (sequence && pendingKey) {
        if (!Array.isArray(data[pendingKey])) data[pendingKey] = [];
        data[pendingKey].push(parseScalar(sequence[1]));
        parsed++;
        continue;
      }
      const entry = FM_KEY_RE.exec(line);
      if (!entry) continue;
      parsed++;
      const key = entry[1];
      const value = parseScalar(entry[2]);
      if (value === '') { data[key] = ''; pendingKey = key; continue; }
      data[key] = value;
      pendingKey = null;
    }
    /* A block where nothing looked like YAML is not frontmatter — hand the whole file back. */
    if (content && !parsed) return { data: {}, body: text };
    if (Object.prototype.hasOwnProperty.call(data, 'tags')) data.tags = toTags(data.tags);
    return { data, body };
  }

  const quoteScalar = (value) => FM_QUOTE_RE.test(value) || FM_RESERVED_RE.test(value) || FM_NUMBER_RE.test(value)
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`
    : value;

  function stringifyFrontmatter(data, body) {
    const source = data && typeof data === 'object' ? data : {};
    const keys = FM_KEY_ORDER.filter(key => Object.prototype.hasOwnProperty.call(source, key));
    for (const key of Object.keys(source)) if (keys.indexOf(key) === -1) keys.push(key);

    const lines = [];
    for (const key of keys) {
      const value = source[key];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        const items = value.map(item => String(item)).filter(item => item.trim().length);
        if (!items.length) { lines.push(`${key}:`); continue; }
        const inlineable = key === 'tags' && items.every(item => item === item.trim() && !/[,:#\n"']/.test(item));
        if (inlineable) lines.push(`${key}: ${items.join(', ')}`);
        else { lines.push(`${key}:`); for (const item of items) lines.push(`  - ${quoteScalar(item)}`); }
        continue;
      }
      lines.push(`${key}: ${quoteScalar(String(value))}`);
    }
    const text = String(body == null ? '' : body);
    return `---\n${lines.map(line => `${line}\n`).join('')}---\n\n${text}`;
  }

  return { fromEditor, fromEditorHtml, toEditor, parseFrontmatter, stringifyFrontmatter, sanitizeHtml, parseHtml };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = diaryMarkdown;
if (typeof window !== 'undefined') window.diaryMarkdown = diaryMarkdown;
