A daily diary that writes plain Markdown into your Nextcloud folder. One file per day, named
for the day, with the date and your headings already filled in.

### Install

| You're on | Download |
| --- | --- |
| **Windows** | `daily-diary-Setup-0.5.0.exe` — the installer. Or `daily-diary-0.5.0-portable.exe` to run it without installing. |
| **Debian / Ubuntu / Mint** | `daily-diary-0.5.0-linux-amd64.deb` — `sudo dpkg -i` it, or double-click. |
| **Fedora / openSUSE** | `daily-diary-0.5.0-linux-x86_64.rpm` |
| **Any other Linux** | `daily-diary-0.5.0-linux-x86_64.AppImage` — `chmod +x` it and run. |
| **Android** | `daily-diary-0.5.0-android.apk` — open it on the phone and allow installing from your browser or Files app when asked. Android 7 or newer. |

The desktop builds are not code-signed, so Windows SmartScreen will warn on first run — **More info ▸
Run anyway**.

### New in 0.5.0 — the diary on your phone

An Android app for the same diary, in the same folder. It logs in to your Nextcloud through
Nextcloud's own login page in your browser — it gets an app password of its own, never your
real one, and you can revoke it from Nextcloud's Settings ▸ Security — then you pick the
folder the desktop app writes to (it finds `Notes/Diary` by itself).

- **Works offline.** The phone keeps a copy of every entry; what you write uploads when
  Nextcloud is reachable — on opening the app, every minute while it is open, and as you
  leave it.
- **Nothing gets overwritten.** If a day changed on another device while the phone had its
  own unsent changes to it, both are kept and it asks which one wins — the same notice as
  the desktop.
- **Everything else is here too** — tags, photos (they download as you open their day),
  search, the calendar, light and dark.
- **https only.** Your login goes with every request, so plain-http servers are refused.

### Also new — read every mention of something

Search could already find a day. Now it can lay out all of them: <kbd>Shift</kbd>+<kbd>↵</kbd>
in the search box, or **Read every match**, fills the main panel with each entry that
matches — showing only the paragraphs the word appears in, with every occurrence highlighted
and counted. The same view clicking a tag gives you.

### Also in this release — photos

**Photo** in the toolbar, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>, paste one in, or
drag files onto the day you are writing. Click a photo and <kbd>Delete</kbd> removes it to
your system trash; double-click opens it full size.

Photos are copied in exactly as they are — full resolution, nothing re-encoded or stripped —
into a folder beside the day:

```
2026-09-20.md            ![the far treeline](2026-09-20-assets/photo-1.jpg)
2026-09-20-assets/photo-1.jpg
```

Deleting a day sends its photos to the trash with it.

Two caveats: **Nextcloud Notes will not show them on your phone** (it doesn't resolve
relative image paths — the files still sync and open in the Files app), and **iPhone HEIC
won't work** because Chromium can't decode it. JPEG, PNG, GIF, WebP, BMP and AVIF are fine.

### Also in this release — tags

Tag a day with the people, places and things in it. Chips under the date, or
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>; as you type it suggests tags already in your
diary, so the same person gets the same tag rather than three spellings of it.

Tags show at the end of each row in Recent entries, and the sidebar grows a **Tags** list
with counts. Click one and the main panel fills with every day carrying it, newest first —
click an entry to open it, or Escape to go back to what you were writing. Search matches
tags too.

On disk it is one optional line under the date, so it stays readable in Nextcloud Notes and
is one `grep` away:

```markdown
# Friday, 18 September 2026

Tags: Jonah Pike, camping
```

Entries you have already written are untouched until you tag them.

### What it does

- **Opens on today.** The date, your headings, cursor in the first section. A day you only
  look at and don't write in creates no file.
- **Syncs through Nextcloud.** Point it at a folder your client syncs — it finds
  `~/Nextcloud/Notes/Diary` by itself. The files are the plain Markdown Nextcloud Notes
  already renders, so the same diary reads properly on your phone.
- **Doesn't overwrite you.** If a day changes on another device while you're mid-sentence,
  both versions are kept and nothing is written until you pick one.
- **Getting back to a day** — a calendar marking every day you wrote on, recent entries, "on
  this day" in earlier years, and <kbd>Ctrl</kbd>+<kbd>K</kbd> across everything you've
  written.
- **Your headings.** Defaults to *How the day went* / *Notes* / *Tomorrow*; change them in
  Settings and new entries follow. Entries you've already written keep theirs.
- **Offline.** No network requests, no account, fonts bundled.

### First run

It will pick `~/Nextcloud/Notes/Diary` if your Nextcloud folder is there. Otherwise, or to
move it, use Settings ▸ **Diary folder** ▸ Change…
