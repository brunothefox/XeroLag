'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { ProfileError } = require('./profile-state');

function within(root, file, allowRoot = false) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return (allowRoot || relative !== '') && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function verifyPath(root, file, expected) {
  if (!within(root, file)) throw new ProfileError('The selected path is outside the approved folder.', 'UNSAFE_PATH');
  let current = root;
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new ProfileError('Linked scan roots cannot be modified.', 'UNSAFE_PATH');
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new ProfileError('Linked files and folders are excluded.', 'UNSAFE_PATH');
  }
  const actual = await fs.lstat(file);
  const canonical = await fs.realpath(file);
  const canonicalRoot = await fs.realpath(root);
  if (!within(canonicalRoot, canonical) || expected && (actual.ino !== expected.ino || actual.dev !== expected.dev || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs)) {
    throw new ProfileError('This item changed after the scan. Scan again.', 'CHANGED_FILE');
  }
  return actual;
}

async function walk(root, context, visit, max = 150_000) {
  let count = 0;
  let skipped = 0;
  const stack = [root];
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new ProfileError('Choose a regular folder, not a link.', 'UNSAFE_PATH');
  while (stack.length) {
    context.check();
    const directory = stack.pop();
    let names;
    try { names = await fs.readdir(directory, { withFileTypes: true }); } catch { skipped++; continue; }
    if (names.length === 0 && directory !== root) await visit(directory, await fs.lstat(directory), true);
    for (const entry of names) {
      context.check();
      if (++count > max) { context.log('Scan limit reached. Choose a smaller folder to inspect the remaining files.'); return { count, skipped, limited: true }; }
      const file = path.join(directory, entry.name);
      try {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) { skipped++; continue; }
        if (stat.isDirectory()) {
          if (['$recycle.bin','system volume information','.git'].includes(entry.name.toLowerCase())) { skipped++; continue; }
          stack.push(file);
        } else if (stat.isFile()) await visit(file, stat, false);
      } catch (error) { if (error.code === 'CANCELLED') throw error; skipped++; }
      if (count % 200 === 0) { context.update({ visited: count, skipped }); await new Promise(resolve => setImmediate(resolve)); }
    }
  }
  return { count, skipped, limited: false };
}

