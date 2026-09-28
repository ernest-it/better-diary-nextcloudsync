/* `npm run check` — runs node --check over every JavaScript file in the project, so a new
   src/ file is covered the moment it lands without anyone editing package.json. */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ROOTS = ['src', 'build', 'test', 'mobile'];
/* mobile/www is a build output and mobile/android is Gradle's; neither is ours to check. */
const SKIP = new Set(['node_modules', 'dist', '.git', 'www', 'android']);

function walk(dir, found = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const files = ROOTS.flatMap(name => walk(path.join(ROOT, name)));
if (!files.length) {
  console.error('check: no JavaScript files found');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const label = path.relative(ROOT, file).split(path.sep).join('/');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`ok    ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n${(error.stderr || error.stdout || '').toString().trim()}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} files parse cleanly`);
process.exit(failed ? 1 : 0);
