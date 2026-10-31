'use strict';
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, screen, desktopCapturer,
  ipcMain, clipboard, nativeImage, dialog, shell, session, ClipboardItem,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const store = require('./store');
const { upload } = require('./upload');
const ff = require('./ffmpeg');
const { iconPNG } = require('./icon');

// --review renders the screens offscreen for design checks; it must not pop anything on the desktop.
const REVIEW = process.argv.includes('--review');
// --docs renders the README screenshots from a sample page and demo history
const DOCS = process.argv.includes('--docs');
// test modes stay quiet: no toasts, no global hotkeys (the user's own Glimpse owns them)
const QUIET = REVIEW || DOCS || process.argv.includes('--speedtest');
if (process.argv.includes('--selftest') || process.argv.includes('--speedtest') || REVIEW) {
  app.setPath('userData', path.join(app.getPath('temp'), 'glimpse-selftest'));
}
if (DOCS) {
  const ud = path.join(app.getPath('temp'), 'glimpse-docs');
  fs.rmSync(ud, { recursive: true, force: true });
  app.setPath('userData', ud);
  require('./docs').seed(ud);
}

// Fast native screen grab (~40 ms). Falls back to Electron's desktopCapturer if unavailable.
let shots = null;
try {
  shots = require('node-screenshots');
} catch {}

// Turns off the Windows open/close zoom-fade animation on our popup windows.
let dwmSetAttr = null;
try {
  const koffi = require('koffi');
  dwmSetAttr = koffi
    .load('dwmapi.dll')
    .func('long __stdcall DwmSetWindowAttribute(intptr_t hwnd, uint32_t attr, _In_ int32_t *value, uint32_t size)');
} catch {}

const noAnimResults = [];
function noAnim(win) {
  if (!dwmSetAttr) return;
  try {
    const h = win.getNativeWindowHandle();
    const hwnd = h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0);
    noAnimResults.push(dwmSetAttr(hwnd, 3 /* DWMWA_TRANSITIONS_FORCEDISABLED */, [1], 4));
  } catch (e) {
    noAnimResults.push(String(e.message));
  }
}