function createFileFinder({ jobs, chooseFolder, trash, confirm }) {
  const roots = new Map();
  const scans = new Map();
  async function choose() {
    const selected = await chooseFolder();
    if (!selected) return null;
    const stat = await fs.lstat(selected);
    if (stat.isSymbolicLink()) throw new ProfileError('Choose a folder directly rather than a junction.', 'UNSAFE_PATH');
    const root = await fs.realpath(selected);
    const id = randomUUID();
    roots.set(id, root);
    return { id, path: root };
  }
  function scan(rootId, mode) {
    const root = roots.get(rootId);
    if (!root || !['large','duplicates','empty'].includes(mode)) throw new ProfileError('Choose a folder and scan mode.', 'INVALID_SCAN');
    return jobs.start('Find ' + mode, async context => {
      const id = randomUUID();
      const items = [];
      const candidates = new Map();
      const result = await walk(root, context, async (file, stat, empty) => {
        if (mode === 'empty' && empty || mode === 'large' && !empty && stat.isFile() && stat.size >= 100 * 1024 * 1024) {
          items.push({ id: randomUUID(), file, size: stat.size, stamp: { ino: stat.ino, dev: stat.dev, size: stat.size, mtimeMs: stat.mtimeMs }, directory: empty });
        }
        if (mode === 'duplicates' && !empty && stat.isFile() && stat.size >= 1024) {
          if (!candidates.has(stat.size)) candidates.set(stat.size, []);
          candidates.get(stat.size).push({ file, stat });
        }
      });
      if (mode === 'duplicates') {
        for (const entries of candidates.values()) {
          if (entries.length < 2) continue;
          const hashes = new Map();
          for (const { file, stat } of entries) {
            context.check();
            let handle;
            try {
              await verifyPath(root, file, stat);
              handle = await fs.open(file, 'r');
              const hash = createHash('sha256');
              for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) { context.check(); hash.update(chunk); }
              const current = await handle.stat();
              if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) continue;
              const digest = hash.digest('hex');
              if (!hashes.has(digest)) hashes.set(digest, []);
              hashes.get(digest).push({ id: randomUUID(), file, size: stat.size, stamp: { ino: stat.ino, dev: stat.dev, size: stat.size, mtimeMs: stat.mtimeMs }, group: digest });
            } catch (error) { if (error.code === 'CANCELLED') throw error; context.log('Skipped unreadable file: ' + file); }
            finally { if (handle) await handle.close().catch(() => {}); }
          }
          for (const group of hashes.values()) if (group.length > 1) items.push(...group);
        }
      }
      items.sort((a,b) => b.size - a.size || a.file.localeCompare(b.file));
      if (scans.size >= 6) scans.delete(scans.keys().next().value);
      scans.set(id, { root, mode, items, createdAt: Date.now() });
      return { scanId: id, mode, ...result, total: items.length, items: items.slice(0, 2000).map(({ stamp, file, ...item }) => ({ ...item, path: file })) };
    });
  }
  async function remove(scanId, ids) {
    const scan = scans.get(scanId);
    if (!scan || Date.now() - scan.createdAt > 30 * 60_000 || !Array.isArray(ids) || !ids.length || ids.length > 2000 || new Set(ids).size !== ids.length) throw new ProfileError('The scan expired or the selection is invalid. Scan again.', 'INVALID_SCAN');
    const items = ids.map(id => scan.items.find(item => item.id === id));
    if (items.some(item => !item)) throw new ProfileError('An item is not part of this scan.', 'INVALID_SCAN');
    const protectedRoots = [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    if (items.some(item => protectedRoots.some(root => within(root, item.file, true)))) throw new ProfileError('Windows and installed-application folders are read-only in the file finder.', 'PROTECTED_LOCATION');
    if (scan.mode === 'duplicates') {
      for (const group of new Set(items.map(item => item.group))) {
        const keepers=scan.items.filter(item=>item.group===group&&!ids.includes(item.id));
        let available=false;
        for(const keeper of keepers){try{await verifyPath(scan.root,keeper.file,keeper.stamp);available=true;break;}catch{}}
        if(!available)throw new ProfileError('Keep an unchanged copy of each duplicate group. A kept file may have moved; scan again.','KEEP_ORIGINAL');
      }
    }
    if (!await confirm(scan.mode === 'empty' ? 'Remove ' + items.length + ' empty folders?' : 'Move ' + items.length + ' selected files to the Recycle Bin?')) return { cancelled: true };
    return jobs.start('Remove selected items', async context => {
      let removed = 0;
      const skipped = [];
      for (const item of items) {
        context.check();
        try {
          await verifyPath(scan.root, item.file, item.stamp);
          if(scan.mode==='duplicates'){
            let kept=false;
            for(const keeper of scan.items.filter(candidate=>candidate.group===item.group&&!ids.includes(candidate.id))){try{await verifyPath(scan.root,keeper.file,keeper.stamp);kept=true;break;}catch{}}
            if(!kept)throw new ProfileError('The kept duplicate is no longer available.','KEEP_ORIGINAL');
          }
          if (item.directory) { if ((await fs.readdir(item.file)).length) throw new Error('Folder is no longer empty.'); await fs.rmdir(item.file); }
          else await trash(item.file);
          removed++;
          scan.items = scan.items.filter(existing => existing.id !== item.id);
        } catch (error) { skipped.push({ path: item.file, error: error.message }); }
      }
      return { removed, skipped };
    }, 'files');
  }
  return { choose, scan, remove };
}

module.exports = { within, verifyPath, walk, createFileFinder };
