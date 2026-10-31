'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  saveDir: '',
  quickSave: false,
  openAfterUpload: false,
  uploadHost: 'catbox',
  launchAtLogin: false,
  showMagnifier: true,
  recordFps: 30,
  maxRecordSeconds: 60,
  gifFps: 15,
  gifMaxWidth: 0,
  hotkeys: {
    screenshot: 'PrintScreen',
    fullscreen: 'Ctrl+Alt+PrintScreen',
    gif: 'Ctrl+PrintScreen',
    video: 'Ctrl+Shift+PrintScreen',
  },
};

const userFile = (name) => path.join(app.getPath('userData'), name);

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadSettings() {
  const saved = readJSON(userFile('settings.json'), {});
  const s = { ...DEFAULTS, ...saved, hotkeys: { ...DEFAULTS.hotkeys, ...(saved.hotkeys || {}) } };
  if (!s.saveDir) s.saveDir = path.join(app.getPath('pictures'), 'Glimpse');
  return s;
}

function saveSettings(s) {
  writeJSON(userFile('settings.json'), s);
}

function capturesDir() {
  const dir = userFile('captures');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadHistory() {
  return readJSON(userFile('history.json'), []);
}

function saveHistory(list) {
  writeJSON(userFile('history.json'), list);
}

module.exports = { DEFAULTS, loadSettings, saveSettings, loadHistory, saveHistory, capturesDir };
