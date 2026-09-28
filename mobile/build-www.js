/* Assembles the Android app's web assets in mobile/www from the desktop app's own page.

   There is no fork of the UI: index.html and src/ are copied as they are, less the
   Electron-only files, and the phone's pieces are added in front of them — the bridge that
   stands in for src/preload.js, the sync that stands in for the Nextcloud client, and a
   stylesheet for a narrow touchscreen. Run by `npm run sync` / `npm run apk`. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'www');

/* Main-process and Node-only files: the phone never runs them. */
const DESKTOP_ONLY = new Set(['main.js', 'preload.js', 'menu.js', 'window-state.js', 'diary.js']);

function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip && skip(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target, null);
    else fs.copyFileSync(source, target);
  }
}

function replaceOnce(text, find, replacement, what) {
  if (!text.includes(find)) throw new Error(`build-www: could not find ${what} in index.html — has it changed?`);
  return text.replace(find, replacement);
}

fs.rmSync(OUT, { recursive: true, force: true });
copyDir(path.join(ROOT, 'src'), path.join(OUT, 'src'), name => DESKTOP_ONLY.has(name));
copyDir(path.join(__dirname, 'src'), path.join(OUT, 'mobile'), null);

/* One version for the whole project, as the Gradle build does. */
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const bridgeFile = path.join(OUT, 'mobile', 'bridge.js');
fs.writeFileSync(bridgeFile, fs.readFileSync(bridgeFile, 'utf8').replace("version: '0.0.0',", `version: '${version}',`));

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* Same policy as the desktop, less the Electron-only diary-asset: scheme. Photos are
   served from the app's own origin (https://localhost/_capacitor_file_/…), so 'self'
   covers them, and every request to Nextcloud goes through the native plugin, so the
   page itself still connects nowhere. */
html = html.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*" \/>/,
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; font-src \'self\'; img-src \'self\' data: blob:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'; object-src \'none\'" />');

html = replaceOnce(html,
  '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content" />',
  'the viewport tag');

html = replaceOnce(html,
  '<link rel="stylesheet" href="src/styles.css" />',
  '<link rel="stylesheet" href="src/styles.css" />\n    <link rel="stylesheet" href="mobile/mobile.css" />',
  'the stylesheet link');

/* The bridge must be in place before settings.js, store.js and renderer.js look for
   window.diaryApp, and after entry.js, which it uses. */
html = replaceOnce(html,
  '<script src="src/settings.js"></script>',
  ['mobile/dav.js', 'mobile/sync.js', 'mobile/setup.js', 'mobile/bridge.js', 'src/settings.js']
    .map(src => `<script src="${src}"></script>`).join('\n    '),
  'the settings.js script tag');

fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log(`www: built from index.html and src/ into ${path.relative(ROOT, OUT)}`);