const UI = (f) => path.join(__dirname, 'ui', f);
const PRELOAD = path.join(__dirname, 'preload.js');
const webPrefs = (extra = {}) => ({ preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let settings;
let tray;
let appIcon;
let trayIcon;
let trayIconRec;
let history = [];

const overlays = new Map(); // webContents.id -> { win, display, ready }
let captureBusy = false;
let rec = null; // active recording
let toastWin = null;
let toastTimer = null;
let toastAction = null;
let settingsWin = null;
let historyWin = null;
let dashWin = null;
let pendingDisplaySource = null;

// ---------- helpers ----------

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const tempDir = () => {
  const d = path.join(app.getPath('temp'), 'glimpse');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

function ensureSaveDir() {
  try {
    fs.mkdirSync(settings.saveDir, { recursive: true });
  } catch {}
  return settings.saveDir;
}

// Electron 45 replaced clipboard.writeImage with the async W3C-style clipboard.write().
async function copyPNGToClipboard(png) {
  if (typeof clipboard.write === 'function' && typeof ClipboardItem === 'function') {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  } else {
    clipboard.writeImage(nativeImage.createFromBuffer(png));
  }
}

function copyTextToClipboard(text) {
  return Promise.resolve(clipboard.writeText(text)).catch(() => {});
}

function copyFileToClipboard(file) {
  return new Promise((resolve, reject) => {
    const lit = file.replace(/'/g, "''");
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -LiteralPath '${lit}'`],
      { windowsHide: true },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

// ---------- toast ----------

function toast(title, sub = '', opts = {}) {
  if (QUIET) return;
  const { kind = 'info', sticky = false, action = null } = opts;
  toastAction = action;
  const W = 400, H = 82;
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = disp.workArea;
  const bounds = { x: wa.x + wa.width - W - 12, y: wa.y + wa.height - H - 12, width: W, height: H };
  const actionLabel = !action ? '' : action.url ? 'Open link' : action.file ? 'Show file' : action.openDashboard ? 'Open Glimpse' : 'Open settings';
  const payload = { title, sub, kind, clickable: !!action, actionLabel };
  if (!toastWin || toastWin.isDestroyed()) {
    toastWin = new BrowserWindow({
      ...bounds, frame: false, transparent: true, resizable: false, skipTaskbar: true,
      alwaysOnTop: true, focusable: false, show: false, hasShadow: false, type: 'toolbar', webPreferences: webPrefs(),
    });
    toastWin.setAlwaysOnTop(true, "screen-saver");
    noAnim(toastWin);
    toastWin.loadFile(UI('toast.html'));
    toastWin.webContents.once('did-finish-load', () => {
      if (!toastWin || toastWin.isDestroyed()) return;
      toastWin.webContents.send('toast:show', payload);
      toastWin.showInactive();
    });
  } else {
    toastWin.setBounds(bounds);
    toastWin.webContents.send('toast:show', payload);
    toastWin.showInactive();
  }
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(hideToast, kind === 'error' ? 7000 : 4500);
}

function hideToast() {
  clearTimeout(toastTimer);
  if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
}

ipcMain.on('toast:click', () => {
  const a = toastAction;
  hideToast();
  if (!a) return;
  if (a.url) shell.openExternal(a.url);
  else if (a.file) shell.showItemInFolder(a.file);
  else if (a.settingsUri) shell.openExternal(a.settingsUri);
  else if (a.openSettings) openSettings();
  else if (a.openDashboard) openDashboard();
});
ipcMain.on('toast:hover', (_e, hovering) => {
  clearTimeout(toastTimer);
  if (!hovering) toastTimer = setTimeout(hideToast, 2500);
});

// ---------- history ----------

function notifyHistory() {
  for (const w of [historyWin, dashWin]) if (w && !w.isDestroyed()) w.webContents.send('history:changed');
}

function addHistory({ type, buf, srcFile, ext, w, h, savedPath = null }) {
  const id = newId();
  const file = path.join(store.capturesDir(), `${id}.${ext}`);
  if (buf) fs.writeFileSync(file, buf);
  else fs.copyFileSync(srcFile, file);
  const entry = { id, type, ext, file, w, h, size: fs.statSync(file).size, date: Date.now(), url: null, savedPath };
  history.unshift(entry);
  // keep the newest 300
  for (const old of history.splice(300)) fs.rm(old.file, { force: true }, () => {});
  store.saveHistory(history);
  notifyHistory();
  return entry;
}

function updateHistory(id, patch) {
  const e = history.find((x) => x.id === id);
  if (e) Object.assign(e, patch);
  store.saveHistory(history);
  notifyHistory();
  return e;
}

// ---------- shared actions ----------

const FILTERS = {
  png: [{ name: 'PNG image', extensions: ['png'] }, { name: 'JPEG image', extensions: ['jpg'] }],
  gif: [{ name: 'GIF animation', extensions: ['gif'] }],
  mp4: [{ name: 'MP4 video', extensions: ['mp4'] }],
  webm: [{ name: 'WebM video', extensions: ['webm'] }],
};

async function saveEntry(entry, parent) {
  const dir = ensureSaveDir();
  const name = `Glimpse ${stamp()}.${entry.ext}`;
  let dest = path.join(dir, name);
  if (!settings.quickSave) {
    const res = await dialog.showSaveDialog(parent && !parent.isDestroyed() ? parent : undefined, {
      title: 'Save capture',
      defaultPath: dest,
      filters: FILTERS[entry.ext] || [],
    });
    if (res.canceled || !res.filePath) return null;
    dest = res.filePath;
  }
  if (/\.jpe?g$/i.test(dest) && entry.ext === 'png') {
    fs.writeFileSync(dest, nativeImage.createFromPath(entry.file).toJPEG(92));
  } else {
    fs.copyFileSync(entry.file, dest);
  }
  updateHistory(entry.id, { savedPath: dest });
  toast('Saved', dest, { kind: 'success', action: { file: dest } });
  return dest;
}

async function uploadEntry(entry, { quiet = false } = {}) {
  if (entry.url) {
    copyTextToClipboard(entry.url);
    if (!quiet) toast('Link copied', entry.url, { kind: 'success', action: { url: entry.url } });
    return entry.url;
  }
  toast('Uploading…', `${(entry.size / 1024 / 1024).toFixed(2)} MB`, { sticky: true });
  try {
    const url = await upload(entry.file, settings.uploadHost);
    updateHistory(entry.id, { url });
    await copyTextToClipboard(url);
    if (!quiet) {
      toast('Link copied', url, { kind: 'success', action: { url } });
      if (settings.openAfterUpload) shell.openExternal(url);
    } else {
      hideToast();
    }
    return url;
  } catch (err) {
    toast('Upload failed', err.message, { kind: 'error' });
    return null;
  }
}

async function copyEntry(entry) {
  if (entry.type === 'image') {
    try {
      await copyPNGToClipboard(fs.readFileSync(entry.file));
      toast('Copied', `${entry.w} × ${entry.h} image, ready to paste`, { kind: 'success' });
    } catch (err) {
      toast('Copy failed', err.message, { kind: 'error' });
    }
  } else {
    try {
      await copyFileToClipboard(entry.file);
      toast('Copied', `${entry.ext.toUpperCase()} file, paste it into a chat or folder`, { kind: 'success' });
    } catch (err) {
      toast('Copy failed', err.message, { kind: 'error' });
    }
  }
}

function printFile(file) {
  const html = path.join(tempDir(), `print-${newId()}.html`);
  fs.writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8"><style>@page{margin:10mm}html,body{margin:0;height:100%}
    body{display:flex;align-items:center;justify-content:center}img{max-width:100%;max-height:100vh;object-fit:contain}</style>
    <img src="${pathToFileURL(file).href}">`
  );
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  w.loadFile(html);
  w.webContents.once('did-finish-load', () => {
    w.webContents.print({ printBackground: true }, () => {
      w.destroy();
      fs.rm(html, { force: true }, () => {});
    });
  });
}

const SHARE = {
  twitter: (u) => `https://x.com/intent/post?url=${encodeURIComponent(u)}`,
  facebook: (u) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(u)}`,
  reddit: (u) => `https://www.reddit.com/submit?url=${encodeURIComponent(u)}`,
  pinterest: (u) => `https://pinterest.com/pin/create/button/?url=${encodeURIComponent(u)}&media=${encodeURIComponent(u)}`,
  vk: (u) => `https://vk.com/share.php?url=${encodeURIComponent(u)}`,
  tumblr: (u) => `https://www.tumblr.com/widgets/share/tool?canonicalUrl=${encodeURIComponent(u)}`,
};

// ---------- screenshot capture ----------
// Overlay windows are created once per display and never shown or hidden again (Windows animates show/hide).
// Idle, they sit parked far off-screen, blank. On the hotkey they are moved onto the display and armed (dim + crosshair)
// in the same instant, while the screen is grabbed underneath: the overlay is excluded from capture, so the
// grab never contains it. The frozen image is then painted in behind the dim.

let overlayActive = false;
let overlayGen = 0;
let captureStartedAt = 0;
let rebuildPending = false;
let prevForeground = null;
const timings = [];

// Focus helpers: give the keyboard back to the app the user was in when the overlay closes.
let getFg = null, setFg = null;
try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  getFg = user32.func('void* __stdcall GetForegroundWindow()');
  setFg = user32.func('bool __stdcall SetForegroundWindow(void* hwnd)');
} catch {}

const parkBounds = (d) => ({ x: d.bounds.x, y: d.bounds.y + 24000, width: d.bounds.width, height: d.bounds.height });

function createOverlayWindow(d) {
  const park = parkBounds(d);
  const win = new BrowserWindow({
    ...park,
    frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
    alwaysOnTop: true, enableLargerThanScreen: true, show: false, thickFrame: false,
    // tool window: Chromium apps behind (Discord, browsers) otherwise think they are hidden and stop drawing
    type: 'toolbar',
    webPreferences: webPrefs({ backgroundThrottling: false }),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenu(null);
  win.setContentProtection(true); // keep the overlay out of our own screen grab
  noAnim(win);
  const wcId = win.webContents.id;
  overlays.set(wcId, { win, display: d, ready: false, loaded: false, parked: true });
  win.webContents.once('did-finish-load', () => {
    const o = overlays.get(wcId);
    if (!o) return;
    o.loaded = true;
    // shown once, off-screen; from here on it only moves
    win.setBounds(park);
    win.showInactive();
    win.setBounds(park);
  });
  win.on('closed', () => overlays.delete(wcId));
  win.loadFile(UI('overlay.html'));
}

function buildOverlays() {
  rebuildPending = false;
  for (const { win } of overlays.values()) if (!win.isDestroyed()) win.destroy();
  overlays.clear();
  for (const d of screen.getAllDisplays()) createOverlayWindow(d);
}

let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    if (overlayActive) rebuildPending = true;
    else buildOverlays();
  }, 400);
}

// RGBA pixels for each display, keyed by display id.
async function grabNative(displays) {
  const mons = shots.Monitor.all();
  const out = {};
  for (const d of displays) {
    const phys = screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y });
    let best = null, bestDist = Infinity;
    for (const m of mons) {
      const dist = Math.min(
        Math.abs(m.x() - phys.x) + Math.abs(m.y() - phys.y),
        Math.abs(m.x() - d.bounds.x) + Math.abs(m.y() - d.bounds.y)
      );
      if (dist < bestDist) { bestDist = dist; best = m; }
    }
    if (!best) continue;
    // sync is ~20 ms faster than the async variant; the arm message is already on its way to the renderer
    const img = best.captureImageSync();
    out[d.id] = { width: img.width, height: img.height, data: img.toRawSync(), rgba: true };
  }
  return out;
}

