'use strict';

const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { version, build } = require('../package.json');

async function writeChecksum() {
  try {
    const filename = `${build.productName}-Setup-${version}-x64.exe`;
    const root = path.resolve(__dirname, '..');
    const source = path.resolve(root, build.directories.output, filename);
    const releaseDirectory = path.join(root, 'dist');
    const installer = path.join(releaseDirectory, filename);
    if (!source.startsWith(root + path.sep)) throw new Error('Package output must stay inside the project.');
    await fs.mkdir(releaseDirectory, { recursive: true });
    if (source !== installer) {
      const temporary = installer + '.tmp';
      await fs.copyFile(source, temporary);
      await fs.rename(temporary, installer);
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(installer)) hash.update(chunk);
    await fs.writeFile(`${installer}.sha256`, `${hash.digest('hex')} *${filename}\n`, 'utf8');
    console.log(`SHA-256 checksum written: ${filename}.sha256`);
  } catch (error) {
    console.error(`Unable to create release checksum: ${error.message}`);
    process.exitCode = 1;
  }
}

void writeChecksum();
