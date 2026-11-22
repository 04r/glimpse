'use strict';
const api = window.glimpse;
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
};
const svg = (p, w = 18) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const IC = {
  lib: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 9 5 3-5 3Z"/>'),
  rep: svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>'),
  vid: svg('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/>'),
  aud: svg('<path d="M4 10v4"/><path d="M8 7v10"/><path d="M12 4v16"/><path d="M16 8v8"/><path d="M20 11v2"/>'),
  sav: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  clip: svg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>', 16),
};

let D = null; // { clips, hotkeys, encoders, displays, status, folder }
let devices = { render: [], capture: [], apps: [] };
let planInfo = null;
let page = 'library';

// ---------- helpers ----------
const fmtT = (s) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const fmtLen = (s) => (s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} s`);
const fmtDur = (s) => {
  s = Math.round(s || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtSize = (b) => (b > 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : `${(b / 1048576).toFixed(b > 104857600 ? 0 : 1)} MB`);
const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(t), today = new Date();
  if (d.toDateString() === today.toDateString()) return `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};
const keycaps = (acc) => (acc ? acc.split('+').map((k) => `<span class="key">${k === 'PrintScreen' ? 'PrtSc' : k}</span>`).join('') : '');
const initials = (name) => (name || '?').replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

function segBind(id, get, onPick) {
  const box = $(id);
  for (const b of box.querySelectorAll('button')) b.onclick = () => onPick(b.dataset.v);
  return () => {
    const v = String(get());
    for (const b of box.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === v);
  };
}

async function set(patch) {
  const res = await api.invoke('clips:set', patch);
  D.clips = res.clips;
  D.status = res.status;
  renderAll();
  refreshPlan();
}
const setV = (k, v) => set({ video: { [k]: v } });
const setA = (k, v) => set({ audio: { [k]: v } });

async function refreshPlan() {
  planInfo = await api.invoke('clips:plan');
  renderPlanText();
  if (page === 'audio') renderMeters();
}

// ---------- navigation ----------
$('ni-lib').innerHTML = IC.lib;
$('ni-rep').innerHTML = IC.rep;
$('ni-vid').innerHTML = IC.vid;
$('ni-aud').innerHTML = IC.aud;
$('ni-sav').innerHTML = IC.sav;
$('saveIc').innerHTML = IC.clip;
$('srchIc').innerHTML = ICONS.search;
$('srchIc2').innerHTML = ICONS.search;
$('openFolder').innerHTML = `${ICONS.folder}Open folder`;
$('back').innerHTML = `${IC.back}Library`;
$('pFolder').innerHTML = ICONS.folder;
$('pDelete').innerHTML = ICONS.trash;
$('pCopy').innerHTML = `${ICONS.copy}Copy`;
$('pUpload').innerHTML = `${ICONS.upload}Upload`;
$('appModalClose').innerHTML = ICONS.close;

function go(p) {
  if (p.startsWith('play:')) return openPlayerFile(p.slice(5));
  page = p;
  for (const s of $$('.page')) s.hidden = s.id !== `page-${p}`;
  for (const a of $$('nav a')) a.classList.toggle('on', a.dataset.page === p);
  api.send('clips:meter', p === 'audio');
  if (p === 'library') loadLibrary();
  if (p === 'audio' || p === 'video' || p === 'replay') loadDevices();
  if (p !== 'player') stopPlayer();
}
for (const a of $$('nav a')) a.onclick = (e) => {
  e.preventDefault();
  go(a.dataset.page);
};
api.on('clips:page', (p) => go(p));

// ---------- live status ----------
function renderStatus() {
  const s = D.status;
  const on = s.state === 'on', starting = s.state === 'starting', err = s.state === 'error';
  for (const d of [$('liveDot'), $('heroDot')]) d.className = 'dot' + (on ? ' on' : starting ? ' starting' : err ? ' error' : '');
  $('liveToggle').checked = $('heroToggle').checked = on || starting;
  $('saveNow').disabled = !on;
  $('saveKeys').innerHTML = keycaps(D.hotkeys.clipSave);
  const len = D.clips.length;
  $('liveSub').textContent = on ? `Keeping the last ${fmtLen(len)}` : starting ? 'Starting…' : err ? 'Stopped, see Instant replay' : 'Off';
  $('heroTitle').textContent = on ? 'Recording in the background' : starting ? 'Starting…' : err ? 'Stopped' : 'Off';
  $('heroSub').textContent = on
    ? `${D.hotkeys.clipSave ? D.hotkeys.clipSave.replace(/\+/g, ' + ') : 'Save clip'} saves the last ${fmtLen(len)}.`
    : 'Turn it on to start keeping the last moments.';
  $('heroErr').hidden = !(s.error && (err || starting));
  $('heroErr').textContent = s.error || '';
  const p = s.plan;
  $('heroStats').innerHTML = on && p
    ? `<span>Video</span><b>${p.width} × ${p.height}, ${p.fps} fps</b><span>Encoder</span><b>${p.encoderName}</b><span>Live</span><b>${s.stats ? `${Math.round(s.stats.fps)} fps${s.stats.drop ? `, ${s.stats.drop} dropped` : ''}` : '…'}</b><span>Kept</span><b>${fmtLen(Math.min(s.buffered, len))}</b>`
    : '';
  $('emptyKeys').innerHTML = D.hotkeys.clipSave ? keycaps(D.hotkeys.clipSave) : 'the save key';
  const r = s.recording;
  $('recBtn').classList.toggle('on', !!r);
  $('recTx').textContent = r ? `Stop recording ${fmtDur(r.seconds)}` : 'Record';
  $('recKeys').innerHTML = keycaps(D.hotkeys.recordToggle);
  $('recBtn').title = r ? 'Stop and save the recording' : 'Record until you press it again, with the same settings as clips';
}
$('recBtn').onclick = async () => {
  await api.invoke('clips:record');
  D.status = await api.invoke('clips:status');
  renderStatus();
};
async function toggleReplay(on) {
  D.status = await api.invoke('clips:toggle', on);
  renderStatus();
}
$('liveToggle').onchange = () => toggleReplay($('liveToggle').checked);
$('heroToggle').onchange = () => toggleReplay($('heroToggle').checked);
$('emptyOn').onclick = () => toggleReplay(true);
$('saveNow').onclick = () => api.invoke('clips:save');
api.on('clips:status', (s) => {
  D.status = s;
  renderStatus();
});
setInterval(async () => {
  if (D && (D.status.state === 'on' || D.status.state === 'starting' || D.status.recording)) {
    D.status = await api.invoke('clips:status');
    renderStatus();
  }
}, 2000);