async function grabCapturer(displays) {
  const all = screen.getAllDisplays();
  const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } });
  const out = {};
  for (const d of displays) {
    const s = sources.find((x) => x.display_id === String(d.id)) || sources[all.findIndex((x) => x.id === d.id)];
    if (!s) continue;
    const { width, height } = s.thumbnail.getSize();
    out[d.id] = { width, height, data: s.thumbnail.toBitmap(), rgba: false };
  }
  return out;
}

async function grab(displays) {
  if (shots) {
    try {
      return await grabNative(displays);
    } catch {}
  }
  return grabCapturer(displays);
}

function park(o) {
  if (o.win.isDestroyed()) return;
  o.win.setBounds(parkBounds(o.display));
  o.parked = true;
}

// restoreFocus: hand the keyboard back to the app that was active before the hotkey.
function closeOverlays(restoreFocus = true) {
  captureBusy = false;
  if (!overlayActive) return;
  overlayActive = false;
  overlayGen++;
  for (const o of overlays.values()) {
    if (o.win.isDestroyed()) continue;
    o.ready = false;
    o.win.webContents.send('overlay:reset');
  }
  if (restoreFocus && prevForeground && setFg) {
    try {
      setFg(prevForeground);
    } catch {}
  }
  prevForeground = null;
  // The renderer blanks itself, then reports "parked"; park anyway if that never comes.
  setTimeout(() => {
    if (overlayActive) return;
    for (const o of overlays.values()) if (!o.parked) park(o);
    if (rebuildPending) buildOverlays();
  }, 300);
}

