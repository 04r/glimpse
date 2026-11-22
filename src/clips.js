'use strict';
// Clips: instant replay settings, the save-clip flow, the clip library and its window.
// main.js passes in what it owns (settings, toast, windows helpers); everything clip-related lives here.

const { app, BrowserWindow, ipcMain, screen, shell, dialog } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { Replay, Recording, probeEncoders, helperJSON, ENCODERS, HELPER } = require('./replay');

const DEFAULTS = {
  enabled: false, // instant replay is on
  startMode: 'remember', // remember | always | apps | manual
  startApps: [],
  length: 60,
  shortLength: 15,
  folder: '',
  container: 'mp4',
  perAppFolders: true,
  notify: true,
  sound: true,
  video: {
    display: 'primary', // primary | cursor | <display id>
    target: 'screen', // screen | window
    windowExe: '',
    encoder: 'auto',
    codec: 'h264',
    resolution: 'native', // native | 2160 | 1440 | 1080 | 900 | 720 | 480
    fps: 60,
    quality: 'high', // low | medium | high | ultra | custom
    mbps: 30,
    rc: 'vbr', // vbr | cbr | cq
    cq: 23,
    preset: 'p4',
    cursor: true,
  },
  audio: {
    system: true,
    systemDevice: 'default',
    systemVolume: 100,
    appMode: 'all', // all | only | except
    apps: [], // [{ exe, name, volume }]
    exceptApp: '',
    mic: false,
    micDevice: 'default',
    micVolume: 100,
    micMode: 'always', // always | ptt
    pttKey: null, // { vk, label }
    denoise: true,
    gate: false,
    gateDb: -45,
    tracks: 'separate', // mixed | separate
    kbps: 192,
    offsetMs: 0,
  },
};

const HOTKEY_DEFAULTS = { clipSave: 'Alt+Z', clipShort: '', clipToggle: 'Alt+Shift+Z', recordToggle: 'Alt+F9', micMute: '' };

/** settings.clips with every field filled in */
function withDefaults(c = {}) {
  return {
    ...DEFAULTS, ...c,
    video: { ...DEFAULTS.video, ...(c.video || {}) },
    audio: { ...DEFAULTS.audio, ...(c.audio || {}) },
  };
}

// friendlier names for common game executables
const KNOWN = {
  'valorant-win64-shipping': 'VALORANT', 'robloxplayerbeta': 'Roblox', 'robloxstudiobeta': 'Roblox Studio', 'javaw': 'Minecraft',
  'minecraft.windows': 'Minecraft', 'cs2': 'Counter-Strike 2', 'fortniteclient-win64-shipping': 'Fortnite', 'r5apex': 'Apex Legends',
  'r5apex_dx12': 'Apex Legends', 'league of legends': 'League of Legends', 'overwatch': 'Overwatch', 'gta5': 'GTA V',
  'rocketleague': 'Rocket League', 'cod': 'Call of Duty', 'destiny2': 'Destiny 2', 'dota2': 'Dota 2', 'rainbowsix': 'Rainbow Six Siege',
  'eldenring': 'Elden Ring', 'cyberpunk2077': 'Cyberpunk 2077', 'deadlock': 'Deadlock', 'marvel-win64-shipping': 'Marvel Rivals',
  'explorer': 'Desktop', 'chrome': 'Chrome', 'msedge': 'Edge', 'firefox': 'Firefox', 'zen': 'Zen', 'discord': 'Discord',
  'code': 'VS Code', 'spotify': 'Spotify', 'obs64': 'OBS',
};
function appName(exe) {
  if (!exe) return 'Desktop';
  const base = exe.replace(/\.exe$/i, '');
  const k = KNOWN[base.toLowerCase()];
  if (k) return k;
  const n = base.replace(/[-_]?(Win64|Win32|x64|x86)?[-_]?Shipping$/i, '').replace(/[-_](Win64|Win32|x64|x86|DX11|DX12)$/i, '') || base;
  return n === n.toLowerCase() ? n[0].toUpperCase() + n.slice(1) : n;
}
const safeName = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'Clip';

