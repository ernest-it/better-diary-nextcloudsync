'use strict';

const test = require('node:test');
const assert = require('node:assert');

const entry = require('../src/entry.js');

/* ---------------------------------------------------------------- dates */

test('a date id round trips through toDate and idOf', () => {
  for (const id of ['2026-09-18', '2024-02-29', '1999-12-31', '2026-01-01']) {
    assert.strictEqual(entry.idOf(entry.toDate(id)), id, id);
  }
});

test('impossible dates are rejected rather than rolled forward', () => {
  for (const id of ['2026-02-30', '2026-13-01', '2025-02-29', '2026-00-10', '2026-09-32']) {
    assert.strictEqual(entry.toDate(id), null, id);
    assert.strictEqual(entry.isId(id), false, id);
  }
});

test('malformed ids are not dates', () => {
  for (const id of ['', null, undefined, '2026-9-18', '26-09-18', 'today', '2026-09-18.md', 42]) {
    assert.strictEqual(entry.isId(id), false, String(id));
  }
});

test('a date is a calendar square, not a UTC instant', () => {
  /* new Date('2026-09-18') is UTC midnight, which is the 17th in every western timezone.
     toDate must not do that, whatever TZ the machine is set to. */
  const date = entry.toDate('2026-09-18');
  assert.strictEqual(date.getFullYear(), 2026);
  assert.strictEqual(date.getMonth(), 8);
  assert.strictEqual(date.getDate(), 18);
});

