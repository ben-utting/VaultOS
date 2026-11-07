'use strict';
// Pure checks behind the first-run setup screen: is the vault a real mount, is
// it writable, what is in it, which setup stage applies, is the window open.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { SETTINGS_REL, validate } = require('./settings');

// A bind mount or volume lives on another device than the container's root.
function isMounted(dir, stat = fs.statSync) {
  return stat(dir).dev !== stat('/').dev;
}

// Writes and removes a probe file in the vault root, so nothing is created
// inside .vaultos/ before the user goes ahead. Throws if the folder is not writable.
async function defaultProbeWrite(vaultDir) {
  const probe = path.join(vaultDir, '.vaultos-write-test');
  await fsp.writeFile(probe, 'ok');
  await fsp.rm(probe, { force: true });
}

async function folderCheck(vaultDir, { stat, probeWrite = defaultProbeWrite } = {}) {
  let mounted = false;
  try { mounted = isMounted(vaultDir, stat); } catch { /* unreadable: treat as not mounted */ }

  let writable = true;
  try { await probeWrite(vaultDir); } catch { writable = false; }

  // A settings file that is missing or invalid does not make the folder "existing".
  try {
    const s = validate(JSON.parse(await fsp.readFile(path.join(vaultDir, SETTINGS_REL), 'utf8')));
    return { mounted, writable, state: 'existing', boardCount: s.boards.length };
  } catch { /* fall through */ }

  let names = [];
  try { names = await fsp.readdir(vaultDir); } catch { /* missing folder reads as empty */ }
  const state = names.some((n) => !n.startsWith('.')) ? 'has-files' : 'empty';
  return { mounted, writable, state, boardCount: 0 };
}

// settings is the validated settings or null when the file is missing.
// Migration of old vaults happens at boot, so there is no runtime "migrate" stage.
function setupStage({ hasPassword, settings, settingsError }) {
  if (settingsError) return 'broken';
  if (!hasPassword) return settings ? 'existing-folder' : 'full';
  if (!settings) return 'boards';
  return settings.setupDone ? 'done' : 'resume';
}

function stepsFor(stage, settings) {
  switch (stage) {
    case 'full': return [1, 2, 3, 4, 5];
    case 'existing-folder': return [1, 2, 4];
    case 'boards': return [3, 4, 5];
    case 'resume': return settings && settings.boards && settings.boards.length ? [4, 5] : [3, 4, 5];
    case 'broken': return [1];
    default: return [];
  }
}

function windowOpen(startedAt, now, minutes) {
  return now - startedAt < minutes * 60e3;
}

module.exports = { isMounted, folderCheck, setupStage, stepsFor, windowOpen };