ipcMain.on('overlay:parked', (e) => {
  const o = overlays.get(e.sender.id);
  if (o && !overlayActive) park(o);
});

const waitFor = async (fn, ms) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await sleep(20);
  return fn();
};

async function startCapture(mode) {
  if (rec) return stopRecording();
  if (overlayActive) return closeOverlays();
  if (captureBusy) return;
  captureBusy = true;
  captureStartedAt = performance.now();
  try {
    if (!overlays.size) buildOverlays();
    if (!(await waitFor(() => [...overlays.values()].every((o) => o.loaded), 3000))) throw new Error('Overlay did not load');
    const list = [...overlays.values()].filter((o) => !o.win.isDestroyed());
    try {
      prevForeground = getFg ? getFg() : null;
    } catch {
      prevForeground = null;
    }
    overlayActive = true;
    const gen = ++overlayGen;
    const cur = screen.getCursorScreenPoint();
    const active = screen.getDisplayNearestPoint(cur);

    // 1. arm: dim + crosshair appear right away
    for (const o of list) {
      o.ready = false;
      const b = o.display.bounds;
      const inside = cur.x >= b.x && cur.x < b.x + b.width && cur.y >= b.y && cur.y < b.y + b.height;
      o.win.webContents.send('overlay:arm', {
        gen,
        mode,
        showMagnifier: settings.showMagnifier,
        cursor: inside ? { x: cur.x - b.x, y: cur.y - b.y } : null,
      });
      o.win.setBounds(b);
      o.parked = false;
    }
    const focusO = list.find((o) => o.display.id === active.id) || list[0];
    if (focusO) {
      focusO.win.focus();
      focusO.win.webContents.focus();
    }

    // 2. freeze: grab the screen (the overlay is excluded) and paint it in behind the dim
    if (mode === 'shot') {
      const images = await grab(list.map((o) => o.display));
      if (!overlayActive || gen !== overlayGen) return;
      for (const o of list) o.win.webContents.send('overlay:image', { gen, image: images[o.display.id] || null });
    }
  } catch (err) {
    captureBusy = false;
    closeOverlays();
    toast('Capture failed', err.message, { kind: 'error' });
  }
}

// ready = armed (record mode) or frozen image painted (screenshot mode)
ipcMain.on('overlay:ready', (e, gen) => {
  const o = overlays.get(e.sender.id);
  if (!o || !overlayActive || gen !== overlayGen) return;
  o.ready = true;
  if ([...overlays.values()].every((x) => x.ready || x.win.isDestroyed())) {
    timings.push(Math.round(performance.now() - captureStartedAt));
    captureBusy = false;
  }
});

ipcMain.on('overlay:close', () => closeOverlays());

ipcMain.on('overlay:selecting', (e) => {
  for (const [id, o] of overlays) if (id !== e.sender.id && !o.win.isDestroyed()) o.win.webContents.send('overlay:clear');
});

ipcMain.handle('shot:action', async (_e, { action, png, w, h, network }) => {
  closeOverlays(action === 'copy' || action === 'upload');
  const entry = addHistory({ type: 'image', buf: Buffer.from(png), ext: 'png', w, h });
  switch (action) {
    case 'copy':
      return copyEntry(entry);
    case 'save':
      return saveEntry(entry);
    case 'upload':
      return uploadEntry(entry);
    case 'print':
      return printFile(entry.file);
    case 'search': {
      const url = await uploadEntry(entry, { quiet: true });
      if (url) shell.openExternal(`https://lens.google.com/uploadbyurl?url=${encodeURIComponent(url)}`);
      return;
    }
    case 'share': {
      const url = await uploadEntry(entry, { quiet: true });
      if (url && SHARE[network]) shell.openExternal(SHARE[network](url));
      return;
    }
  }
});

function rawToPNG({ width, height, data, rgba }) {
  let bgra = data;
  if (rgba) {
    bgra = Buffer.from(data);
    for (let i = 0; i < bgra.length; i += 4) {
      const r = bgra[i];
      bgra[i] = bgra[i + 2];
      bgra[i + 2] = r;
    }
  }
  return nativeImage.createFromBitmap(bgra, { width, height }).toPNG();
}