function renderPlanText() {
  if (!planInfo) return;
  const p = planInfo;
  const mbMin = Math.round((p.mbps * 60) / 8 + (D.clips.audio.kbps * 60 * (p.sources.length > 1 && D.clips.audio.tracks === 'separate' ? 3 : 1)) / 8000);
  $('planbox').innerHTML = `${p.width} × ${p.height} · ${p.fps} fps<br>${p.codec.toUpperCase()} · ${p.mbps} Mbps · ${p.encoderName}<br>${p.sources.length ? p.sources.join(', ') : 'No sound'}`;
  $('vidSummary').textContent = `Right now clips are ${p.width} × ${p.height} at ${p.fps} fps, ${p.codec === 'h264' ? 'H.264' : p.codec.toUpperCase()} at ${p.mbps} Mbps with ${p.encoderName}. That is about ${mbMin} MB per minute of clip.${p.note ? ' ' + p.note + '.' : ''}`;
  $('diskNeed').textContent = `about ${fmtSize(mbMin * 1048576 * (D.clips.length / 60))}`;
  $('qualSub').textContent = `${p.mbps} Mbps at ${p.width} × ${p.height}, ${p.fps} fps`;
}

// ---------- instant replay page ----------
const LENS = [15, 30, 60, 120, 300, 600, 1200];
$('lenPresets').innerHTML = LENS.map((s) => `<button data-v="${s}">${fmtLen(s)}</button>`).join('');
const rLen = segBind('lenPresets', () => D.clips.length, (v) => set({ length: +v }));
$('length').oninput = () => ($('lengthV').textContent = fmtLen(+$('length').value));
$('length').onchange = () => set({ length: +$('length').value });
$('shortLength').onchange = () => set({ shortLength: +$('shortLength').value });
const rStart = segBind('startMode', () => D.clips.startMode, (v) => set({ startMode: v }));
const START_SUB = {
  remember: 'Turns back on when Glimpse starts if it was on when you left.',
  always: 'On whenever Glimpse is running.',
  apps: 'Turns on by itself while one of your games is running.',
  manual: 'Off when Glimpse starts. Turn it on here or with its key.',
};

const HOTKEYS = [
  { id: 'clipSave', label: 'Save clip', sub: 'Saves the whole replay length' },
  { id: 'clipShort', label: 'Save a short clip', sub: 'Saves just the short clip length' },
  { id: 'clipToggle', label: 'Turn instant replay on or off' },
  { id: 'recordToggle', label: 'Start or stop a full recording', sub: 'Records until you press it again, with the same settings' },
  { id: 'micMute', label: 'Mute my mic in clips', sub: 'Press again to unmute' },
];
let recordingKey = null, failedKeys = [];
function renderHotkeys() {
  const box = $('hotkeys');
  box.textContent = '';
  for (const h of HOTKEYS) {
    const row = el('div', { className: 'r' });
    row.innerHTML = `<div class="l"><div>${h.label}</div>${h.sub ? `<small>${h.sub}</small>` : ''}</div>`;
    const b = el('button', { className: 'hk' + (recordingKey === h.id ? ' rec' : '') + (failedKeys.includes(h.id) ? ' bad' : '') });
    b.innerHTML = recordingKey === h.id ? 'Press the new keys' : D.hotkeys[h.id] ? keycaps(D.hotkeys[h.id]).replace(/<\/span><span/g, '</span><span class="plus">+</span><span') : '<span class="none">Not set</span>';
    b.onclick = () => {
      recordingKey = recordingKey === h.id ? null : h.id;
      api.send('settings:pauseHotkeys', !!recordingKey);
      renderHotkeys();
    };
    const x = el('button', { className: 'x', title: 'Remove key', innerHTML: ICONS.close });
    x.onclick = () => saveKey(h.id, '');
    row.append(b, x);
    box.append(row);
  }
  $('hkWarn').hidden = !failedKeys.length;
  $('hkWarn').textContent = failedKeys.length ? `Another app already uses the keys for: ${failedKeys.map((f) => HOTKEYS.find((h) => h.id === f)?.label.toLowerCase() || f).join(', ')}. Pick different keys.` : '';
}
async function saveKey(id, acc) {
  recordingKey = null;
  const res = await api.invoke('clips:hotkeys', { [id]: acc });
  D.hotkeys = res.hotkeys;
  failedKeys = res.failed.filter((f) => HOTKEYS.some((h) => h.id === f));
  renderHotkeys();
  renderStatus();
}
const KEYMAP = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', '+': 'Plus' };
function keyName(e) {
  if (e.code === 'PrintScreen' || e.key === 'PrintScreen') return 'PrintScreen';
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (/^Numpad\d$/.test(e.code)) return 'num' + e.code.slice(6);
  if (/^F\d{1,2}$/.test(e.key)) return e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  return KEYMAP[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
}

// ---------- push to talk key ----------
let pttListening = false;
function vkFor(code, button) {
  if (button === 3) return 0x05;
  if (button === 4) return 0x06;
  if (button === 1) return 0x04;
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit\d$/.test(code)) return 0x30 + +code[5];
  const f = /^F(\d{1,2})$/.exec(code);
  if (f) return 0x6f + +f[1];
  const map = {
    CapsLock: 0x14, Space: 0x20, Tab: 0x09, Backquote: 0xc0, ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3,
    AltLeft: 0xa4, AltRight: 0xa5, Insert: 0x2d, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
    Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64, Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69,
    Minus: 0xbd, Equal: 0xbb, BracketLeft: 0xdb, BracketRight: 0xdd, Backslash: 0xdc, Semicolon: 0xba, Quote: 0xde, Comma: 0xbc, Period: 0xbe, Slash: 0xbf,
  };
  return map[code] || 0;
}
$('mPtt').onclick = () => {
  pttListening = !pttListening;
  renderAudio();
};
addEventListener('mousedown', (e) => {
  if (!pttListening || e.target === $('mPtt') && e.button === 0) return;
  if (e.button === 0 || e.button === 2) return;
  e.preventDefault();
  pttListening = false;
  setA('pttKey', { vk: vkFor('', e.button), label: e.button === 3 ? 'Mouse back' : e.button === 4 ? 'Mouse forward' : 'Middle mouse' });
});

