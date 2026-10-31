'use strict';
const api = window.glimpse;
const $ = (id) => document.getElementById(id);
let filter = 'all';

$('folder').innerHTML = `${ICONS.folder}Open folder`;
$('folder').onclick = () => api.send('open:folder');
$('clear').onclick = () => api.invoke('history:clear');
document.querySelectorAll('#filters button').forEach((b) => {
  b.onclick = () => {
    filter = b.dataset.f;
    document.querySelectorAll('#filters button').forEach((x) => x.classList.toggle('on', x === b));
    render();
  };
});

const fmtSize = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], {
    weekday: 'long', month: 'long', day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function act(id, action) {
  return api.invoke('history:action', { id, action });
}

function actBtn(icon, title, action, id, cls = '') {
  const b = el('button', { title, className: cls });
  b.innerHTML = icon;
  b.onclick = (e) => {
    e.stopPropagation();
    act(id, action);
  };
  return b;
}

function tile(e) {
  const frame = el('div', { className: 'frame', tabIndex: 0, title: 'Open' });
  frame.onclick = () => act(e.id, 'open');
  frame.onkeydown = (k) => k.key === 'Enter' && act(e.id, 'open');

  if (!e.exists) frame.append(el('span', { className: 'missing', textContent: 'File was removed' }));
  else if (e.type === 'video') {
    const v = el('video', { src: e.fileUrl + '#t=0.1', muted: true, preload: 'metadata', loop: true });
    frame.onmouseenter = () => v.play().catch(() => {});
    frame.onmouseleave = () => v.pause();
    frame.append(v);
  } else frame.append(el('img', { src: e.fileUrl, loading: 'lazy', draggable: false, alt: '' }));

  if (e.type !== 'image') frame.append(el('span', { className: `chip kind ${e.type}`, textContent: e.type === 'gif' ? 'GIF' : 'Video' }));
  if (e.url) {
    const link = el('span', { className: 'chip link', title: `Copy link: ${e.url}` });
    link.innerHTML = `${ICONS.link}Link`;
    link.onclick = (ev) => {
      ev.stopPropagation();
      act(e.id, 'link');
    };
    frame.append(link);
  }

  const acts = el('div', { className: 'acts' });
  acts.append(
    actBtn(ICONS.copy, e.type === 'image' ? 'Copy image' : 'Copy file', 'copy', e.id),
    e.url ? actBtn(ICONS.external, 'Open link', 'browser', e.id) : actBtn(ICONS.upload, 'Upload and copy link', 'upload', e.id),
    actBtn(ICONS.save, 'Save as', 'save', e.id),
    actBtn(ICONS.folder, 'Show in folder', 'folder', e.id),
    actBtn(ICONS.trash, 'Remove from list', 'delete', e.id, 'del')
  );
  frame.append(acts);

  const meta = el(
    'div',
    { className: 'meta' },
    el('span', { className: 'time', textContent: time(e.date) }),
    el('span', { className: 'dims', textContent: e.w && e.h ? `${e.w} × ${e.h}` : '' }),
    el('span', { className: 'size', textContent: fmtSize(e.size || 0) })
  );
  if (e.savedPath) meta.append(el('span', { className: 'saved', textContent: 'Saved', title: e.savedPath }));
  return el('div', { className: 'shot' }, frame, meta);
}

async function render() {
  const all = await api.invoke('history:list');
  const items = all.filter((e) => filter === 'all' || e.type === filter);
  $('count').textContent = all.length ? String(all.length) : '';
  const main = $('main');
  main.textContent = '';

  if (!items.length) {
    const box = el('div', { className: 'empty' });
    box.innerHTML = all.length
      ? '<h2>None of these yet</h2>Pick another filter to see the rest.'
      : '<h2>Nothing captured yet</h2>Press <span class="key">PrtSc</span> to grab part of your screen, or <span class="key">Ctrl</span><span class="key">PrtSc</span> to record a GIF. Every capture lands here.';
    main.append(box);
    return;
  }

  let current = null;
  let grid = null;
  for (const e of items) {
    const label = dayLabel(e.date);
    if (label !== current) {
      current = label;
      const n = items.filter((x) => dayLabel(x.date) === label).length;
      const h = el('h2', {}, label, el('span', { textContent: String(n) }));
      grid = el('div', { className: 'grid' });
      main.append(el('section', { className: 'day' }, h, grid));
    }
    grid.append(tile(e));
  }
}

api.on('history:changed', render);
render();