async function fullscreenShot() {
  if (rec || overlayActive) return;
  try {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const raw = (await grab([d]))[d.id];
    if (!raw) throw new Error('No screen image');
    const png = rawToPNG(raw);
    const entry = addHistory({ type: 'image', buf: png, ext: 'png', w: raw.width, h: raw.height });
    const dest = path.join(ensureSaveDir(), `Glimpse ${stamp()}.png`);
    fs.copyFileSync(entry.file, dest);
    updateHistory(entry.id, { savedPath: dest });
    await copyPNGToClipboard(png);
    toast('Screen saved and copied', dest, { kind: 'success', action: { file: dest } });
  } catch (err) {
    toast('Capture failed', err.message, { kind: 'error' });
  }
}

// ---------- recording ----------

function setTrayRecording(on) {
  if (!tray) return;
  tray.setImage(on ? trayIconRec : trayIcon);
  tray.setToolTip(on ? 'Glimpse — recording (press hotkey again to stop)' : 'Glimpse');
  buildTrayMenu();
}

ipcMain.handle('rec:start', async (e, { rect, kind }) => {
  const o = overlays.get(e.sender.id);
  if (!o) return;
  const display = o.display;
  closeOverlays();
  // let the overlay disappear before the first frame
  await waitFor(() => [...overlays.values()].every((x) => x.win.isDestroyed() || x.parked), 500);
  await sleep(60);
  try {
    await startRecording(display, rect, kind);
  } catch (err) {
    closeRec();
    toast('Recording failed', err.message, { kind: 'error' });
  }
});

async function startRecording(d, rect, kind) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const idx = screen.getAllDisplays().findIndex((x) => x.id === d.id);
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[idx] || sources[0];
  if (!src) throw new Error('No screen source found');
  pendingDisplaySource = src;

  const abs = {
    x: Math.round(d.bounds.x + rect.x),
    y: Math.round(d.bounds.y + rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  const B = 4;
  const frameBounds = { x: abs.x - B, y: abs.y - B, width: abs.width + B * 2, height: abs.height + B * 2 };
  const frameWin = new BrowserWindow({
    ...frameBounds, frame: false, transparent: true, resizable: false, movable: false, focusable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, enableLargerThanScreen: true, show: false,
    thickFrame: false, type: 'toolbar', webPreferences: webPrefs(),
  });
  frameWin.setIgnoreMouseEvents(true);
  noAnim(frameWin);
  frameWin.setContentProtection(true);
  frameWin.setAlwaysOnTop(true, 'screen-saver');
  frameWin.setBounds(frameBounds);
  frameWin.loadFile(UI('frame.html'));

  const BW = 380, BH = 66;
  const wa = d.workArea;
  let bx = Math.round(abs.x + abs.width / 2 - BW / 2);
  bx = Math.max(wa.x + 4, Math.min(wa.x + wa.width - BW - 4, bx));
  let by = abs.y + abs.height + B + 8;
  if (by + BH > wa.y + wa.height) {
    by = abs.y - B - 8 - BH;
    if (by < wa.y) by = abs.y + abs.height - BH - 12;
  }
  const barWin = new BrowserWindow({
    x: bx, y: by, width: BW, height: BH, frame: false, transparent: true, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, fullscreenable: false,
    minimizable: false, maximizable: false, thickFrame: false, type: 'toolbar',
    webPreferences: webPrefs({ backgroundThrottling: false }),
  });
  barWin.setContentProtection(true);
  noAnim(barWin);
  barWin.setAlwaysOnTop(true, 'screen-saver');
  barWin.loadFile(UI('recbar.html'));
  barWin.on('closed', () => {
    // bar closed some other way: treat as cancel
    if (rec && rec.barWin === barWin && !rec.finishing) closeRec();
  });

  rec = { frameWin, barWin, kind, display: d, finishing: false };
  setTrayRecording(true);

  barWin.webContents.once('did-finish-load', () => {
    barWin.webContents.send('rec:init', {
      sourceId: src.id,
      rect,
      display: { width: d.size.width, height: d.size.height, scale: d.scaleFactor },
      fps: settings.recordFps,
      maxSeconds: settings.maxRecordSeconds,
      kind,
    });
  });
}

ipcMain.on('rec:started', () => {
  if (!rec) return;
  if (!rec.frameWin.isDestroyed()) rec.frameWin.showInactive();
  if (!rec.barWin.isDestroyed()) rec.barWin.showInactive();
});

function stopRecording() {
  if (rec && !rec.barWin.isDestroyed()) rec.barWin.webContents.send('rec:stop');
}

function closeRec() {
  if (!rec) return;
  const r = rec;
  rec = null;
  setTrayRecording(false);
  for (const w of [r.frameWin, r.barWin]) if (w && !w.isDestroyed()) w.destroy();
}

ipcMain.handle('rec:finish', async (_e, { data, duration, kind, cancelled, error }) => {
  if (rec) rec.finishing = true;
  closeRec();
  if (error) return toast('Recording failed', error, { kind: 'error' });
  if (cancelled || !data) return;
  const id = newId();
  const raw = path.join(tempDir(), `${id}-raw.webm`);
  const fixed = path.join(tempDir(), `${id}.webm`);
  fs.writeFileSync(raw, Buffer.from(data));
  let file = raw;
  try {
    await ff.remux(raw, fixed);
    file = fixed;
    fs.rm(raw, { force: true }, () => {});
  } catch {}
  openPreview(file, duration, kind);
});

// ---------- preview / export ----------

const previews = new Map(); // webContents.id -> { file, duration, kind, outputs: Map, entries: Map }

function openPreview(file, duration, kind) {
  const win = new BrowserWindow({
    width: 1080, height: 800, minWidth: 820, minHeight: 600, show: false, backgroundColor: '#1c2027',
    title: 'Edit recording', icon: appIcon, autoHideMenuBar: true, webPreferences: webPrefs(),
  });
  win.setMenu(null);
  noAnim(win);
  const wcId = win.webContents.id;
  const state = { file, duration, kind, outputs: new Map(), entries: new Map() };
  previews.set(wcId, state);
  win.on('closed', () => {
    previews.delete(wcId);
    fs.rm(file, { force: true }, () => {});
    for (const out of state.outputs.values()) fs.rm(out, { force: true }, () => {});
  });
  win.loadFile(UI('preview.html'));
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('preview:init', {
      fileUrl: pathToFileURL(file).href,
      duration,
      kind,
      gifFps: settings.gifFps,
      gifMaxWidth: settings.gifMaxWidth,
      videoFps: settings.recordFps,
    });
    win.show();
    win.focus();
  });
}

