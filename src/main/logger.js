'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function createLogger(directory) {
  let pending = Promise.resolve();
  const file = path.join(directory, 'application.log');
  function write(level, message) {
    pending = pending.then(async () => {
      try {
        await fs.mkdir(directory, { recursive: true });
        try {
          const stat = await fs.stat(file);
          if (stat.size > 2 * 1024 * 1024) {
            await fs.copyFile(file, path.join(directory, 'application.previous.log'));
            await fs.writeFile(file, '', 'utf8');
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await fs.appendFile(file, JSON.stringify({ time: new Date().toISOString(), level, message: String(message) }) + '\n', 'utf8');
      } catch (error) {
        console.error('Unable to write application log:', error.message);
      }
    });
    return pending;
  }
  return { info: message => write('info', message), error: message => write('error', message), flush: () => pending };
}

module.exports = { createLogger };