addEventListener('keydown', onKey, true);
addEventListener('keyup', onKey, true);
function onKey(e) {
  if (pttListening) {
    e.preventDefault();
    if (e.type !== 'keydown') return;
    pttListening = false;
    if (e.key === 'Escape') return renderAudio();
    const vk = vkFor(e.code);
    if (!vk) return renderAudio();
    const label = e.code.replace(/^Key|^Digit/, '').replace(/Left$|Right$/, (m) => ` (${m.toLowerCase()})`);
    return setA('pttKey', { vk, label });
  }
  if (recordingKey) {
    e.preventDefault();
    if (e.type === 'keydown' && e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      recordingKey = null;
      api.send('settings:pauseHotkeys', false);
      return renderHotkeys();
    }
    if (e.type === 'keyup' && e.code !== 'PrintScreen') return;
    const k = keyName(e);
    if (!k) return;
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    if (!mods.length && !/^(F\d{1,2}|PrintScreen|Pause|ScrollLock|Insert|Home|End|PageUp|PageDown|num\d)$/.test(k)) return;
    return saveKey(recordingKey, [...mods, k].join('+'));
  }
  if (page === 'player' && e.type === 'keydown') playerKey(e);
}

// start apps
function renderAppList(box, list, opts) {
  box.textContent = '';
  box.dataset.empty = opts.empty || '';
  list.forEach((a, i) => {
    const exe = typeof a === 'string' ? a : a.exe;
    const name = (typeof a === 'string' ? '' : a.name) || nameOf(exe);
    const row = el('div', { className: 'app' });
    row.innerHTML = `<div class="av">${initials(name)}</div><div class="nm"><b>${name}</b><small>${exe}</small></div>`;
    if (opts.volume) {
      const sl = el('div', { className: 'slide' });
      const r = el('input', { type: 'range', min: 0, max: 200, step: 5, value: a.volume == null ? 100 : a.volume });
      const v = el('b', { className: 'readout', textContent: `${r.value}%` });
      r.oninput = () => (v.textContent = `${r.value}%`);
      r.onchange = () => opts.onVolume(i, +r.value);
      sl.append(r, v);
      row.append(sl);
    }
    const x = el('button', { className: 'x', title: 'Remove', innerHTML: ICONS.close });
    x.onclick = () => opts.onRemove(i);
    row.append(x);
    box.append(row);
  });
}
const nameOf = (exe) => {
  const known = devices.apps.find((a) => a.exe.toLowerCase() === (exe || '').toLowerCase());
  return known ? known.name : (exe || '').replace(/\.exe$/i, '');
};

function renderReplay() {
  rLen();
  rStart();
  $('length').value = D.clips.length;
  $('lengthV').textContent = fmtLen(D.clips.length);
  $('shortLength').value = String(D.clips.shortLength);
  $('startModeSub').textContent = START_SUB[D.clips.startMode];
  $('startAppsRow').hidden = D.clips.startMode !== 'apps';
  renderAppList($('startApps'), D.clips.startApps || [], {
    empty: 'No games yet. Add the ones you play.',
    onRemove: (i) => set({ startApps: D.clips.startApps.filter((_, k) => k !== i) }),
  });
  renderHotkeys();
}
$('addStartApp').onclick = () => pickApp('Add a game or app', (a) => {
  if (!D.clips.startApps.some((x) => x.toLowerCase() === a.exe.toLowerCase())) set({ startApps: [...D.clips.startApps, a.exe] });
});