async function encodeFor(state, opts, sender) {
  const key = JSON.stringify([opts.format, +opts.start.toFixed(2), +opts.end.toFixed(2), opts.fps, opts.width]);
  const cached = state.outputs.get(key);
  if (cached && fs.existsSync(cached)) return { out: cached, key };
  const out = path.join(tempDir(), `${newId()}.${opts.format}`);
  await ff.encode(state.file, out, opts, (p) => {
    if (!sender.isDestroyed()) sender.send('preview:progress', p);
  });
  state.outputs.set(key, out);
  return { out, key };
}

ipcMain.handle('rec:run', async (e, { action, opts, network }) => {
  const state = previews.get(e.sender.id);
  if (!state) return { error: 'Recording not found' };
  const win = BrowserWindow.fromWebContents(e.sender);
  try {
    const { out, key } = await encodeFor(state, opts, e.sender);
    let entry = state.entries.get(key);
    if (!entry) {
      entry = addHistory({ type: opts.format === 'gif' ? 'gif' : 'video', srcFile: out, ext: opts.format, w: opts.outW || 0, h: opts.outH || 0 });
      state.entries.set(key, entry);
    }
    const size = fs.statSync(out).size;
    if (action === 'save') await saveEntry(entry, win);
    else if (action === 'copy') await copyEntry(entry);
    else if (action === 'upload') await uploadEntry(entry);
    else if (action === 'share') {
      const url = await uploadEntry(entry, { quiet: true });
      if (url && SHARE[network]) shell.openExternal(SHARE[network](url));
    }
    return { ok: true, size, url: entry.url };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.on('rec:discard', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.close();
});

// ---------- history window ----------


// ---------- dashboard ----------

function openDashboard() {
  if (dashWin && !dashWin.isDestroyed()) {
    dashWin.webContents.send('dash:refresh');
    if (dashWin.isMinimized()) dashWin.restore();
    dashWin.show();
    dashWin.focus();
    return;
  }
  dashWin = new BrowserWindow({
    width: 940, height: 640, minWidth: 760, minHeight: 540, show: false, backgroundColor: '#1c2027',
    title: 'Glimpse', icon: appIcon, autoHideMenuBar: true, webPreferences: webPrefs(),
  });
  dashWin.setMenu(null);
  noAnim(dashWin);
  dashWin.loadFile(UI('dashboard.html'));
  dashWin.once('ready-to-show', () => {
    dashWin.show();
    dashWin.focus();
  });
  dashWin.on('closed', () => (dashWin = null));
}

ipcMain.on('dash:capture', async (_e, mode) => {
  // get the dashboard out of the picture first
  if (dashWin && !dashWin.isDestroyed()) dashWin.hide();
  await sleep(120);
  if (mode === 'fullscreen') fullscreenShot();
  else startCapture(mode);
});
ipcMain.on('open:settings', () => openSettings());
ipcMain.on('open:history', () => openHistory());

function openHistory() {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.show();
    historyWin.focus();
    return;
  }
  historyWin = new BrowserWindow({
    width: 1140, height: 800, minWidth: 620, minHeight: 460, show: false, backgroundColor: '#1c2027',
    title: 'Captures', icon: appIcon, autoHideMenuBar: true, webPreferences: webPrefs(),
  });
  historyWin.setMenu(null);
  noAnim(historyWin);
  historyWin.loadFile(UI('history.html'));
  historyWin.once('ready-to-show', () => historyWin.show());
  historyWin.on('closed', () => (historyWin = null));
}

ipcMain.handle('history:list', () =>
  history.map((e) => {
    const exists = fs.existsSync(e.file);
    if (exists && !e.size) e.size = fs.statSync(e.file).size;
    return { ...e, fileUrl: pathToFileURL(e.file).href, exists };
  })
);

ipcMain.handle('history:action', async (_e, { id, action }) => {
  const entry = history.find((x) => x.id === id);
  if (!entry) return;
  switch (action) {
    case 'open':
      return shell.openPath(entry.savedPath && fs.existsSync(entry.savedPath) ? entry.savedPath : entry.file);
    case 'folder':
      return shell.showItemInFolder(entry.savedPath && fs.existsSync(entry.savedPath) ? entry.savedPath : entry.file);
    case 'copy':
      return copyEntry(entry);
    case 'link':
      if (entry.url) {
        copyTextToClipboard(entry.url);
        toast('Link copied', entry.url, { kind: 'success', action: { url: entry.url } });
      }
      return;
    case 'browser':
      if (entry.url) shell.openExternal(entry.url);
      return;
    case 'upload':
      return uploadEntry(entry);
    case 'save':
      return saveEntry(entry, historyWin);
    case 'delete':
      history = history.filter((x) => x !== entry);
      fs.rm(entry.file, { force: true }, () => {});
      store.saveHistory(history);
      return notifyHistory();
  }
});

ipcMain.handle('history:clear', async () => {
  const res = await dialog.showMessageBox(historyWin || undefined, {
    type: 'warning',
    buttons: ['Clear history', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Clear capture history?',
    detail: 'Removes the list and the cached copies. Files you saved to your own folders and uploaded links are not touched.',
  });
  if (res.response !== 0) return;
  for (const e of history) fs.rm(e.file, { force: true }, () => {});
  history = [];
  store.saveHistory(history);
  notifyHistory();
});

// ---------- settings ----------

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 900, height: 740, minWidth: 700, minHeight: 520, show: false, backgroundColor: '#1c2027',
    title: 'Glimpse settings', icon: appIcon, autoHideMenuBar: true, webPreferences: webPrefs(),
  });
  settingsWin.setMenu(null);
  noAnim(settingsWin);
  settingsWin.loadFile(UI('settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
    registerHotkeys(); // re-enable after editing
  });
}

