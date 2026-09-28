/* What the app does to a file every time you open a day and type one character:
   disk -> parse -> editor HTML -> back to Markdown -> disk. Anything lost here is lost
   from somebody's diary, so the bar is that the second pass equals the first. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const entry = require('../src/entry.js');
const markdown = require('../src/markdown.js');

/* The editor's half of the trip, without a browser: parseHtml gives markdown.js the same
   node shape a real contenteditable would. */
const throughEditor = (body) => markdown.fromEditor(markdown.parseHtml(markdown.toEditor(body))).trim();

function reopen(source, id = '2026-09-18') {
  const parsed = entry.parse(source, id);
  return entry.stringify({
    ...parsed,
    preamble: parsed.preamble ? throughEditor(parsed.preamble) : '',
    sections: parsed.sections.map(section => ({ heading: section.heading, body: throughEditor(section.body) }))
  }, { titleStyle: 'long' });
}

/* A Markdown hard break is two trailing spaces, which is invisible here and which editors
   and linters love to strip. Spelling it out keeps the fixture meaning what it says. */
const HARD = '  ';

/* Deliberately exercises what actually turns up in a diary: long unwrapped prose, an em
   dash, parenthetical asides, a hard line break, a list, and some emphasis. */
const REAL_WORLD = `# Friday, 18 September 2026

## How the day went

Walked the reservoir path after work (took the long way round past the old pumphouse, which was worth it). The water was flat enough to see the whole far treeline sitting upside down in it. Stayed until the light went. I didn't take a single photo and I'm not sorry about it — some of it I'd rather just remember.

Rang the parts place on the way back. They reckon it's the **bearing** and not the pump, which would be a relief.

## Notes

ring the parts place back${HARD}
order the filter before the weekend

- new wiper blades
- oil filter

## Tomorrow

swap show at the fairground, then *maybe* the hardware shop
`;

test('a real entry survives being opened and saved', () => {
  assert.strictEqual(reopen(REAL_WORLD), REAL_WORLD);
});

test('opening and saving is idempotent — the second pass changes nothing', () => {
  const once = reopen(REAL_WORLD);
  assert.strictEqual(reopen(once), once);
});

test('a hard line break stays a hard line break', () => {
  /* Two trailing spaces are what makes Nextcloud Notes keep these on separate lines.
     A bare newline would render as one joined paragraph there. */
  const out = reopen('# F\n\n## Notes\n\nring the parts place  \norder the filter\n');
  assert.match(out, /ring the parts place {2}\norder the filter/);
});

test('a soft wrap is a wrap, not a break — the paragraph is reflowed, not chopped up', () => {
  /* A file typed in another editor is usually wrapped at some column. Markdown says those
     newlines are whitespace; if the app turned each one into a hard break, opening the file
     once would permanently change how it renders everywhere else. */
  const wrapped = '# F\n\n## Notes\n\nthe water was flat enough\nto see the far treeline\n';
  const out = reopen(wrapped);
  assert.match(out, /the water was flat enough to see the far treeline/);
  assert.doesNotMatch(out, /enough {2}\n/, 'no hard break was invented');
  assert.strictEqual(reopen(out), out, 'and it settles after the first pass');
});

test('soft wraps and hard breaks in one paragraph keep their own meanings', () => {
  const mixed = '# F\n\n## Notes\n\nfirst line\nstill the first line  \nsecond line\n';
  const out = reopen(mixed);
  assert.match(out, /first line still the first line {2}\nsecond line/);
  assert.strictEqual(reopen(out), out);
});

test('every entry ends with exactly one newline', () => {
  for (const source of [REAL_WORLD, '# F\n\n## Notes\n\nhi', '# F\n\n## Notes\n\nhi\n\n\n\n']) {
    const out = reopen(source);
    assert.strictEqual(out.endsWith('\n'), true);
    assert.strictEqual(out.endsWith('\n\n'), false);
  }
});

test('inline formatting round trips', () => {
  const cases = [
    'plain words',
    'some **bold** text',
    'some *italic* text',
    'a ==highlight== in the middle',
    'a `code span` here',
    'a [link](https://example.com) here',
    '- one\n- two\n- three',
    '1. first\n2. second',
    '> something somebody said'
  ];
  for (const body of cases) {
    const once = throughEditor(body);
    assert.strictEqual(throughEditor(once), once, body);
  }
});