// ---------- video page ----------
const rTarget = segBind('vTarget', () => D.clips.video.target, (v) => setV('target', v));
const rQual = segBind('vQuality', () => D.clips.video.quality, (v) => setV('quality', v));
const rFps = segBind('vFps', () => D.clips.video.fps, (v) => setV('fps', +v));
const rCodec = segBind('vCodec', () => D.clips.video.codec, (v) => setV('codec', v));
const rRc = segBind('vRc', () => D.clips.video.rc, (v) => setV('rc', v));
$('vDisplay').onchange = () => setV('display', $('vDisplay').value);
$('vWindow').onchange = () => setV('windowExe', $('vWindow').value);
$('vWindowRefresh').onclick = () => loadDevices();
$('vCursor').onchange = () => setV('cursor', $('vCursor').checked);
$('vRes').onchange = () => setV('resolution', $('vRes').value);
$('vEncoder').onchange = () => setV('encoder', $('vEncoder').value);
$('vPreset').onchange = () => setV('preset', $('vPreset').value);
$('vMbps').oninput = () => ($('vMbpsV').textContent = `${$('vMbps').value} Mbps`);
$('vMbps').onchange = () => setV('mbps', +$('vMbps').value);
$('vCq').oninput = () => ($('vCqV').textContent = $('vCq').value);
$('vCq').onchange = () => setV('cq', +$('vCq').value);
const ENC_NAMES = { nvenc: 'NVIDIA NVENC', amf: 'AMD AMF', qsv: 'Intel Quick Sync', cpu: 'CPU (x264 / x265)' };

function renderVideo() {
  const v = D.clips.video;
  rTarget();
  rQual();
  rFps();
  rCodec();
  rRc();
  $('vDisplayRow').hidden = v.target !== 'screen';
  $('vWindowRow').hidden = v.target !== 'window';
  $('vDisplay').innerHTML = `<option value="primary">Main screen</option><option value="cursor">Where the mouse is</option>` +
    D.displays.map((d) => `<option value="${d.id}">${d.label}</option>`).join('');
  $('vDisplay').value = v.display;
  const wins = devices.apps.filter((a) => a.title);
  const opts = wins.map((a) => `<option value="${a.exe}">${a.name}${a.title && a.title !== a.name ? ` (${a.title.slice(0, 50)})` : ''}</option>`);
  if (v.windowExe && !wins.some((a) => a.exe.toLowerCase() === v.windowExe.toLowerCase())) opts.unshift(`<option value="${v.windowExe}">${nameOf(v.windowExe)} (not open)</option>`);
  $('vWindow').innerHTML = `<option value="">Choose an app</option>${opts.join('')}`;
  $('vWindow').value = v.windowExe || '';
  $('vCursor').checked = !!v.cursor;
  $('vMbpsRow').hidden = v.quality !== 'custom';
  $('vMbps').value = v.mbps;
  $('vMbpsV').textContent = `${v.mbps} Mbps`;
  $('vRes').value = v.resolution;
  for (const b of $$('#vCodec button')) b.disabled = !D.encoders.some((e) => e.endsWith(':' + b.dataset.v));
  for (const b of $$('#vFps button')) b.title = `${b.dataset.v} frames per second`;
  const encs = [...new Set(D.encoders.filter((e) => e.endsWith(':' + v.codec)).map((e) => e.split(':')[0]))];
  $('vEncoder').innerHTML = `<option value="auto">Automatic (best available)</option>` + encs.map((e) => `<option value="${e}">${ENC_NAMES[e]}</option>`).join('');
  $('vEncoder').value = encs.includes(v.encoder) ? v.encoder : 'auto';
  $('vCqRow').hidden = v.rc !== 'cq';
  $('vCq').value = v.cq;
  $('vCqV').textContent = v.cq;
  $('rcSub').textContent = { vbr: 'Uses more bits in busy scenes and fewer in calm ones. Best for most', cbr: 'Same bitrate all the time. Predictable file size', cq: 'Keeps the look steady, file size varies' }[v.rc];
  const enc = v.encoder === 'auto' ? (encs[0] || 'cpu') : v.encoder;
  $('vPresetRow').hidden = enc !== 'nvenc';
  $('vPreset').value = v.preset || 'p4';
}

// ---------- audio page ----------
const rMode = segBind('aMode', () => D.clips.audio.appMode, (v) => setA('appMode', v));
const rMic = segBind('mMode', () => D.clips.audio.micMode, (v) => setA('micMode', v));
const rTracks = segBind('aTracks', () => D.clips.audio.tracks, (v) => setA('tracks', v));
$('aSystem').onchange = () => setA('system', $('aSystem').checked);
$('aDevice').onchange = () => setA('systemDevice', $('aDevice').value);
$('aExcept').onchange = () => setA('exceptApp', $('aExcept').value);
$('mOn').onchange = () => setA('mic', $('mOn').checked);
$('mDevice').onchange = () => setA('micDevice', $('mDevice').value);
$('mDenoise').onchange = () => setA('denoise', $('mDenoise').checked);
$('mGate').onchange = () => setA('gate', $('mGate').checked);
$('aKbps').onchange = () => setA('kbps', +$('aKbps').value);
for (const [id, key, fmt] of [
  ['aVol', 'systemVolume', (v) => `${v}%`], ['mVol', 'micVolume', (v) => `${v}%`], ['mGateDb', 'gateDb', (v) => `${v} dB`],
  ['aOffset', 'offsetMs', (v) => (+v === 0 ? 'none' : `${v > 0 ? '+' : ''}${v} ms`)],
]) {
  $(id).oninput = () => ($(id + 'V').textContent = fmt($(id).value));
  $(id).onchange = () => setA(key, +$(id).value);
}
$('aAddApp').onclick = () => pickApp('Add an app to record', (a) => {
  const apps = D.clips.audio.apps || [];
  if (!apps.some((x) => x.exe.toLowerCase() === a.exe.toLowerCase())) setA('apps', [...apps, { exe: a.exe, name: a.name, volume: 100 }]);
});

