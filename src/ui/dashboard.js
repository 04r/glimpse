'use strict';
const api = window.glimpse;
const $ = (id) => document.getElementById(id);

$('folder').innerHTML = `${ICONS.folder}Open folder`;
$('settings').innerHTML = `${ICONS.gear}Settings`;
$('ic-gif').innerHTML = ICONS.gif;
$('ic-video').innerHTML = ICONS.video;
$('ic-full').innerHTML =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>';

$('shot').onclick = () => api.send('dash:capture', 'shot');
$('gif').onclick = () => api.send('dash:capture', 'gif');
$('video').onclick = () => api.send('dash:capture', 'video');
$('full').onclick = () => api.send('dash:capture', 'fullscreen');
$('folder').onclick = () => api.send('open:folder');
$('settings').onclick = () => api.send('open:settings');
$('all').onclick = () => api.send('open:history');

const keycaps = (acc) =>
  acc
    ? acc
        .split('+')
        .map((k) => `<span class="key">${k === 'PrintScreen' ? 'PrtSc' : k}</span>`)
        .join('')
    : '';

async function loadKeys() {
  const { settings } = await api.invoke('settings:get');
  const hk = settings.hotkeys;
  $('k-screenshot').innerHTML = keycaps(hk.screenshot);
  for (const id of ['gif', 'video', 'fullscreen']) {
    const el = $('k-' + id);
    el.innerHTML = hk[id] ? `<span class="keys">${keycaps(hk[id])}</span>` : 'No shortcut set';
  }
}

const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(t);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

async function loadRecent() {
  const all = await api.invoke('history:list');
  $('count').textContent = all.length ? String(all.length) : '';
  $('all').hidden = !all.length;
  const strip = $('strip');
  strip.textContent = '';
  if (!all.length) {
    strip.innerHTML =
      '<div class="empty">Your captures will show up here. Press <span class="key">PrtSc</span> anywhere to grab part of your screen.</div>';
    return;
  }
  for (const e of all.slice(0, 12)) {
    const b = document.createElement('button');
    b.className = 'thumb';
    b.title = 'Open';
    b.onclick = () => api.invoke('history:action', { id: e.id, action: 'open' });
    if (e.exists) {
      const m = document.createElement(e.type === 'video' ? 'video' : 'img');
      m.src = e.type === 'video' ? e.fileUrl + '#t=0.1' : e.fileUrl;
      if (e.type === 'video') {
        m.muted = true;
        m.preload = 'metadata';
      }
      b.append(m);
    }
    if (e.type !== 'image') {
      const c = document.createElement('span');
      c.className = 'chip ' + e.type;
      c.textContent = e.type === 'gif' ? 'GIF' : 'Video';
      b.append(c);
    }
    const w = document.createElement('span');
    w.className = 'when';
    w.textContent = ago(e.date);
    b.append(w);
    strip.append(b);
  }
}

api.on('history:changed', loadRecent);
api.on('dash:refresh', () => {
  loadKeys();
  loadRecent();
});
loadKeys();
loadRecent();