test('Markdown punctuation typed as ordinary text is escaped, not executed', () => {
  const out = throughEditor('the cost was 5 * 3 and _not_ a typo');
  assert.strictEqual(throughEditor(out), out);
});

test('an entry with nothing in it keeps its headings', () => {
  const blank = '# Friday, 18 September 2026\n\n## How the day went\n\n## Notes\n\n## Tomorrow\n';
  assert.strictEqual(reopen(blank), blank);
});

test('a heading you renamed is kept, not replaced with the default', () => {
  const custom = '# Friday, 18 September 2026\n\n## What I did today\n\nthings\n\n## Loose ends\n\nmore\n';
  assert.strictEqual(reopen(custom), custom);
});

test('an entry written by hand elsewhere keeps its shape', () => {
  const byHand = '# Friday, 18 September 2026\n\nscribbled on the train\n\n## Notes\n\nhi\n';
  assert.strictEqual(reopen(byHand), byHand);
});

test('HTML in an entry cannot escape into the editor', () => {
  const nasty = '# F\n\n## Notes\n\n<script>alert(1)</script> and <img src=x onerror=alert(1)>\n';
  const html = markdown.toEditor(entry.parse(nasty, '2026-09-18').sections[0].body);
  /* It survives as visible text, which is what somebody who typed it into their diary
     meant — but no part of it is a live element, so `onerror` is just letters on a page. */
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a very long entry does not blow up or lose its tail', () => {
  const body = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} about the day.`).join('\n\n');
  const out = throughEditor(body);
  assert.match(out, /^Paragraph 0 /);
  assert.match(out, /Paragraph 399 about the day\.$/);
  assert.strictEqual(throughEditor(out), out);
});

/* ---------------------------------------------------------------- photos */

test('a photo survives the trip to the editor and back', () => {
  const source = '# Friday, 18 September 2026\n\n## Notes\n\n![by the water](2026-09-18-assets/photo-1.jpg)\n';
  assert.strictEqual(reopen(source), source);
});

test('a photo with no caption keeps having no caption', () => {
  /* Not `![image](...)`: a caption of the word "image" on every uncaptioned photo is noise
     in a file somebody reads. */
  const source = '# Friday, 18 September 2026\n\n## Notes\n\n![](2026-09-18-assets/photo-1.jpg)\n';
  assert.strictEqual(reopen(source), source);
});

test('the editor is shown a URL it can fetch, the file keeps the relative path', () => {
  /* The page cannot load a path relative to an entry outside the app, so toEditor is handed
     a mapping; fromEditor must put the plain path back or the file stops being portable. */
  const toDisplay = (dest) => {
    const m = /^(\d{4}-\d{2}-\d{2})-assets\/([^/]+)$/.exec(dest);
    return m ? `diary-asset://entry/${m[1]}/${m[2]}` : '';
  };
  const toStored = (src) => {
    const m = /^diary-asset:\/\/entry\/([^/]+)\/([^/]+)$/.exec(src);
    return m ? `${m[1]}-assets/${m[2]}` : src;
  };

  const html = markdown.toEditor('![a caption](2026-09-18-assets/photo-1.jpg)', { onImage: toDisplay });
  assert.match(html, /src="diary-asset:\/\/entry\/2026-09-18\/photo-1\.jpg"/);

  const back = markdown.fromEditor(markdown.parseHtml(html), { onImage: toStored });
  assert.strictEqual(back, '![a caption](2026-09-18-assets/photo-1.jpg)');
});

test('the asset scheme survives the sanitiser but a javascript: src does not', () => {
  const good = markdown.sanitizeHtml('<img src="diary-asset://entry/2026-09-18/photo-1.jpg" alt="x">');
  assert.match(good, /diary-asset:\/\/entry/);
  const bad = markdown.sanitizeHtml('<img src="javascript:alert(1)" alt="x">');
  assert.doesNotMatch(bad, /javascript:/);
});

test('an image the app knows nothing about is left exactly as written', () => {
  const source = '# Friday, 18 September 2026\n\n## Notes\n\n![remote](https://example.com/a.png)\n';
  assert.strictEqual(reopen(source), source);
});