function renderAudio() {
  const A = D.clips.audio;
  rMode();
  rMic();
  rTracks();
  $('aSystem').checked = !!A.system;
  for (const id of ['aWhichRow', 'aDeviceRow', 'aVolRow']) $(id).style.opacity = A.system ? '' : '0.4';
  for (const id of ['aWhichRow', 'aDeviceRow', 'aVolRow']) $(id).style.pointerEvents = A.system ? '' : 'none';
  $('aAppsRow').hidden = !A.system || A.appMode !== 'only';
  $('aExceptRow').hidden = !A.system || A.appMode !== 'except';
  $('aDeviceRow').hidden = A.system && A.appMode !== 'all';
  $('aVolRow').hidden = A.system && A.appMode === 'only';
  $('aWhichSub').textContent = {
    all: 'Everything that plays on your speakers or headset',
    only: 'Just the apps below, each with its own volume. Great for keeping music and calls out',
    except: 'Everything you hear, minus one app',
  }[A.appMode];
  renderAppList($('aApps'), A.apps || [], {
    empty: 'No apps yet. Add your game, and anything else you want to hear.',
    volume: true,
    onVolume: (i, v) => setA('apps', A.apps.map((x, k) => (k === i ? { ...x, volume: v } : x))),
    onRemove: (i) => setA('apps', A.apps.filter((_, k) => k !== i)),
  });
  const exOpts = devices.apps.map((a) => `<option value="${a.exe}">${a.name}${a.sound ? ' (playing sound)' : ''}</option>`);
  if (A.exceptApp && !devices.apps.some((a) => a.exe.toLowerCase() === A.exceptApp.toLowerCase())) exOpts.unshift(`<option value="${A.exceptApp}">${nameOf(A.exceptApp)}</option>`);
  $('aExcept').innerHTML = `<option value="">Choose an app</option>${exOpts.join('')}`;
  $('aExcept').value = A.exceptApp || '';
  $('aDevice').innerHTML = `<option value="default">Windows default (follows changes)</option>` + devices.render.map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
  $('aDevice').value = A.systemDevice || 'default';
  $('aVol').value = A.systemVolume;
  $('aVolV').textContent = `${A.systemVolume}%`;
  $('mOn').checked = !!A.mic;
  for (const r of $$('[data-mic]')) r.classList.toggle('off', !A.mic);
  $('mDevice').innerHTML = `<option value="default">Windows default (follows changes)</option>` + devices.capture.map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
  $('mDevice').value = A.micDevice || 'default';
  $('mVol').value = A.micVolume;
  $('mVolV').textContent = `${A.micVolume}%`;
  $('mPttRow').hidden = A.micMode !== 'ptt';
  $('mPtt').classList.toggle('rec', pttListening);
  $('mPtt').innerHTML = pttListening ? 'Press a key or a side mouse button' : A.pttKey ? `<span class="key">${A.pttKey.label}</span>` : '<span class="none">Pick a key</span>';
  $('mDenoise').checked = !!A.denoise;
  $('mGate').checked = !!A.gate;
  $('mGateRow').hidden = !A.gate;
  $('mGateDb').value = A.gateDb;
  $('mGateDbV').textContent = `${A.gateDb} dB`;
  $('aKbps').value = String(A.kbps);
  $('aOffset').value = A.offsetMs;
  $('aOffsetV').textContent = +A.offsetMs === 0 ? 'none' : `${A.offsetMs > 0 ? '+' : ''}${A.offsetMs} ms`;
  renderMeters();
}

// live meters: one row per sound source in the plan
let meterEls = [];
function renderMeters() {
  const box = $('meters');
  box.textContent = '';
  meterEls = [];
  const names = planInfo ? planInfo.sources : [];
  for (const n of names) {
    const row = el('div', { className: 'meter' });
    const bar = el('div', { className: 'lvl live' });
    const fill = el('i');
    bar.append(fill);
    const val = el('b', { textContent: '' });
    row.append(el('span', { textContent: n, title: n }), bar, val);
    box.append(row);
    meterEls.push({ fill, val, peak: -100, bar });
  }
}
api.on('clips:levels', (levels) => {
  levels.forEach((db, i) => {
    const m = meterEls[i];
    if (!m) return;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    m.peak = Math.max(db, m.peak - 1.5);
    m.fill.style.width = pct + '%';
    m.fill.style.setProperty('--full', `${m.bar.clientWidth}px`);
    m.val.textContent = db <= -99 ? 'silent' : `${Math.round(m.peak)} dB`;
  });
});

// ---------- saving page ----------
const rCont = segBind('container', () => D.clips.container, (v) => set({ container: v }));
$('perApp').onchange = () => set({ perAppFolders: $('perApp').checked });
$('notify').onchange = () => set({ notify: $('notify').checked });
$('sound').onchange = () => set({ sound: $('sound').checked });
$('pickFolder').onclick = async () => {
  const f = await api.invoke('clips:pickFolder');
  if (f) {
    D.folder = f;
    renderSaving();
  }
};
function renderSaving() {
  rCont();
  $('folder').textContent = D.folder;
  $('perApp').checked = !!D.clips.perAppFolders;
  $('notify').checked = !!D.clips.notify;
  $('sound').checked = !!D.clips.sound;
}