// key name -> Windows virtual-key code, for push-to-talk
function vkFor(code, key, button) {
  if (button === 3) return 0x05; // mouse back (XBUTTON1)
  if (button === 4) return 0x06; // mouse forward (XBUTTON2)
  if (button === 1) return 0x04; // middle
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit\d$/.test(code)) return 0x30 + +code[5];
  if (/^F(\d{1,2})$/.test(code)) return 0x6f + +code.slice(1);
  const map = {
    CapsLock: 0x14, Space: 0x20, Tab: 0x09, Backquote: 0xc0, ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3,
    AltLeft: 0xa4, AltRight: 0xa5, Insert: 0x2d, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
    Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64, Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67,
    Numpad8: 0x68, Numpad9: 0x69, Minus: 0xbd, Equal: 0xbb, BracketLeft: 0xdb, BracketRight: 0xdd, Backslash: 0xdc,
    Semicolon: 0xba, Quote: 0xde, Comma: 0xbc, Period: 0xbe, Slash: 0xbf, Pause: 0x13, ScrollLock: 0x91,
  };
  return map[code] || 0;
}

module.exports = function clips(ctx) {
  const { getSettings, saveSettings, toast, webPrefs, UI, noAnim, appIcon, native, ffmpegBin, onHotkeysChanged, buildTrayMenu } = ctx;
  const userData = app.getPath('userData');
  const root = path.join(app.getPath('temp'), 'glimpse-replay');
  fs.mkdirSync(root, { recursive: true });
  const replay = new Replay({ ffmpeg: ffmpegBin(), root });
  let win = null;
  let meter = null; // helper process for live meters while the replay is off
  let micMuted = false;
  let saving = false;
  let lastPlanKey = '';
  let watcher = null;
  let appsSeenAt = 0;

  const cfg = () => withDefaults(getSettings().clips);
  const setCfg = (c) => {
    const s = getSettings();
    s.clips = c;
    saveSettings(s);
  };
  const clipsDir = () => {
    const c = cfg();
    const d = c.folder || path.join(app.getPath('videos'), 'Glimpse Clips');
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  // ---------- index of saved clips ----------
  const indexFile = path.join(userData, 'clips.json');
  let index = [];
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  } catch {}
  const saveIndex = () => {
    try {
      fs.writeFileSync(indexFile, JSON.stringify(index, null, 1));
    } catch {}
  };

  // ---------- building the plan ----------

  let outputsCache = null;
  async function outputs() {
    if (!outputsCache) outputsCache = helperJSON(['--outputs']).catch(() => ({ outputs: [] }));
    return outputsCache;
  }
  screen.on('display-added', () => (outputsCache = null));
  screen.on('display-removed', () => (outputsCache = null));
  screen.on('display-metrics-changed', () => (outputsCache = null));

  function pickDisplay(v) {
    const all = screen.getAllDisplays();
    if (v.display === 'cursor') return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return all.find((d) => String(d.id) === String(v.display)) || screen.getPrimaryDisplay();
  }

  async function plan() {
    const c = cfg();
    const v = c.video, A = c.audio;
    const outs = (await outputs()).outputs || [];
    let out = null, crop = null, note = '';
    if (v.target === 'window' && v.windowExe) {
      const w = native.appWindows().find((x) => x.exe.toLowerCase() === v.windowExe.toLowerCase() && !x.minimized);
      if (w) {
        const cx = w.rect.x + w.rect.width / 2, cy = w.rect.y + w.rect.height / 2;
        out = outs.find((o) => cx >= o.x && cx < o.x + o.w && cy >= o.y && cy < o.y + o.h) || null;
        if (out) {
          const x0 = Math.max(w.rect.x, out.x), y0 = Math.max(w.rect.y, out.y);
          const x1 = Math.min(w.rect.x + w.rect.width, out.x + out.w), y1 = Math.min(w.rect.y + w.rect.height, out.y + out.h);
          const cw = (x1 - x0) & ~1, ch = (y1 - y0) & ~1;
          if (cw >= 64 && ch >= 64 && (cw < out.w || ch < out.h)) crop = { x: x0 - out.x, y: y0 - out.y, w: cw, h: ch };
        }
      } else note = `${appName(v.windowExe)} isn't open, recording the whole screen until it is`;
    }
    if (!out) {
      const d = pickDisplay(v);
      const phys = screen.dipToScreenRect(null, d.bounds);
      out = outs.find((o) => Math.abs(o.x - phys.x) < 4 && Math.abs(o.y - phys.y) < 4) ||
        outs.find((o) => o.w === phys.width && o.h === phys.height) || outs[0] || { index: 0, w: phys.width, h: phys.height, x: phys.x, y: phys.y };
    }
    const capW = crop ? crop.w : out.w, capH = crop ? crop.h : out.h;
    let scaleTo = null;
    const target = v.resolution === 'native' ? 0 : +v.resolution;
    if (target && capH > target) scaleTo = { w: Math.round((capW * target) / capH / 2) * 2, h: target };
    const W = scaleTo ? scaleTo.w : capW, H = scaleTo ? scaleTo.h : capH;

    const avail = await probeEncoders(ffmpegBin());
    let codec = v.codec;
    let encoder = v.encoder;
    const has = (e, k) => avail.includes(`${e}:${k}`);
    if (encoder === 'auto' || !has(encoder, codec)) {
      encoder = ['nvenc', 'amf', 'qsv', 'cpu'].find((e) => has(e, codec));
      if (!encoder) {
        codec = 'h264';
        encoder = ['nvenc', 'amf', 'qsv', 'cpu'].find((e) => has(e, 'h264')) || 'cpu';
      }
    }
    const base = { low: 8, medium: 15, high: 25, ultra: 42 }[v.quality];
    const pixels = (W * H) / 2073600;
    let mbps = v.quality === 'custom' ? +v.mbps : base * Math.pow(pixels, 0.85) * Math.pow(v.fps / 60, 0.7) * (codec === 'h264' ? 1 : 0.7);
    mbps = Math.max(1, Math.min(200, Math.round(mbps * 10) / 10));

    const sources = [];
    if (A.system) {
      const dev = A.systemDevice && A.systemDevice !== 'default' ? `system:${A.systemDevice}` : 'system';
      if (A.appMode === 'only') {
        for (const a of A.apps || []) sources.push({ spec: `app:${a.exe}`, kind: 'game', volume: a.volume == null ? A.systemVolume : a.volume, label: a.name || appName(a.exe) });
      } else if (A.appMode === 'except' && A.exceptApp) {
        sources.push({ spec: `except:${A.exceptApp}`, kind: 'game', volume: A.systemVolume, label: `Everything except ${appName(A.exceptApp)}` });
      } else sources.push({ spec: dev, kind: 'game', volume: A.systemVolume, label: 'System sound' });
    }
    if (A.mic) {
      sources.push({
        spec: A.micDevice && A.micDevice !== 'default' ? `mic:${A.micDevice}` : 'mic', kind: 'mic', volume: A.micVolume, label: 'Microphone',
        ptt: A.micMode === 'ptt' && A.pttKey ? A.pttKey.vk : 0, denoise: A.denoise, gate: A.gate, gateDb: A.gateDb,
      });
    }
    return {
      outputIdx: out.index, crop, fps: +v.fps, cursor: !!v.cursor, encoder, codec, mbps, rc: v.rc, cq: +v.cq, preset: v.preset, scaleTo,
      length: +c.length, audio: { sources, tracks: A.tracks, kbps: +A.kbps, offsetMs: +A.offsetMs },
      info: { width: W, height: H, encoderName: ENCODERS[encoder].name, display: out.device || '', note },
    };
  }

  // ---------- running ----------

  function push() {
    if (win && !win.isDestroyed()) win.webContents.send('clips:status', status());
    buildTrayMenu();
  }
  replay.on('state', push);
  replay.on('levels', (l) => win && !win.isDestroyed() && win.webContents.send('clips:levels', l));
  replay.on('crash', ({ message, fails }) => {
    if (fails === 1) console.warn('[replay]', message);
  });
  replay.on('state', ({ state, error }) => {
    if (state === 'error') toast('Instant replay stopped', error || 'The recorder keeps failing', { kind: 'error', action: { openClips: true } });
  });

  function status() {
    const p = replay.plan;
    return {
      state: replay.state, error: replay.error, buffered: replay.buffered(), stats: replay.stats, micMuted,
      recording: recording.active ? { seconds: Math.round((Date.now() - recording.started) / 1000), name: (recording.meta || {}).name } : null,
      plan: p ? { ...p.info, fps: p.fps, mbps: p.mbps, codec: p.codec, encoder: p.encoder, length: p.length, sources: p.audio.sources.map((s) => s.label) } : null,
    };
  }

  async function start({ quiet } = {}) {
    stopMeter();
    const p = await plan();
    lastPlanKey = JSON.stringify({ ...p, info: undefined });
    micMuted = false;
    replay.muted.clear();
    await replay.start(p);
    if (!quiet && cfg().notify) {
      const k = getSettings().hotkeys.clipSave;
      toast('Instant replay is on', `${k ? `${k} saves` : 'Save'} the last ${fmtLen(p.length)}${p.info.note ? `. ${p.info.note}` : ''}`, { kind: 'success' });
    }
    push();
  }
  function stop({ quiet } = {}) {
    replay.stop();
    if (!quiet && cfg().notify) toast('Instant replay is off', '', { kind: 'info' });
    push();
  }
  async function setEnabled(on, opts) {
    const c = cfg();
    c.enabled = !!on;
    setCfg(c);
    if (on) await start(opts);
    else stop(opts);
  }
  const toggle = () => setEnabled(!(replay.state === 'on' || replay.state === 'starting'));

  // restart with new settings if they change what is recorded
  async function restartIfChanged() {
    if (!(replay.state === 'on' || replay.state === 'starting')) return;
    const p = await plan();
    const key = JSON.stringify({ ...p, info: undefined });
    if (key !== lastPlanKey) {
      lastPlanKey = key;
      micMuted = false;
      replay.muted.clear();
      await replay.start(p);
      push();
    }
  }

  const fmtLen = (s) => (s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} seconds`);

  async function save(seconds) {
    if (saving) return;
    if (replay.state !== 'on') {
      toast(replay.state === 'starting' ? 'Instant replay is starting…' : 'Instant replay is off',
        replay.state === 'starting' ? 'Try again in a moment' : 'Turn it on in Clips to save what just happened', { kind: 'error', action: { openClips: true } });
      return;
    }
    saving = true;
    const fg = native.foregroundApp();
    const exe = fg && fg.pid !== process.pid ? fg.exe : '';
    const name = appName(exe);
    const c = cfg();
    const len = Math.min(seconds || c.length, c.length);
    if (c.notify) toast('Saving clip…', `${name}, last ${fmtLen(len)}`, { sticky: true });
    try {
      let dir = clipsDir();
      if (c.perAppFolders) {
        dir = path.join(dir, safeName(name));
        fs.mkdirSync(dir, { recursive: true });
      }
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const file = path.join(dir, `${safeName(name)} ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}.${c.container}`);
      const res = await replay.save(len, file);
      const st = fs.statSync(file);
      index.unshift({ file, app: name, exe, created: Date.now(), seconds: res.seconds, size: st.size, width: replay.plan.info.width, height: replay.plan.info.height });
      saveIndex();
      if (c.notify) toast('Clip saved', `${name}, ${fmtLen(Math.round(res.seconds))}, ${(st.size / 1048576).toFixed(1)} MB`, { kind: 'success', action: { openClipFile: file }, sound: c.sound });
      if (win && !win.isDestroyed()) win.webContents.send('clips:changed');
      return file;
    } catch (e) {
      toast('Could not save the clip', e.message, { kind: 'error' });
    } finally {
      saving = false;
    }
  }

  function toggleMic() {
    const p = replay.plan;
    if (!p || replay.state !== 'on') return;
    const i = p.audio.sources.findIndex((s) => s.kind === 'mic');
    if (i < 0) return toast('No microphone in clips', 'Turn on the microphone in Clips, Audio', { kind: 'error' });
    micMuted = !micMuted;
    replay.mute(i, micMuted);
    toast(micMuted ? 'Microphone muted in clips' : 'Microphone back on in clips', '', { kind: 'info' });
    push();
  }

  // ---------- full recording (start / stop) ----------

  const recording = new Recording({ ffmpeg: ffmpegBin() });
  let recTimer = null;
  recording.on('died', (msg) => {
    toast('Recording stopped by itself', msg, { kind: 'error' });
    finishRecording().catch(() => {});
  });
  recording.on('levels', (l) => win && !win.isDestroyed() && replay.state !== 'on' && win.webContents.send('clips:levels', l));

  async function toggleRecording() {
    if (recording.active) return finishRecording();
    const fg = native.foregroundApp();
    const exe = fg && fg.pid !== process.pid ? fg.exe : '';
    const name = appName(exe);
    const c = cfg();
    let dir = clipsDir();
    if (c.perAppFolders) {
      dir = path.join(dir, safeName(name));
      fs.mkdirSync(dir, { recursive: true });
    }
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const file = path.join(dir, `${safeName(name)} ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())} recording.${c.container}`);
    try {
      const p = await plan();
      await recording.start(p, file);
      recording.meta = { name, exe, width: p.info.width, height: p.info.height };
      const k = getSettings().hotkeys.recordToggle;
      if (c.notify) toast('Recording', `${name}. ${k ? `${k} stops` : 'Stop it from the tray or Clips'}`, { kind: 'info' });
      clearInterval(recTimer);
      recTimer = setInterval(push, 1000);
      push();
    } catch (e) {
      toast('Could not start recording', e.message, { kind: 'error' });
    }
  }

  async function finishRecording() {
    clearInterval(recTimer);
    if (!recording.active) return push();
    const meta = recording.meta || {};
    if (cfg().notify) toast('Finishing recording…', '', { sticky: true });
    try {
      const res = await recording.stop();
      const st = fs.statSync(res.file);
      index.unshift({ file: res.file, app: meta.name, exe: meta.exe, created: Date.now(), seconds: res.seconds, size: st.size, width: meta.width, height: meta.height });
      saveIndex();
      if (cfg().notify) toast('Recording saved', `${meta.name}, ${fmtLen(Math.round(res.seconds))}, ${(st.size / 1048576).toFixed(0)} MB`, { kind: 'success', action: { openClipFile: res.file }, sound: cfg().sound });
      if (win && !win.isDestroyed()) win.webContents.send('clips:changed');
    } catch (e) {
      toast('Could not save the recording', e.message, { kind: 'error' });
    }
    push();
  }

  // ---------- turning on by itself ----------

  function watch() {
    clearInterval(watcher);
    const c = cfg();
    const tick = async () => {
      const cc = cfg();
      if (cc.startMode === 'apps' && (cc.startApps || []).length) {
        const names = new Set(cc.startApps.map((x) => x.toLowerCase()));
        const running = native.processes().some((p) => names.has(p.exe.toLowerCase()));
        const on = replay.state === 'on' || replay.state === 'starting';
        if (running) appsSeenAt = Date.now();
        if (running && !on && replay.state !== 'error') await setEnabled(true);
        else if (!running && on && Date.now() - appsSeenAt > 30000) await setEnabled(false);
      }
      // a recorded window that moved or appeared: record it where it is now
      if (cc.video.target === 'window' && (replay.state === 'on' || replay.state === 'starting')) await restartIfChanged();
    };
    watcher = setInterval(() => tick().catch(() => {}), 5000);
    void c;
  }

  function boot() {
    const c = cfg();
    watch();
    if (c.startMode === 'always' || (c.startMode === 'remember' && c.enabled)) start({ quiet: true }).catch(() => {});
  }

  // ---------- library ----------

  const thumbs = path.join(userData, 'clipthumbs');
  fs.mkdirSync(thumbs, { recursive: true });
  const VIDEO = /\.(mp4|mkv|mov|webm)$/i;

  function scan() {
    const base = clipsDir();
    const found = [];
    const walk = (d, depth) => {
      let ents = [];
      try {
        ents = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const f = path.join(d, e.name);
        if (e.isDirectory() && depth < 2) walk(f, depth + 1);
        else if (e.isFile() && VIDEO.test(e.name)) found.push(f);
      }
    };
    walk(base, 0);
    const byFile = new Map(index.map((x) => [x.file.toLowerCase(), x]));
    const list = found.map((f) => {
      const st = fs.statSync(f);
      const known = byFile.get(f.toLowerCase());
      const folderApp = path.dirname(f) !== base ? path.basename(path.dirname(f)) : '';
      return {
        file: f, url: pathToFileURL(f).href, name: path.basename(f).replace(VIDEO, ''), size: st.size, created: known ? known.created : st.birthtimeMs || st.mtimeMs,
        app: known ? known.app : folderApp || 'Other', seconds: known ? known.seconds : 0, width: known ? known.width : 0, height: known ? known.height : 0,
      };
    });
    list.sort((a, b) => b.created - a.created);
    // forget index entries whose file is gone
    const live = new Set(found.map((f) => f.toLowerCase()));
    const before = index.length;
    index = index.filter((x) => live.has(x.file.toLowerCase()));
    if (index.length !== before) saveIndex();
    return list;
  }

  const thumbJobs = new Map();
  function thumb(file) {
    const st = fs.statSync(file);
    const key = crypto.createHash('sha1').update(file + st.size + st.mtimeMs).digest('hex').slice(0, 16);
    const out = path.join(thumbs, key + '.jpg');
    if (fs.existsSync(out)) return Promise.resolve(pathToFileURL(out).href);
    if (thumbJobs.has(out)) return thumbJobs.get(out);
    const job = new Promise((resolve) => {
      execFile(ffmpegBin(), ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', '-y', out],
        { windowsHide: true, timeout: 20000 }, () => resolve(fs.existsSync(out) ? pathToFileURL(out).href : ''));
    });
    thumbJobs.set(out, job);
    return job;
  }

  /** duration + tracks of a file, from ffmpeg's header dump */
  function probe(file) {
    return new Promise((resolve) => {
      execFile(ffmpegBin(), ['-hide_banner', '-i', file], { windowsHide: true, timeout: 15000 }, (_e, _o, err) => {
        const s = String(err || '');
        const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(s);
        const v = /Video: (\w+).*?, (\d{2,5})x(\d{2,5})/.exec(s);
        const fps = /, ([\d.]+) fps/.exec(s);
        const tracks = [];
        const re = /Stream #0:(\d+)[^:]*: Audio: (\w+)[^\n]*\n(?:\s+Metadata:\s*\n)?(?:[^\n]*\n)*?/g;
        const lines = s.split(/\r?\n/);
        lines.forEach((l, i) => {
          if (/Stream #0:\d+.*Audio:/.test(l)) {
            let title = '';
            for (let k = i + 1; k < Math.min(lines.length, i + 5); k++) {
              const t = /^\s+(?:title|handler_name)\s*:\s*(.+)$/.exec(lines[k]);
              if (t && !/SoundHandler/.test(t[1])) title = t[1].trim();
              if (/Stream #/.test(lines[k])) break;
            }
            tracks.push(title || `Track ${tracks.length + 1}`);
          }
        });
        void re;
        resolve({
          duration: m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0,
          codec: v ? v[1] : '', width: v ? +v[2] : 0, height: v ? +v[3] : 0, fps: fps ? +fps[1] : 0, tracks,
        });
      });
    });
  }

  function runFF(args, duration, onProgress) {
    return new Promise((resolve, reject) => {
      const p = spawn(ffmpegBin(), ['-hide_banner', '-nostdin', ...args], { windowsHide: true });
      let log = '';
      p.stderr.on('data', (d) => {
        const s = String(d);
        log = (log + s).slice(-6000);
        const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
        if (m && onProgress && duration) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / duration));
      });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(log.trim().split(/\r?\n/).pop() || `ffmpeg ${code}`))));
    });
  }

  /** trim / convert a clip. kind: copy | exact | small | gif */
  async function exportClip({ file, start, end, kind, track, targetMB }, sender) {
    const dur = Math.max(0.2, end - start);
    const ext = kind === 'gif' ? 'gif' : 'mp4';
    const tag = kind === 'gif' ? '' : kind === 'small' ? ` (${targetMB} MB)` : ' (trimmed)';
    let out = path.join(path.dirname(file), `${path.basename(file).replace(VIDEO, '')}${tag}.${ext}`);
    for (let n = 2; fs.existsSync(out); n++) out = out.replace(/( \d+)?(\.\w+)$/, ` ${n}$2`);
    const prog = (f) => sender && !sender.isDestroyed() && sender.send('clips:progress', f);
    const info = await probe(file);
    const audioMap = track === 'all' ? ['-map', '0:a?'] : track === 'none' ? [] : ['-map', `0:a:${+track || 0}?`];
    const avail = await probeEncoders(ffmpegBin());
    const hw = avail.includes('nvenc:h264') ? 'h264_nvenc' : avail.includes('amf:h264') ? 'h264_amf' : avail.includes('qsv:h264') ? 'h264_qsv' : 'libx264';
    if (kind === 'copy') {
      await runFF(['-ss', start.toFixed(3), '-i', file, '-t', dur.toFixed(3), '-map', '0:v', ...audioMap, '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-y', out], dur, prog);
    } else if (kind === 'exact') {
      const q = hw === 'libx264' ? ['-crf', '18', '-preset', 'medium'] : ['-rc', 'vbr', '-cq', '19', '-b:v', '0'];
      await runFF(['-ss', start.toFixed(3), '-i', file, '-t', dur.toFixed(3), '-map', '0:v', ...audioMap, '-c:v', hw, ...(hw === 'h264_nvenc' ? q : hw === 'libx264' ? q : ['-b:v', '40M']),
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', out], dur, prog);
    } else if (kind === 'small') {
      // fit under a size limit (Discord: 10 MB): pick the bitrate from the length, shrink big frames
      const audioK = 96;
      const totalK = (targetMB * 8 * 1024 * 0.94) / dur;
      const videoK = Math.max(150, Math.floor(totalK - audioK));
      const h = videoK < 1200 ? 480 : videoK < 2500 ? 720 : 1080;
      const scale = info.height > h ? ['-vf', `scale=-2:${h}`] : [];
      await runFF(['-ss', start.toFixed(3), '-i', file, '-t', dur.toFixed(3), '-map', '0:v', ...(track === 'none' ? [] : ['-map', `0:a:${track === 'all' ? 0 : +track || 0}?`]),
        ...scale, '-c:v', 'libx264', '-preset', 'medium', '-b:v', `${videoK}k`, '-maxrate', `${videoK}k`, '-bufsize', `${videoK * 2}k`, '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', `${audioK}k`, '-ac', '2', '-movflags', '+faststart', '-y', out], dur, prog);
    } else if (kind === 'gif') {
      await runFF(['-ss', start.toFixed(3), '-t', Math.min(dur, 30).toFixed(3), '-i', file,
        '-vf', "fps=20,scale='min(iw,720)':-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
        '-loop', '0', '-y', out], Math.min(dur, 30), prog);
    }
    prog(1);
    if (index.find((x) => x.file === file)) {
      const src = index.find((x) => x.file === file);
      index.unshift({ ...src, file: out, created: Date.now(), seconds: dur, size: fs.statSync(out).size });
      saveIndex();
    }
    return out;
  }

  // ---------- meters while the replay is off ----------

  async function startMeter() {
    stopMeter();
    if (replay.state === 'on' || replay.state === 'starting') return;
    const p = await plan();
    if (!p.audio.sources.length) return;
    const args = ['--meter'];
    for (const s of p.audio.sources) {
      args.push('--source', s.spec);
      if (s.ptt) args.push('--ptt', String(s.ptt));
    }
    const m = spawn(HELPER, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    meter = m;
    let buf = '';
    m.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const j = JSON.parse(line);
          if (j.levels && win && !win.isDestroyed()) win.webContents.send('clips:levels', j.levels);
        } catch {}
      }
    });
    m.on('exit', () => meter === m && (meter = null));
  }
  function stopMeter() {
    if (!meter) return;
    try {
      meter.stdin.end('quit\n');
    } catch {}
    const m = meter;
    meter = null;
    setTimeout(() => {
      try {
        m.kill();
      } catch {}
    }, 1000);
  }

  // ---------- window ----------

  function open(page) {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (page) win.webContents.send('clips:page', page);
      return;
    }
    win = new BrowserWindow({
      width: 1240, height: 820, minWidth: 940, minHeight: 600, show: false, backgroundColor: '#1c2027',
      title: 'Glimpse Clips', icon: appIcon(), autoHideMenuBar: true, webPreferences: webPrefs(),
    });
    win.setMenu(null);
    noAnim(win);
    win.loadFile(UI('clips.html'), page ? { hash: page } : undefined);
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      win = null;
      stopMeter();
    });
  }

  // ---------- IPC ----------

  ipcMain.handle('clips:get', async () => {
    const s = getSettings();
    const avail = await probeEncoders(ffmpegBin());
    const displays = screen.getAllDisplays().map((d, i) => ({
      id: String(d.id), label: `${d.id === screen.getPrimaryDisplay().id ? 'Main screen' : `Screen ${i + 1}`}, ${Math.round(d.size.width * d.scaleFactor)} × ${Math.round(d.size.height * d.scaleFactor)}`,
    }));
    return { clips: cfg(), hotkeys: { ...HOTKEY_DEFAULTS, ...pick(s.hotkeys, Object.keys(HOTKEY_DEFAULTS)) }, encoders: avail, displays, status: status(), folder: clipsDir() };
  });
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

  ipcMain.handle('clips:set', async (_e, patch) => {
    const c = cfg();
    const next = withDefaults({ ...c, ...patch, video: { ...c.video, ...(patch.video || {}) }, audio: { ...c.audio, ...(patch.audio || {}) } });
    next.length = Math.max(10, Math.min(1200, Math.round(+next.length || 60)));
    next.shortLength = Math.max(5, Math.min(next.length, Math.round(+next.shortLength || 15)));
    setCfg(next);
    if ('startMode' in patch || 'startApps' in patch) watch();
    if (patch.video || patch.audio || 'length' in patch) {
      await restartIfChanged();
      if (meter && patch.audio) startMeter();
    }
    push();
    return { clips: next, status: status() };
  });

  ipcMain.handle('clips:hotkeys', (_e, patch) => {
    const s = getSettings();
    s.hotkeys = { ...s.hotkeys, ...patch };
    saveSettings(s);
    const failed = onHotkeysChanged();
    buildTrayMenu();
    return { hotkeys: { ...HOTKEY_DEFAULTS, ...pick(s.hotkeys, Object.keys(HOTKEY_DEFAULTS)) }, failed };
  });

  ipcMain.handle('clips:toggle', async (_e, on) => {
    await setEnabled(on);
    return status();
  });
  ipcMain.handle('clips:status', () => status());
  ipcMain.handle('clips:save', (_e, seconds) => save(seconds));
  ipcMain.handle('clips:record', () => toggleRecording());
  ipcMain.handle('clips:devices', async () => {
    const [list, wins] = await Promise.all([helperJSON(['--list']).catch(() => ({ render: [], capture: [], sessions: [] })), Promise.resolve(native.appWindows())]);
    const apps = new Map();
    for (const s of list.sessions || []) apps.set(s.exe.toLowerCase(), { exe: s.exe, name: appName(s.exe), title: s.title || '', sound: true });
    for (const w of wins) {
      if (!w.exe || /^(explorer|textinputhost|applicationframehost|systemsettings|shellexperiencehost)\.exe$/i.test(w.exe)) continue;
      const k = w.exe.toLowerCase();
      if (!apps.has(k)) apps.set(k, { exe: w.exe, name: appName(w.exe), title: w.title, sound: false });
      else if (!apps.get(k).title) apps.get(k).title = w.title;
    }
    return { render: list.render || [], capture: list.capture || [], apps: [...apps.values()] };
  });
  ipcMain.handle('clips:plan', async () => {
    const p = await plan();
    return { ...p.info, fps: p.fps, mbps: p.mbps, codec: p.codec, encoder: p.encoder, sources: p.audio.sources.map((s) => s.label), length: p.length };
  });
  ipcMain.on('clips:meter', (_e, on) => (on ? startMeter() : stopMeter()));
  ipcMain.handle('clips:list', () => scan());
  ipcMain.handle('clips:thumb', (_e, file) => thumb(file).catch(() => ''));
  ipcMain.handle('clips:probe', (_e, file) => probe(file));
  ipcMain.handle('clips:export', async (e, opts) => {
    try {
      const out = await exportClip(opts, e.sender);
      return { file: out };
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle('clips:action', async (_e, { file, action, name }) => {
    if (!file || !fs.existsSync(file)) return;
    switch (action) {
      case 'open': return shell.openPath(file);
      case 'folder': return shell.showItemInFolder(file);
      case 'copy': return ctx.copyFileToClipboard(file).then(() => toast('Clip copied', 'Paste it into Discord or any chat', { kind: 'success' }));
      case 'upload': return ctx.uploadFile(file);
      case 'delete': {
        await shell.trashItem(file);
        index = index.filter((x) => x.file !== file);
        saveIndex();
        return true;
      }
      case 'rename': {
        const to = path.join(path.dirname(file), safeName(name) + path.extname(file));
        if (fs.existsSync(to)) return { error: 'A clip with that name already exists' };
        fs.renameSync(file, to);
        const it = index.find((x) => x.file === file);
        if (it) it.file = to;
        saveIndex();
        return { file: to };
      }
    }
  });
  ipcMain.handle('clips:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win || undefined, { title: 'Choose where clips are saved', defaultPath: clipsDir(), properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled) return null;
    const c = cfg();
    c.folder = res.filePaths[0];
    setCfg(c);
    return c.folder;
  });
  ipcMain.on('clips:openFolder', () => shell.openPath(clipsDir()));
  ipcMain.on('open:clips', (_e, page) => open(page));

  app.on('will-quit', () => {
    replay.stop(true);
    stopMeter();
    if (recording.active) {
      try {
        recording.proc.stdin.write('q');
      } catch {}
    }
  });

  return {
    boot, open, save, toggle, toggleMic, status, toggleRecording, isRecording: () => recording.active, replay, plan, setEnabled, vkFor,
    saveShort: () => save(cfg().shortLength),
    saveFull: () => save(cfg().length),
    isOn: () => replay.state === 'on' || replay.state === 'starting',
    HOTKEY_DEFAULTS,
  };
};

module.exports.DEFAULTS = DEFAULTS;
module.exports.HOTKEY_DEFAULTS = HOTKEY_DEFAULTS;
module.exports.appName = appName;
module.exports.vkFor = vkFor;
