'use strict';
// Text recognition through the Windows built-in OCR engine (offline). One PowerShell worker stays
// alive and handles images one at a time, so after the first call each image takes a fraction of a second.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// PowerShell cannot read inside app.asar, so the script ships unpacked
const SCRIPT = path.join(__dirname, 'ocr.ps1').replace('app.asar', 'app.asar.unpacked');

let proc = null;
let buf = '';
let pending = [];
let idleTimer = null;

function start() {
  proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
    windowsHide: true,
  });
  let readySeen = false;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!readySeen && msg.ready) {
        readySeen = true;
        continue;
      }
      const job = pending.shift();
      if (!job) continue;
      if (msg.ok) job.resolve((msg.lines || []).map(String));
      else job.reject(new Error(msg.error || 'Text recognition failed'));
    }
  });
  proc.on('exit', () => {
    proc = null;
    buf = '';
    for (const j of pending.splice(0)) j.reject(new Error('Text recognition stopped'));
  });
  proc.on('error', () => {});
}

// lines of text in one image file
function ocrFile(file) {
  if (!proc) start();
  clearTimeout(idleTimer);
  // the worker holds ~60 MB; let it go after two quiet minutes
  idleTimer = setTimeout(() => proc && proc.kill(), 120000);
  return new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
    proc.stdin.write(path.resolve(file) + '\n');
  });
}

// Recognise text in a nativeImage. Small captures are enlarged (small UI text reads better at 2x),
// very tall ones (scrolling captures) are cut into slices the engine accepts.
async function ocrImage(img, nativeImageMod) {
  const { width, height } = img.getSize();
  const scale = Math.max(width, height) < 900 ? 2 : 1;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glimpse-ocr-'));
  const lines = [];
  try {
    const SLICE = 3000;
    for (let y = 0, k = 0; y < height; y += SLICE, k++) {
      let part = img.crop({ x: 0, y, width, height: Math.min(SLICE, height - y) });
      if (scale > 1) part = part.resize({ width: width * scale, quality: 'best' });
      const pw = part.getSize().width;
      if (pw > 9000) part = part.resize({ width: 9000, quality: 'best' });
      const f = path.join(tmp, `p${k}.png`);
      fs.writeFileSync(f, part.toPNG());
      lines.push(...(await ocrFile(f)));
    }
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
  return lines;
}

function stop() {
  if (proc) proc.kill();
}

module.exports = { ocrFile, ocrImage, stop };