// ---------- app picker ----------
let pickCb = null;
function pickApp(title, cb) {
  pickCb = cb;
  $('appModalTitle').textContent = title;
  $('appQ').value = '';
  $('appModal').hidden = false;
  loadDevices().then(renderPick);
  renderPick();
  $('appQ').focus();
}
function renderPick() {
  const q = $('appQ').value.trim().toLowerCase();
  const list = devices.apps.filter((a) => !q || a.name.toLowerCase().includes(q) || a.exe.toLowerCase().includes(q) || (a.title || '').toLowerCase().includes(q));
  list.sort((a, b) => b.sound - a.sound || a.name.localeCompare(b.name));
  const box = $('appPick');
  box.textContent = '';
  box.dataset.empty = 'Nothing running matches. Type the file name, for example game.exe, and press Add.';
  for (const a of list) {
    const row = el('div', { className: 'app' });
    row.innerHTML = `<div class="av">${initials(a.name)}</div><div class="nm"><b>${a.name}</b><small>${a.exe}${a.title && a.title !== a.name ? ` · ${a.title}` : ''}</small></div>${a.sound ? '<span class="tag">Playing sound</span>' : ''}`;
    row.onclick = () => choose(a);
    box.append(row);
  }
  $('appAddTyped').hidden = !/\.exe$/i.test(q) && !(q && !list.length);
}
function choose(a) {
  $('appModal').hidden = true;
  if (pickCb) pickCb(a);
}
$('appQ').oninput = renderPick;
$('appQ').onkeydown = (e) => {
  if (e.key === 'Enter' && !$('appAddTyped').hidden) $('appAddTyped').click();
  if (e.key === 'Escape') $('appModal').hidden = true;
};
$('appAddTyped').onclick = () => {
  let exe = $('appQ').value.trim();
  if (!/\.exe$/i.test(exe)) exe += '.exe';
  choose({ exe, name: exe.replace(/\.exe$/i, '') });
};
$('appModalClose').onclick = () => ($('appModal').hidden = true);
$('appModal').onclick = (e) => e.target === $('appModal') && ($('appModal').hidden = true);

async function loadDevices() {
  devices = await api.invoke('clips:devices');
  if (page === 'audio') renderAudio();
  if (page === 'video') renderVideo();
  if (page === 'replay') renderReplay();
}

// ---------- library ----------
let clipsList = [];
let appFilter = '';
const thumbCache = new Map();
$('q').oninput = renderLibrary;
$('sort').onchange = renderLibrary;
$('openFolder').onclick = () => api.send('clips:openFolder');
api.on('clips:changed', () => page === 'library' && loadLibrary());

async function loadLibrary() {
  clipsList = await api.invoke('clips:list');
  renderLibrary();
}
function renderLibrary() {
  const apps = new Map();
  for (const c of clipsList) apps.set(c.app, (apps.get(c.app) || 0) + 1);
  if (appFilter && !apps.has(appFilter)) appFilter = '';
  const chips = $('appChips');
  chips.textContent = '';
  if (apps.size > 1) {
    const all = el('button', { className: 'chip' + (!appFilter ? ' on' : ''), innerHTML: `All<b>${clipsList.length}</b>` });
    all.onclick = () => ((appFilter = ''), renderLibrary());
    chips.append(all);
    for (const [a, n] of [...apps].sort((x, y) => y[1] - x[1])) {
      const b = el('button', { className: 'chip' + (appFilter === a ? ' on' : ''), innerHTML: `${a}<b>${n}</b>` });
      b.onclick = () => ((appFilter = a), renderLibrary());
      chips.append(b);
    }
  }
  const q = $('q').value.trim().toLowerCase();
  let list = clipsList.filter((c) => (!appFilter || c.app === appFilter) && (!q || c.name.toLowerCase().includes(q) || c.app.toLowerCase().includes(q)));
  const s = $('sort').value;
  list = list.slice().sort((a, b) => (s === 'old' ? a.created - b.created : s === 'big' ? b.size - a.size : s === 'long' ? b.seconds - a.seconds : b.created - a.created));
  $('libCount').textContent = clipsList.length ? String(clipsList.length) : '';
  $('libEmpty').hidden = clipsList.length > 0;
  const grid = $('grid');
  grid.textContent = '';
  for (const c of list) {
    const card = el('button', { className: 'card' });
    const th = el('div', { className: 'th' });
    const img = el('img', { alt: '' });
    th.append(img);
    if (c.seconds) th.append(el('span', { className: 'dur', textContent: fmtDur(c.seconds) }));
    th.append(el('span', { className: 'badge', textContent: c.app }));
    card.append(th);
    const meta = el('div', { className: 'meta' });
    meta.append(el('b', { textContent: ago(c.created) }), el('small', { textContent: fmtSize(c.size) }));
    card.append(meta);
    card.title = c.name;
    card.onclick = () => openPlayer(c);
    // hover preview
    let pv = null;
    card.onmouseenter = () => {
      pv = el('video', { src: c.url, muted: true, loop: true, playsInline: true });
      pv.muted = true;
      pv.currentTime = Math.min(2, (c.seconds || 4) / 3);
      pv.oncanplay = () => pv && pv.classList.add('show');
      th.insertBefore(pv, th.children[1]);
      pv.play().catch(() => {});
    };
    card.onmouseleave = () => {
      if (pv) {
        pv.pause();
        pv.removeAttribute('src');
        pv.load();
        pv.remove();
        pv = null;
      }
    };
    grid.append(card);
    if (thumbCache.has(c.file)) img.src = thumbCache.get(c.file);
    else api.invoke('clips:thumb', c.file).then((u) => {
      if (u) {
        thumbCache.set(c.file, u);
        img.src = u;
      }
    });
  }
}