ipcMain.handle('settings:get', () => ({ settings, failed: registerHotkeys() }));

ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch, hotkeys: { ...settings.hotkeys, ...(patch.hotkeys || {}) } };
  store.saveSettings(settings);
  if ('launchAtLogin' in patch) applyLoginItem();
  const failed = registerHotkeys();
  buildTrayMenu();
  return { settings, failed };
});

ipcMain.handle('settings:pickDir', async () => {
  const res = await dialog.showOpenDialog(settingsWin || undefined, {
    title: 'Choose save folder',
    defaultPath: settings.saveDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

// While the settings window records a hotkey, global shortcuts must be off so the keypress reaches it.
ipcMain.on('settings:pauseHotkeys', (_e, pause) => {
  if (pause) globalShortcut.unregisterAll();
  else registerHotkeys();
});

ipcMain.on('open:folder', () => shell.openPath(ensureSaveDir()));

function applyLoginItem() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.launchAtLogin,
      path: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()],
    });
  } catch {}
}

// ---------- hotkeys & tray ----------

const HOTKEY_ACTIONS = {
  screenshot: () => startCapture('shot'),
  fullscreen: () => fullscreenShot(),
  gif: () => startCapture('gif'),
  video: () => startCapture('video'),
};

function registerHotkeys() {
  if (QUIET) return [];
  globalShortcut.unregisterAll();
  const failed = [];
  for (const [name, acc] of Object.entries(settings.hotkeys)) {
    if (!acc || !HOTKEY_ACTIONS[name]) continue;
    try {
      if (!globalShortcut.register(acc, HOTKEY_ACTIONS[name])) failed.push(name);
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

function buildTrayMenu() {
  if (!tray) return;
  const hk = (n) => (settings.hotkeys[n] ? { accelerator: settings.hotkeys[n], registerAccelerator: false } : {});
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Glimpse', click: openDashboard },
      { type: 'separator' },
      { label: 'Capture area', click: () => startCapture('shot'), ...hk('screenshot') },
      { label: 'Capture whole screen', click: () => fullscreenShot(), ...hk('fullscreen') },
      { type: 'separator' },
      { label: 'Record GIF', click: () => startCapture('gif'), ...hk('gif') },
      { label: 'Record video', click: () => startCapture('video'), ...hk('video') },
      { label: 'Stop recording', click: () => stopRecording(), visible: !!rec },
      { type: 'separator' },
      { label: 'Captures', click: openHistory },
      { label: 'Open save folder', click: () => shell.openPath(ensureSaveDir()) },
      { label: 'Settings', click: openSettings },
      { type: 'separator' },
      { label: 'Quit Glimpse', click: () => app.quit() },
    ])
  );
}

