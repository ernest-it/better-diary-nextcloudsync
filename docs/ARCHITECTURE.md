# Architecture

Three rules hold the whole thing together:

1. **The folder is the truth.** Nothing the app knows is stored anywhere but the `.md` files
   themselves. Delete the app and you have lost the app, not the diary.
2. **The renderer never touches the filesystem.** It is sandboxed, `contextIsolation` is on,
   and the only surface it sees is `window.diaryApp` from `src/preload.js`.
3. **Nothing is written that the person did not ask for.** Not an empty entry for a day they
   merely looked at, not one version of a day over another while they are still choosing.

## The layers

```
  src/entry.js     the file format          pure: no fs, no Electron, no DOM
       │                                    shared by main, renderer and the tests
       ├──────────────┬───────────────────────────────┐
       ▼              ▼                               ▼
  src/diary.js   src/main.js  ──ipc──▶ src/preload.js ──▶ src/store.js
  the only fs    window, settings,      window.diaryApp    the renderer's
  access         watcher + poll         and nothing else   cache of the folder
                                                              │
                                                              ▼
                                                        src/renderer.js
                                                        src/ui/*, styles.css
```

`entry.js` is deliberately the only module all three environments share. A date, a parse, and
a write-out mean exactly one thing everywhere, and the tests exercise the same code the app
runs rather than a copy of it.

## The file format

One file per day, named for the day:

```
<diary>/2026-09-18.md
```

- The **filename is the identity** of an entry. `entry.js` will not read or write a path it
  did not build from a valid `YYYY-MM-DD`, so a bad date cannot reach the disk.
- The `#` heading is **rewritten from the filename on every save**, never trusted from the
  file. Changing how dates are written is a setting, not a migration.
- `##` headings are the sections. Whatever a file already has is what it keeps.
- Text above the first `##` is kept as a preamble and written back where it was, so a file
  typed somewhere else keeps its shape.
- A `Tags:` line may sit directly under the date, and **only** there. A line starting
  `Tags:` anywhere further down is a sentence somebody wrote and is left in the body where
  they put it. Tags are comma-separated, so a tag can be a person's actual name rather than
  a hyphenated approximation of one.
- There is **no frontmatter**, because Nextcloud Notes renders these files too and would show
  it as literal text at the top of the note. One plain `Tags:` line reads as an ordinary
  sentence there instead.
- Photos live in `<date>-assets/` beside the entry and are referenced by a plain relative
  path. They are copied byte for byte — no re-encoding, no stripping.
- Anything not named `YYYY-MM-DD.md` is ignored and never written to — `README.md`, editor
  swap files, and Nextcloud's `(conflicted copy)` files all stay out of the way.

## Markdown, and one deliberate difference

`src/markdown.js` was adapted from an editor-only converter. It has one deliberate divergence, in the
paragraph builder: Markdown has **two** line endings inside a paragraph and they mean
different things.

| In the file | Means | Becomes |
| --- | --- | --- |
| `a` ␣␣`\n` `b` | a hard break | `<p>a<br>b</p>` |
| `a` `\n` `b` | a soft wrap | `<p>a b</p>` |

That converter only ever round trips through its own editor, so it treats every newline as a
`<br>`. This app reads files typed on a phone and wrapped by other editors, where doing that
would turn a merely-wrapped paragraph into one riddled with forced breaks the first time you
opened and saved it. `test/roundtrip.test.js` pins both directions.

## Writing

`diary.js` writes to a temp file, `fsync`s it, and renames it over the target, so a crash
mid-save cannot leave half a day on disk. Writes to the same file are serialised through a
per-path queue, so two autosaves cannot land out of order. Deletes go to the system trash.

Every path the app writes is remembered for a few seconds (`wasSelfWrite`) so the watcher does
not mistake the app's own autosave for an edit arriving from another device.

An entry whose sections are all empty is **not created**. Browsing forward through days you
have not written yet leaves nothing behind for the sync client to carry around. Emptying a day
that already had a file keeps the file — deleting is an explicit choice.

## Showing a photo

The page is loaded from `file://` inside the app, so a path relative to an *entry* — which
lives somewhere else entirely — is not something it can fetch. Inlining the bytes as a
`data:` URI is the usual shortcut, and it makes the files enormous; with
full-resolution originals it would be unusable.

