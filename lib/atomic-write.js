'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');

async function atomicWrite(full, text) {
  const tmp = path.join(path.dirname(full), `.${path.basename(full)}.tmp-${process.pid}`);
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, full);
}

module.exports = { atomicWrite };
