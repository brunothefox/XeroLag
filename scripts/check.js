'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function collect(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(file));
    else if (entry.isFile() && /\.(?:js|cjs)$/.test(entry.name)) files.push(file);
  }
  return files;
}

async function check() {
  const root = path.join(__dirname, '..');
  const files = [path.join(root, 'main.js'), path.join(root, 'preload.js')];
  for (const directory of ['src', 'scripts', 'tests', 'installer']) files.push(...await collect(path.join(root, directory)));
  for (const file of files) {
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', windowsHide: true }); }
    catch (error) { throw new Error(`Syntax check failed: ${file}\n${error.stderr?.toString() || error.message}`); }
  }
  console.log(`Syntax checks passed (${files.length} files).`);
}

check().catch(error => { console.error(error.message); process.exitCode = 1; });