// ---------- player ----------
const vid = $('vid');
let cur = null; // the clip being watched
let dur = 0, tIn = 0, tOut = 0;
let expKind = 'copy';
const rExp = segBind('expKind', () => expKind, (v) => {
  expKind = v;
  rExp();
  $('expSize').hidden = v !== 'small';
  $('expTrack').hidden = v === 'gif';
});
$('back').onclick = () => go('library');

async function openPlayerFile(file) {
  if (!clipsList.length) clipsList = await api.invoke('clips:list');
  const c = clipsList.find((x) => x.file.toLowerCase() === file.toLowerCase());
  if (c) openPlayer(c);
  else go('library');
}

async function openPlayer(c) {
  cur = c;
  page = 'player';
  for (const s of $$('.page')) s.hidden = s.id !== 'page-player';
  for (const a of $$('nav a')) a.classList.toggle('on', a.dataset.page === 'library');
  api.send('clips:meter', false);
  $('pName').value = c.name;
  $('pMeta').textContent = `${c.app} · ${ago(c.created)} · ${fmtSize(c.size)}`;
  $('expProg').hidden = true;
  vid.src = c.url;
  vid.currentTime = 0;
  $('film').textContent = '';
  const info = await api.invoke('clips:probe', c.file);
  if (cur !== c) return;
  dur = info.duration || c.seconds || 0;
  tIn = 0;
  tOut = dur;
  $('pMeta').textContent = `${c.app} · ${ago(c.created)} · ${info.width} × ${info.height}${info.fps ? `, ${Math.round(info.fps)} fps` : ''} · ${fmtSize(c.size)}`;
  const tracks = info.tracks.length ? info.tracks : [];
  $('track').innerHTML = tracks.length ? tracks.map((t, i) => `<option value="${i}">${t}</option>`).join('') : '<option value="-1">No sound</option>';
  $('track').disabled = tracks.length < 2;
  $('expTrack').innerHTML = (tracks.length > 1 ? `<option value="all">Keep all sound tracks</option>` : '') +
    tracks.map((t, i) => `<option value="${i}">Sound: ${t}</option>`).join('') + `<option value="none">No sound</option>`;
  $('expTrack').value = tracks.length > 1 ? 'all' : tracks.length ? '0' : 'none';
  drawTrim();
  vid.play().catch(() => {});
  filmstrip(c);
}

// a row of frames along the timeline, grabbed from a hidden video
async function filmstrip(c) {
  const box = $('film');
  const n = Math.max(6, Math.min(14, Math.floor($('tl').clientWidth / 110)));
  const v = el('video', { src: c.url, muted: true, preload: 'auto' });
  await new Promise((r) => (v.onloadeddata = r));
  const cv = el('canvas', { width: 192, height: 108 });
  const x = cv.getContext('2d');
  for (let i = 0; i < n && cur === c; i++) {
    v.currentTime = ((i + 0.5) / n) * v.duration;
    await new Promise((r) => (v.onseeked = r));
    x.drawImage(v, 0, 0, cv.width, cv.height);
    box.append(el('img', { src: cv.toDataURL('image/jpeg', 0.7) }));
  }
  v.removeAttribute('src');
  v.load();
}

function stopPlayer() {
  if (!vid.paused) vid.pause();
}

vid.addEventListener('loadedmetadata', () => {
  if (!dur) {
    dur = vid.duration;
    tOut = dur;
  }
  selectTrack();
  drawTrim();
});
function selectTrack() {
  const i = +$('track').value;
  const at = vid.audioTracks;
  if (at && at.length) for (let k = 0; k < at.length; k++) at[k].enabled = k === i;
}
$('track').onchange = selectTrack;
$('rate').onchange = () => (vid.playbackRate = +$('rate').value);
$('vol').oninput = () => (vid.volume = +$('vol').value);

const playIcon = ICONS.play, pauseIcon = ICONS.pause;
function syncPlay() {
  $('pp').innerHTML = vid.paused ? playIcon : pauseIcon;
  $('bigPlay').innerHTML = vid.paused ? playIcon : '';
  $('bigPlay').hidden = !vid.paused;
}
vid.addEventListener('play', syncPlay);
vid.addEventListener('pause', syncPlay);
syncPlay();
const togglePlay = () => {
  if (vid.paused) {
    if (vid.currentTime >= tOut - 0.05 || vid.currentTime < tIn) vid.currentTime = tIn;
    vid.play();
  } else vid.pause();
};
$('pp').onclick = togglePlay;
vid.onclick = togglePlay;

