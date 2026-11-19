'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { runPowerShell } = require('../src/main/command-runner');
const { powerShellLiteral } = require('../src/main/elevation');

async function prepareIcon() {
  try {
    const root = path.join(__dirname, '..');
    const source = path.join(root, 'assets', 'branding', 'iconLOGO.ico');
    const original = await fs.readFile(source);
    if (original.length < 22 || original.readUInt16LE(2) !== 1) throw new Error('iconLOGO.ico is not a valid icon.');
    const count = original.readUInt16LE(4);
    if (count < 1 || original.length < 6 + count * 16) throw new Error('Icon directory is incomplete.');
    const frames = [];
    for (let index = 0; index < count; index++) {
      const entry = original.subarray(6 + index * 16, 22 + index * 16);
      const start = entry.readUInt32LE(12);
      const size = entry.readUInt32LE(8);
      if (start + size > original.length) throw new Error('Icon frame is incomplete.');
      frames.push({ entry: Buffer.from(entry), image: original.subarray(start, start + size) });
    }
    const hasLargeFrame = frames.some(frame => frame.entry[0] === 0 && frame.entry[1] === 0);
    if (!hasLargeFrame) {
      // Keep the supplied artwork and original frames; add the size required by NSIS.
      const { stdout } = await runPowerShell([
        'Add-Type -AssemblyName System.Drawing',
        '$icon = $null; $bitmap = $null; $canvas = $null; $graphics = $null; $stream = $null',
        'try {',
        `$icon = New-Object System.Drawing.Icon(${powerShellLiteral(source)})`,
        '$bitmap = $icon.ToBitmap()',
        '$canvas = New-Object System.Drawing.Bitmap(256, 256)',
        '$graphics = [System.Drawing.Graphics]::FromImage($canvas)',
        '$graphics.Clear([System.Drawing.Color]::Transparent)',
        '$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
        '$graphics.DrawImage($bitmap, 0, 0, 256, 256)',
        '$stream = New-Object System.IO.MemoryStream',
        '$canvas.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)',
        '[Console]::Write([Convert]::ToBase64String($stream.ToArray()))',
        '} finally {',
        'foreach ($resource in @($graphics, $canvas, $bitmap, $icon, $stream)) { if ($null -ne $resource) { $resource.Dispose() } }',
        '}'
      ].join('\n'));
      const png = Buffer.from(stdout.trim(), 'base64');
      if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('Icon conversion did not return a PNG frame.');
      const entry = Buffer.alloc(16);
      entry.writeUInt16LE(1, 4);
      entry.writeUInt16LE(32, 6);
      frames.push({ entry, image: png });
    }
    const header = Buffer.alloc(6);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(frames.length, 4);
    let offset = 6 + frames.length * 16;
    for (const frame of frames) {
      frame.entry.writeUInt32LE(frame.image.length, 8);
      frame.entry.writeUInt32LE(offset, 12);
      offset += frame.image.length;
    }
    const generated = path.join(root, 'assets', 'generated');
    await fs.mkdir(generated, { recursive: true });
    await fs.writeFile(path.join(generated, 'icon.ico'), Buffer.concat([header, ...frames.map(frame => frame.entry), ...frames.map(frame => frame.image)]));
    console.log('Application icon prepared from iconLOGO.ico.');
  } catch (error) {
    console.error(`Unable to prepare icon: ${error.message}`);
    if (error.stderr) console.error(error.stderr);
    process.exitCode = 1;
  }
}

void prepareIcon();
