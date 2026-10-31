'use strict';
const api = window.glimpse;
const $ = (id) => document.getElementById(id);

const HOTKEYS = [
  { id: 'screenshot', label: 'Capture an area', sub: 'Freeze the screen, select, mark up, share' },
  { id: 'fullscreen', label: 'Capture the whole screen', sub: 'Saves and copies the screen under the cursor' },
  { id: 'gif', label: 'Record a GIF', sub: 'Press again to stop' },
  { id: 'video', label: 'Record a video', sub: 'Press again to stop' },
];

let settings = null;
let recording = null; // hotkey id being recorded

const pretty = (acc) =>
  acc
    ? acc
        .split('+')
        .map((k) => `<span class="key">${k === 'PrintScreen' ? 'PrtSc' : k}</span>`)
        .join('<span class="plus">+</span>')
    : '<span class="none">Not set</span>';

// highlight the section in view
const main = document.getElementById('main');
main.addEventListener('scroll', () => {
  let current = 'shortcuts';
  for (const s of document.querySelectorAll('section')) if (s.offsetTop - main.scrollTop < 120) current = s.id;
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('on', a.getAttribute('href') === '#' + current);
});

function renderHotkeys(failed = []) {
  const box = $('hotkeys');
  box.textContent = '';
  for (const h of HOTKEYS) {
    const row = document.createElement('div');
    row.className = 'r';
    row.innerHTML = `<div class="l"><div>${h.label}</div><small>${h.sub}</small></div>`;
    const b = document.createElement('button');
    b.className = 'hk' + (recording === h.id ? ' rec' : '') + (failed.includes(h.id) ? ' bad' : '');
    b.innerHTML = recording === h.id ? 'Press the new keys' : pretty(settings.hotkeys[h.id]);
    b.onclick = () => startRecord(h.id);
    const x = document.createElement('button');
    x.className = 'x';
    x.title = 'Remove shortcut';
    x.innerHTML = ICONS.close;
    x.onclick = () => save({ hotkeys: { [h.id]: '' } });
    row.append(b, x);
    box.append(row);
  }
  $('hkWarn').hidden = !failed.length;
  $('hkWarn').textContent = failed.length
    ? `Another app already uses the keys for: ${failed.map((f) => HOTKEYS.find((h) => h.id === f).label.toLowerCase()).join(', ')}. Pick different keys.`
    : '';
}

function startRecord(id) {
  recording = recording === id ? null : id;
  api.send('settings:pauseHotkeys', !!recording);
  renderHotkeys();
}

const KEYMAP = {
  ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Escape: 'Esc', '+': 'Plus',
};

function keyName(e) {
  if (e.code === 'PrintScreen' || e.key === 'PrintScreen') return 'PrintScreen';
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (/^Numpad\d$/.test(e.code)) return 'num' + e.code.slice(6);
  if (/^F\d{1,2}$/.test(e.key)) return e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  return KEYMAP[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
}

function onKey(e) {
  if (!recording) return;
  e.preventDefault();
  if (e.type === 'keydown' && e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    recording = null;
    api.send('settings:pauseHotkeys', false);
    return renderHotkeys();
  }
  // PrintScreen only reports keyup on Windows
  if (e.type === 'keyup' && e.code !== 'PrintScreen') return;
  const k = keyName(e);
  if (!k) return;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (!mods.length && !/^(F\d{1,2}|PrintScreen|Pause|ScrollLock|Insert)$/.test(k)) return; // avoid plain letters
  const id = recording;
  recording = null;
  save({ hotkeys: { [id]: [...mods, k].join('+') } });
}
addEventListener('keydown', onKey, true);
addEventListener('keyup', onKey, true);

async function save(patch) {
  const res = await api.invoke('settings:set', patch);
  settings = res.settings;
  fill(res.failed);
}

function fill(failed) {
  renderHotkeys(failed);
  $('dir').textContent = settings.saveDir;
  for (const id of ['quickSave', 'openAfterUpload', 'showMagnifier', 'launchAtLogin']) $(id).checked = !!settings[id];
  for (const id of ['uploadHost', 'recordFps', 'gifFps', 'gifMaxWidth', 'maxRecordSeconds']) $(id).value = String(settings[id]);
}

for (const id of ['quickSave', 'openAfterUpload', 'showMagnifier', 'launchAtLogin']) {
  $(id).onchange = () => save({ [id]: $(id).checked });
}
$('uploadHost').onchange = () => save({ uploadHost: $('uploadHost').value });
for (const id of ['recordFps', 'gifFps', 'gifMaxWidth']) $(id).onchange = () => save({ [id]: +$(id).value });
$('maxRecordSeconds').onchange = () => {
  const v = Math.max(3, Math.min(600, Math.round(+$('maxRecordSeconds').value || 60)));
  save({ maxRecordSeconds: v });
};
$('pick').onclick = async () => {
  const dir = await api.invoke('settings:pickDir');
  if (dir) save({ saveDir: dir });
};

api.invoke('settings:get').then((res) => {
  settings = res.settings;
  fill(res.failed);
});