function checkSnippingKey() {
  if (settings.snipWarned) return;
  if (!Object.values(settings.hotkeys).some((h) => /^PrintScreen$/i.test(h || ''))) return;
  execFile(
    'reg',
    ['query', 'HKCU\\Control Panel\\Keyboard', '/v', 'PrintScreenKeyForSnippingEnabled'],
    { windowsHide: true },
    (err, stdout) => {
      // Missing value = Windows 11 default, which is "on" in current builds.
      const on = err ? true : /0x1\b/.test(stdout);
      if (on) {
        settings.snipWarned = true;
        store.saveSettings(settings);
        toast(
          'Snipping Tool may also open on PrtSc',
          'Turn off “Use the Print screen key to open screen capture” in Windows settings',
          { kind: 'error', action: { settingsUri: 'ms-settings:easeofaccess-keyboard' } }
        );
      }
    }
  );
}

// ---------- app lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openDashboard());
  app.on('window-all-closed', () => {}); // keep running in the tray
  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.whenReady().then(() => {
    app.setAppUserModelId('app.glimpse');
    settings = store.loadSettings();
    history = store.loadHistory().filter((e) => e && e.file);

    appIcon = nativeImage.createFromBuffer(iconPNG(64));
    trayIcon = nativeImage.createFromBuffer(iconPNG(32), { scaleFactor: 2 });
    trayIconRec = nativeImage.createFromBuffer(iconPNG(32, true), { scaleFactor: 2 });

    // Fallback path for getDisplayMedia if the legacy desktop constraint is unavailable.
    session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
      if (pendingDisplaySource) cb({ video: pendingDisplaySource });
      else cb({});
    });

    tray = new Tray(trayIcon);
    tray.setToolTip('Glimpse');
    // single click captures (like Lightshot); double click opens the dashboard
    let trayClickTimer = null;
    let lastDouble = 0;
    tray.on('click', () => {
      if (Date.now() - lastDouble < 500) return;
      clearTimeout(trayClickTimer);
      trayClickTimer = setTimeout(() => startCapture('shot'), 280);
    });
    tray.on('double-click', () => {
      clearTimeout(trayClickTimer);
      lastDouble = Date.now();
      openDashboard();
    });
    buildTrayMenu();
    applyLoginItem();

    buildOverlays();
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, scheduleRebuild);

    const failed = registerHotkeys();
    if (process.argv.includes('--selftest')) console.log('[selftest] hotkeys failed:', JSON.stringify(failed));
    const shot = settings.hotkeys.screenshot || 'the tray icon';
    if (failed.length) {
      const names = { screenshot: 'Capture area', fullscreen: 'Capture screen', gif: 'Record GIF', video: 'Record video' };
      toast('Another app uses some hotkeys', `Pick new keys for: ${failed.map((f) => names[f] || f).join(', ')}`, {
        kind: 'error',
        action: { openSettings: true },
      });
    } else {
      const pk = (k) => (k || '').replace('PrintScreen', 'PrtSc');
      toast('Glimpse is ready', `${pk(shot)} captures an area${settings.hotkeys.gif ? `, ${pk(settings.hotkeys.gif)} records a GIF` : ''}`, {
        kind: 'info',
        action: { openDashboard: true },
      });
      setTimeout(checkSnippingKey, 5000);
    }

    if (process.argv.includes('--capture')) startCapture('shot');
    if (REVIEW) require('./review')({ preload: PRELOAD });
    if (DOCS) require('./docs').run({ preload: PRELOAD, userData: app.getPath('userData') });
    if (process.argv.includes('--speedtest')) require('./speedtest')({ startCapture, overlays, timings });
    if (process.argv.includes('--selftest')) {
      require('./selftest')({
        startCapture, stopRecording, overlays, previews, openHistory, openSettings,
        getRec: () => rec,
        timings,
        noAnimOk: !!dwmSetAttr,
        noAnimResults,
        // test-only: a plain Win32 (WinForms) window that changes color every 50 ms, at x=1200,y=640
        spawnNativeTicker: () =>
          require('child_process').spawn(
            'powershell.exe',
            [
              '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
              'Add-Type -AssemblyName System.Windows.Forms;$f=New-Object Windows.Forms.Form;$f.FormBorderStyle="None";' +
                '$f.StartPosition="Manual";$f.Left=1200;$f.Top=640;$f.Width=260;$f.Height=220;$f.ShowInTaskbar=$false;$f.TopMost=$true;' +
                '$t=New-Object Windows.Forms.Timer;$t.Interval=50;$r=New-Object Random;' +
                '$t.Add_Tick({$f.BackColor=[Drawing.Color]::FromArgb($r.Next(256),$r.Next(256),$r.Next(256))});$t.Start();' +
                '[Windows.Forms.Application]::Run($f)',
            ],
            { windowsHide: false }
          ),
        nativeGrab: !!shots,
        getHistoryWin: () => historyWin,
        getSettingsWin: () => settingsWin,
        setSetting: (k, v) => (settings[k] = v),
      });
    }
  });
}