Instead `main.js` registers a `diary-asset:` scheme and serves from it:

```
diary-asset://entry/2026-09-20/photo-1.jpg  ->  <diary>/2026-09-20-assets/photo-1.jpg
```

`diary.js` does the path checking, so nothing outside a day's own folder is reachable and
only image types Chromium can decode are served. The file on disk never contains that URL:
`toEditor({ onImage })` maps the relative path to it on the way in, and
`fromEditor({ onImage })` maps it back on the way out. `test/roundtrip.test.js` pins that,
because a leaked `diary-asset://` in an entry would be a diary that only this app can read.

## Noticing changes from other devices

Two mechanisms, because one is not enough:

- `fs.watch` on the folder — fast, but unreliable on network and synced folders.
- A 15-second poll of every entry's `mtime` and size, plus one on window focus. This is what
  actually delivers "the entry I wrote on my phone appears on my laptop".

Either one sends `diary:changed` to the page. `store.refresh()` then compares mtime and size
against its cache and re-reads only the days that really changed, so a folder with years in it
stays cheap.

## When the same day changed in two places

`renderer.js` keeps `diskText` — the exact bytes it last saw for the open day.

| State | What happens |
| --- | --- |
| On-disk text equals `diskText` | Nothing. This is the usual case. |
| It differs and the buffer is clean | Reload silently, and say so in a toast. |
| It differs and the buffer is dirty | Keep both. Show the notice. **Stop writing.** |

While a conflict is unresolved, `saveNow()` returns without writing and the status reads
"Not saved yet"; autosave is not even scheduled; and navigating to another day is refused with
a nudge back to the two buttons. Answering with **Keep mine** takes the arrived copy as the
new `diskText` and saves over it; **Load theirs** renders the arrived copy and drops the local
one.

The single exception is `saveNow({ force: true })`, used only when the app is closing: there,
losing what was just typed is the worse outcome, and the other version is still on the device
that wrote it and in Nextcloud's file history.

## Closing

Closing the window destroys the page — and whatever is still sitting in its autosave timer —
before `before-quit` ever runs. So `main.js` intercepts `win.on('close')`, holds it open,
sends `diary:flush` to the page, waits for `diary:flushed` (or 2s), drains the write queue,
and only then closes for real. `SIGTERM`/`SIGINT`/`SIGHUP` route into the same path so a
graceful logout does not cost you the last sentence.

## The results view

One view in the main panel, reached two ways: clicking a tag, or asking search to show
everything rather than jumping to a day. Both are "here is a set of entries, read them",
which the sidebar is far too narrow for, so they share `paintResults()`.

Searching matches against the whole index, tags included, so a day tagged with the word
turns up even when the word is nowhere in the prose. The count and the highlights are then
both computed from the *prose alone*, so the number on screen always equals the number of
marks under it — an entry that matched only on its tag says so rather than claiming matches
you cannot see. Getting that wrong is easy: the first cut counted against the index and
showed "3 matches" above two highlights.

`bodyOf()` keeps paragraph breaks and `bodyTextOf()` collapses them for the one-line
previews. The results view needs the former — with the collapsed version everything is one
paragraph and only the first matching passage is ever shown.

## Settings

The main process owns `settings.json` in `userData` and sanitises every field on the way in,
so a hand-edited or truncated file cannot stop the app starting. The renderer mirrors a copy
into `localStorage` purely so the first paint can pick up the theme synchronously instead of
flashing a white window.

Tags are entry content, not a setting: the list in the sidebar is derived by counting what
is actually on the entries, so there is no separate registry to fall out of step with the
files. Renaming a tag is therefore not yet a thing you can do in one action — you retag the
entries, or `sed` the folder.

`headings` is the one setting that touches content, and only for **new** entries —
`entry.ensureSections()` refuses to add a section to an entry that has anything written in it.

## Tests

`npm test` runs `node --test` over `test/`:

- `entry.test.js` — dates, filenames, parsing, writing out, headings
- `roundtrip.test.js` — disk → editor → disk, which is what happens every time you type
- `diary.test.js` — the filesystem layer against a real temporary folder
- `reminder.test.js` — when the bedtime reminder is due, and which diary day it is about

`npm run check` runs `node --check` over every `.js` file in `src/`, `build/` and `test/`, so
a new file is covered the moment it lands.