// keep playback inside the trimmed part
function tick() {
  if (page === 'player' && dur) {
    if (!vid.paused && vid.currentTime >= tOut) {
      vid.pause();
      vid.currentTime = tOut;
    }
    $('playhead').style.left = `${(vid.currentTime / dur) * 100}%`;
    $('tc').textContent = `${fmtT(vid.currentTime)} / ${fmtT(dur)}`;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function drawTrim() {
  if (!dur) return;
  const a = (tIn / dur) * 100, b = (tOut / dur) * 100;
  $('shadeL').style.width = a + '%';
  $('shadeR').style.width = 100 - b + '%';
  $('selBox').style.left = a + '%';
  $('selBox').style.width = b - a + '%';
  $('hIn').style.left = a + '%';
  $('hOut').style.left = b + '%';
  $('tIn').textContent = fmtT(tIn);
  $('tOut').textContent = fmtT(tOut);
  $('tLen').textContent = fmtT(tOut - tIn);
}
const tAt = (clientX) => {
  const r = $('tl').getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * dur;
};
function dragger(target, onMove) {
  target.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onMove(tAt(e.clientX));
    const mv = (ev) => onMove(tAt(ev.clientX));
    const up = () => {
      removeEventListener('mousemove', mv);
      removeEventListener('mouseup', up);
    };
    addEventListener('mousemove', mv);
    addEventListener('mouseup', up);
  });
}
dragger($('hIn'), (t) => {
  tIn = Math.min(t, tOut - 0.2);
  vid.currentTime = tIn;
  drawTrim();
});
dragger($('hOut'), (t) => {
  tOut = Math.max(t, tIn + 0.2);
  vid.currentTime = tOut;
  drawTrim();
});
dragger($('tl'), (t) => (vid.currentTime = t));
$('setIn').onclick = () => {
  tIn = Math.min(vid.currentTime, tOut - 0.2);
  drawTrim();
};
$('setOut').onclick = () => {
  tOut = Math.max(vid.currentTime, tIn + 0.2);
  drawTrim();
};
$('resetTrim').onclick = () => {
  tIn = 0;
  tOut = dur;
  drawTrim();
};
function playerKey(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const step = 1 / 60;
  if (e.code === 'Space') togglePlay();
  else if (e.key === 'i' || e.key === 'I') $('setIn').click();
  else if (e.key === 'o' || e.key === 'O') $('setOut').click();
  else if (e.key === 'ArrowLeft') vid.currentTime = Math.max(0, vid.currentTime - (e.shiftKey ? 5 : 1));
  else if (e.key === 'ArrowRight') vid.currentTime = Math.min(dur, vid.currentTime + (e.shiftKey ? 5 : 1));
  else if (e.key === ',') (vid.pause(), (vid.currentTime = Math.max(0, vid.currentTime - step)));
  else if (e.key === '.') (vid.pause(), (vid.currentTime = Math.min(dur, vid.currentTime + step)));
  else if (e.key === 'Escape') go('library');
  else return;
  e.preventDefault();
}

$('pName').onkeydown = (e) => e.key === 'Enter' && $('pName').blur();
$('pName').onchange = async () => {
  const name = $('pName').value.trim();
  if (!name || !cur || name === cur.name) return;
  vid.pause();
  const keep = vid.currentTime;
  vid.removeAttribute('src');
  vid.load();
  const res = await api.invoke('clips:action', { file: cur.file, action: 'rename', name });
  if (res && res.file) {
    clipsList = await api.invoke('clips:list');
    const c = clipsList.find((x) => x.file === res.file);
    if (c) {
      cur = c;
      vid.src = c.url;
      vid.currentTime = keep;
    }
  } else {
    $('pName').value = cur.name;
    vid.src = cur.url;
    if (res && res.error) alert(res.error);
  }
};
$('pFolder').onclick = () => cur && api.invoke('clips:action', { file: cur.file, action: 'folder' });
$('pCopy').onclick = () => cur && api.invoke('clips:action', { file: cur.file, action: 'copy' });
$('pUpload').onclick = () => cur && api.invoke('clips:action', { file: cur.file, action: 'upload' });
$('pDelete').onclick = async () => {
  if (!cur || !confirm(`Move “${cur.name}” to the Recycle Bin?`)) return;
  vid.pause();
  vid.removeAttribute('src');
  vid.load();
  await api.invoke('clips:action', { file: cur.file, action: 'delete' });
  go('library');
};
api.on('clips:progress', (f) => ($('expBar').style.width = `${Math.round(f * 100)}%`));
$('expGo').onclick = async () => {
  if (!cur) return;
  $('expGo').disabled = true;
  $('expProg').hidden = false;
  $('expBar').style.width = '0%';
  const res = await api.invoke('clips:export', {
    file: cur.file, start: tIn, end: tOut, kind: expKind, track: $('expTrack').value, targetMB: +$('expSize').value,
  });
  $('expGo').disabled = false;
  $('expProg').hidden = true;
  if (res.error) return alert(`Export failed: ${res.error}`);
  clipsList = await api.invoke('clips:list');
  const c = clipsList.find((x) => x.file === res.file);
  if (c && /\.mp4$/i.test(c.file)) {
    if (confirm(`Saved “${c.name}”. Open it now?`)) openPlayer(c);
  } else if (res.file) api.invoke('clips:action', { file: res.file, action: 'folder' });
};

// ---------- boot ----------
function renderAll() {
  renderStatus();
  renderReplay();
  renderVideo();
  renderAudio();
  renderSaving();
}

(async () => {
  D = await api.invoke('clips:get');
  failedKeys = [];
  renderAll();
  await refreshPlan();
  renderMeters();
  const start = decodeURIComponent(location.hash.slice(1)) || 'library';
  go(start);
  loadDevices();
})();