test('shiftId crosses month and year boundaries', () => {
  assert.strictEqual(entry.shiftId('2026-09-18', 1), '2026-09-19');
  assert.strictEqual(entry.shiftId('2026-09-30', 1), '2026-10-01');
  assert.strictEqual(entry.shiftId('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(entry.shiftId('2024-02-28', 1), '2024-02-29');
  assert.strictEqual(entry.shiftId('2025-02-28', 1), '2025-03-01');
  assert.strictEqual(entry.shiftId('nonsense', 1), '');
});

test('the diary day starts at dayStartHour, not midnight', () => {
  const lateNight = new Date(2026, 8, 19, 1, 30);   // 1:30am on the 19th
  assert.strictEqual(entry.todayId(lateNight, 4), '2026-09-18', 'still counts as the 18th');
  assert.strictEqual(entry.todayId(lateNight, 0), '2026-09-19', 'plain midnight rollover');
  const morning = new Date(2026, 8, 19, 9, 0);
  assert.strictEqual(entry.todayId(morning, 4), '2026-09-19');
});

test('dayStartHour is clamped to something sane', () => {
  const at = new Date(2026, 8, 19, 13, 0);
  assert.strictEqual(entry.todayId(at, 99), '2026-09-19');
  assert.strictEqual(entry.todayId(at, -5), '2026-09-19');
});

/* ---------------------------------------------------------------- filenames */

test('filenames and ids agree', () => {
  assert.strictEqual(entry.fileNameFor('2026-09-18'), '2026-09-18.md');
  assert.strictEqual(entry.idFromFileName('2026-09-18.md'), '2026-09-18');
  assert.strictEqual(entry.idFromFileName('2026-09-18.MD'), '2026-09-18');
});

test('anything that is not an entry file is ignored', () => {
  const rejected = [
    'README.md',
    '2026-09-18 (conflicted copy 2026-09-19 113000).md',   // what Nextcloud leaves behind
    '2026-09-18.md.tmp',
    '.2026-09-18.md.swp',
    '2026-09-18.txt',
    '2026-13-01.md'
  ];
  for (const name of rejected) assert.strictEqual(entry.idFromFileName(name), '', name);
});

/* ---------------------------------------------------------------- titles */

test('the long title matches the format the diary already uses', () => {
  assert.strictEqual(entry.formatTitle('2026-09-18', 'long'), 'Friday, 18 September 2026');
  assert.strictEqual(entry.formatTitle('2026-09-18', 'us'), 'Friday, September 18, 2026');
  assert.strictEqual(entry.formatTitle('2026-09-18', 'short'), 'Fri 18 Sep 2026');
  assert.strictEqual(entry.formatTitle('2026-09-18', 'iso'), '2026-09-18');
});

test('an unknown title style falls back to the default rather than throwing', () => {
  assert.strictEqual(entry.formatTitle('2026-09-18', 'nope'), 'Friday, 18 September 2026');
  assert.strictEqual(entry.formatTitle('2026-09-18'), 'Friday, 18 September 2026');
});

/* ---------------------------------------------------------------- parsing */

const SAMPLE = `# Friday, 18 September 2026

## How the day went

Walked the reservoir path after work. The water was flat enough to see the far
treeline in it.

## Notes

ring the parts place back
order the filter

## Tomorrow

swap show at the fairground
`;

test('parse splits an entry into its headings', () => {
  const parsed = entry.parse(SAMPLE, '2026-09-18');
  assert.strictEqual(parsed.id, '2026-09-18');
  assert.strictEqual(parsed.title, 'Friday, 18 September 2026');
  assert.strictEqual(parsed.preamble, '');
  assert.deepStrictEqual(parsed.sections.map(s => s.heading), ['How the day went', 'Notes', 'Tomorrow']);
  assert.match(parsed.sections[0].body, /^Walked the reservoir path/);
  assert.strictEqual(parsed.sections[2].body, 'swap show at the fairground');
});

test('stringify rebuilds the same file', () => {
  const parsed = entry.parse(SAMPLE, '2026-09-18');
  assert.strictEqual(entry.stringify(parsed, { titleStyle: 'long' }), SAMPLE);
});

test('the title is rewritten from the date, never trusted from the file', () => {
  const stale = entry.parse('# Some other heading entirely\n\n## Notes\n\nhi\n', '2026-09-18');
  const out = entry.stringify(stale, { titleStyle: 'long' });
  assert.match(out, /^# Friday, 18 September 2026\n/);
});

test('text above the first heading is kept as a preamble', () => {
  const parsed = entry.parse('# Friday, 18 September 2026\n\nwritten on the train\n\n## Notes\n\nhi\n', '2026-09-18');
  assert.strictEqual(parsed.preamble, 'written on the train');
  assert.deepStrictEqual(parsed.sections.map(s => s.heading), ['Notes']);
  assert.match(entry.stringify(parsed, {}), /2026\n\nwritten on the train\n\n## Notes/);
});

test('a file with no H1 at all still parses', () => {
  const parsed = entry.parse('## Notes\n\njust this\n', '2026-09-18');
  assert.strictEqual(parsed.title, '');
  assert.deepStrictEqual(parsed.sections.map(s => s.heading), ['Notes']);
});

test('an empty file parses to an entry with nothing in it', () => {
  for (const source of ['', '   \n\n', null, undefined]) {
    const parsed = entry.parse(source, '2026-09-18');
    assert.strictEqual(parsed.sections.length, 0);
    assert.strictEqual(entry.isBlank(parsed), true);
  }
});

test('a ## inside a fenced block is code, not a section break', () => {
  const source = [
    '# Friday, 18 September 2026', '',
    '## Notes', '',
    '```', '## not a heading', 'echo hi', '```', '',
    '## Tomorrow', '',
    'rest'
  ].join('\n');
  const parsed = entry.parse(source, '2026-09-18');
  assert.deepStrictEqual(parsed.sections.map(s => s.heading), ['Notes', 'Tomorrow']);
  assert.match(parsed.sections[0].body, /## not a heading/);
});

test('closing hashes on a heading are not part of its name', () => {
  const parsed = entry.parse('# Friday ##\n\n## Notes ##\n\nhi\n', '2026-09-18');
  assert.strictEqual(parsed.title, 'Friday');
  assert.strictEqual(parsed.sections[0].heading, 'Notes');
});

test('CRLF and a BOM survive parsing', () => {
  const parsed = entry.parse('﻿# Friday\r\n\r\n## Notes\r\n\r\nhi there\r\n', '2026-09-18');
  assert.deepStrictEqual(parsed.sections.map(s => s.heading), ['Notes']);
  assert.strictEqual(parsed.sections[0].body, 'hi there');
});

/* ---------------------------------------------------------------- writing out */

test('an empty entry is written as a bare scaffold with one trailing newline', () => {
  const out = entry.stringify(entry.scaffold('2026-09-18', ['How the day went', 'Notes', 'Tomorrow']), {});
  assert.strictEqual(out, '# Friday, 18 September 2026\n\n## How the day went\n\n## Notes\n\n## Tomorrow\n');
  assert.strictEqual(out.endsWith('\n'), true);
  assert.strictEqual(out.endsWith('\n\n'), false);
});

test('sections with no heading are dropped rather than written as stray text', () => {
  const out = entry.stringify({ id: '2026-09-18', sections: [{ heading: '', body: 'orphan' }, { heading: 'Notes', body: 'kept' }] }, {});
  assert.doesNotMatch(out, /orphan/);
  assert.match(out, /## Notes\n\nkept\n$/);
});

test('stringify survives being handed rubbish', () => {
  assert.strictEqual(entry.stringify(null, {}), '');
  assert.strictEqual(entry.stringify({}, {}), '');
  assert.strictEqual(entry.stringify({ id: 'nope', sections: 'not an array' }, {}), '');
});

/* ---------------------------------------------------------------- headings */

test('duplicate headings are dropped, because two sections cannot share a name', () => {
  assert.deepStrictEqual(entry.headingList(['Notes', 'notes', ' NOTES ', 'Tomorrow']), ['Notes', 'Tomorrow']);
  assert.deepStrictEqual(entry.headingList(['', '   ', null, 'Notes']), ['Notes']);
  assert.deepStrictEqual(entry.headingList('not an array'), []);
});

test('newlines cannot be smuggled into a heading', () => {
  assert.deepStrictEqual(entry.headingList(['Notes\n## Injected']), ['Notes ## Injected']);
});

test('ensureSections fills in an empty entry but never one you have written in', () => {
  const blank = entry.parse('# Friday\n\n## Notes\n', '2026-09-18');
  const filled = entry.ensureSections(blank, ['How the day went', 'Notes', 'Tomorrow']);
  assert.deepStrictEqual(filled.sections.map(s => s.heading), ['Notes', 'How the day went', 'Tomorrow']);

  const written = entry.parse('# Friday\n\n## Notes\n\nsomething\n', '2026-09-18');
  const untouched = entry.ensureSections(written, ['How the day went', 'Notes', 'Tomorrow']);
  assert.deepStrictEqual(untouched.sections.map(s => s.heading), ['Notes']);
});

test('scaffold falls back to the built-in headings when given none', () => {
  assert.deepStrictEqual(entry.scaffold('2026-09-18', []).sections.map(s => s.heading), entry.DEFAULT_HEADINGS);
  assert.deepStrictEqual(entry.scaffold('2026-09-18', null).sections.map(s => s.heading), entry.DEFAULT_HEADINGS);
});

/* ---------------------------------------------------------------- blank & counting */

test('isBlank looks at the bodies, not the headings', () => {
  assert.strictEqual(entry.isBlank(entry.scaffold('2026-09-18', ['A', 'B'])), true);
  assert.strictEqual(entry.isBlank(entry.parse(SAMPLE, '2026-09-18')), false);
  assert.strictEqual(entry.isBlank({ preamble: 'x', sections: [] }), false);
  assert.strictEqual(entry.isBlank({ sections: [{ heading: 'A', body: '   \n  ' }] }), true);
});

test('plainText strips Markdown so a search for a word finds it however it was styled', () => {
  const text = entry.plainText(entry.parse('# F\n\n## Notes\n\nsaw **Wren** and [the reservoir](http://x)\n', '2026-09-18'));
  assert.match(text, /saw Wren and the reservoir/);
  assert.doesNotMatch(text, /\*\*|http/);
});

test('wordCount counts words, not punctuation', () => {
  assert.strictEqual(entry.wordCount(entry.parse('# F\n\n## Notes\n\none two three.\n', '2026-09-18')), 4, 'the heading counts too');
  assert.strictEqual(entry.wordCount(entry.scaffold('2026-09-18', ['Notes'])), 1);
  assert.strictEqual(entry.wordCount(null), 0);
});

/* ---------------------------------------------------------------- tags */

test('a Tags line under the date is read as tags, not as prose', () => {
  const parsed = entry.parse('# Friday, 18 September 2026\n\nTags: Wren, camping\n\n## Notes\n\nhi\n', '2026-09-18');
  assert.deepStrictEqual(parsed.tags, ['Wren', 'camping']);
  assert.strictEqual(parsed.preamble, '', 'the line is consumed, not left in the body');
  assert.deepStrictEqual(parsed.sections.map(s => s.heading), ['Notes']);
});

test('tags round trip byte for byte', () => {
  const source = '# Friday, 18 September 2026\n\nTags: Wren, camping, car show\n\n## Notes\n\nhi\n';
  assert.strictEqual(entry.stringify(entry.parse(source, '2026-09-18'), { titleStyle: 'long' }), source);
});

test('tags and a preamble can both be there', () => {
  const source = '# Friday, 18 September 2026\n\nTags: camping\n\nscribbled on the train\n\n## Notes\n\nhi\n';
  const parsed = entry.parse(source, '2026-09-18');
  assert.deepStrictEqual(parsed.tags, ['camping']);
  assert.strictEqual(parsed.preamble, 'scribbled on the train');
  assert.strictEqual(entry.stringify(parsed, { titleStyle: 'long' }), source);
});

test('an entry with no tags gains no Tags line', () => {
  const source = '# Friday, 18 September 2026\n\n## Notes\n\nhi\n';
  const parsed = entry.parse(source, '2026-09-18');
  assert.deepStrictEqual(parsed.tags, []);
  assert.strictEqual(entry.stringify(parsed, { titleStyle: 'long' }), source);
  assert.doesNotMatch(entry.stringify(parsed, {}), /Tags:/);
});

test('"Tags:" written inside the body is prose, not metadata', () => {
  /* Otherwise a sentence in somebody's diary would silently vanish into the tag row. */
  const source = '# Friday, 18 September 2026\n\n## Notes\n\nTags: the ones on my bag are gone\n';
  const parsed = entry.parse(source, '2026-09-18');
  assert.deepStrictEqual(parsed.tags, []);
  assert.strictEqual(parsed.sections[0].body, 'Tags: the ones on my bag are gone');
  assert.strictEqual(entry.stringify(parsed, { titleStyle: 'long' }), source);
});

test('the Tags line is matched however it was capitalised or spaced', () => {
  for (const line of ['Tags: a, b', 'tags: a, b', 'TAGS:a, b', '  Tags :  a, b']) {
    const parsed = entry.parse(`# F\n\n${line}\n\n## Notes\n\nhi\n`, '2026-09-18');
    assert.deepStrictEqual(parsed.tags, ['a', 'b'], line);
  }
});

test('tagList cleans up what gets typed', () => {
  assert.deepStrictEqual(entry.tagList('  camping ,, #jonah ,Jonah , '), ['camping', 'jonah']);
  assert.deepStrictEqual(entry.tagList(['Jonah Pike', 'jonah pike']), ['Jonah Pike'], 'deduped, first spelling kept');
  assert.deepStrictEqual(entry.tagList('a\nb'), ['a b'], 'a newline cannot break the line in two');
  assert.deepStrictEqual(entry.tagList(null), []);
  assert.strictEqual(entry.tagList(Array.from({ length: 80 }, (unused, i) => `t${i}`)).length, 24, 'capped');
  assert.strictEqual(entry.tagList(['x'.repeat(500)])[0].length, 60, 'a single tag cannot run away');
});

test('a comma inside a tag is neutralised, so it cannot split on the way back in', () => {
  const out = entry.stringify({ id: '2026-09-18', tags: ['Smith, John'], sections: [] }, {});
  assert.match(out, /Tags: Smith John\n/);
  assert.deepStrictEqual(entry.parse(out, '2026-09-18').tags, ['Smith John']);
});

test('a day with tags and nothing written is still worth saving', () => {
  const tagged = { id: '2026-09-18', tags: ['camping'], preamble: '', sections: [{ heading: 'Notes', body: '' }] };
  assert.strictEqual(entry.isBlank(tagged), false);
  assert.strictEqual(entry.hasWriting(tagged), false);
  const bare = { id: '2026-09-18', tags: [], preamble: '', sections: [{ heading: 'Notes', body: '' }] };
  assert.strictEqual(entry.isBlank(bare), true);
});

test('a tagged but unwritten day still gets the default sections filled in', () => {
  const parsed = entry.parse('# F\n\nTags: camping\n\n## Notes\n', '2026-09-18');
  const filled = entry.ensureSections(parsed, ['How the day went', 'Notes', 'Tomorrow']);
  assert.deepStrictEqual(filled.sections.map(s => s.heading), ['Notes', 'How the day went', 'Tomorrow']);
});

test('search matches a tag; the word count ignores it', () => {
  const parsed = entry.parse('# F\n\nTags: Wren, camping\n\n## Notes\n\nquiet day\n', '2026-09-18');
  assert.match(entry.searchText(parsed), /Wren/);
  assert.match(entry.searchText(parsed), /quiet day/);
  assert.doesNotMatch(entry.plainText(parsed), /Wren/, 'tags are not part of the prose');
  assert.strictEqual(entry.wordCount(parsed), 3, 'Notes + quiet + day');
});

test('scaffold starts a day with no tags', () => {
  assert.deepStrictEqual(entry.scaffold('2026-09-18', ['Notes']).tags, []);
});

/* ---------------------------------------------------------------- search passages */

/* store.js is browser-side, so its two pure helpers are re-implemented here to pin the
   behaviour the results view depends on. The real ones are exercised in the app. */
test('a search shows the paragraphs that matched, not the whole day', () => {
  const body = [
    'Walked the reservoir path after work.',
    'Nothing much happened in the afternoon.',
    'Went back to the reservoir at dusk.'
  ].join('\n');
  const terms = ['reservoir'];
  const kept = body.split(/\n+/).map(p => p.trim()).filter(Boolean)
    .filter(p => terms.some(t => p.toLowerCase().includes(t)));
  assert.strictEqual(kept.length, 2);
  assert.doesNotMatch(kept.join(' '), /afternoon/, 'the paragraph with no match is left out');
});

test('every occurrence is counted, not just the first', () => {
  const haystack = 'the reservoir path, then the reservoir again, and the reservoir at dusk';
  let count = 0;
  let at = haystack.indexOf('reservoir');
  while (at !== -1) { count++; at = haystack.indexOf('reservoir', at + 'reservoir'.length); }
  assert.strictEqual(count, 3);
});
