/* `node gradle.js <task>…` — runs the Android project's Gradle wrapper on any OS. Through sh
   rather than ./gradlew, so it works even when a Windows checkout lost the executable bit. */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const dir = path.join(__dirname, 'android');
const args = process.argv.slice(2);
const result = process.platform === 'win32'
  ? spawnSync(`"${path.join(dir, 'gradlew.bat')}"`, args, { cwd: dir, stdio: 'inherit', shell: true })
  : spawnSync('sh', ['gradlew', ...args], { cwd: dir, stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
