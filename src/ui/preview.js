'use strict';
const api = window.glimpse;
const $ = (id) => document.getElementById(id);
const video = $('video');
const strip = $('strip');
const film = $('film');

$('play').innerHTML = ICONS.play;
$('copy').innerHTML = `${ICONS.copy}Copy`;
$('save').innerHTML = `${ICONS.save}Save`;
$('upload').innerHTML = `${ICONS.upload}Upload`;
$('share').innerHTML = `${ICONS.share}Share`;

let duration = 1;
let format = 'gif';
let gifFps = 15;
let videoFps = 30;
let busy = false;
let fileUrl = '';
let trimA = 0;
let trimB = 1;

const fmtT = (s) => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const fmtSize = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

api.on('preview:init', (cfg) => {
  duration = Math.max(0.2, cfg.duration || 1);
  gifFps = cfg.gifFps || 15;
  videoFps = cfg.videoFps || 30;
  fileUrl = cfg.fileUrl;
  trimA = 0;
  trimB = duration;
  video.src = fileUrl;
  $('width').value = String(cfg.gifMaxWidth || 0);
  setFormat(cfg.kind === 'gif' ? 'gif' : 'mp4');
  video.addEventListener(
    'loadedmetadata',
    () => {
      if (isFinite(video.duration) && video.duration > 0) {
        duration = video.duration;
        trimB = duration;
      }
      meta();
      layout();
      renderFilm();
      play();
    },
    { once: true }
  );
  layout();
});

function meta() {
  hint();
}

// ---------- format ----------

function setFormat(f) {
  format = f;
  for (const b of document.querySelectorAll('#fmt button')) b.classList.toggle('on', b.dataset.f === f);
  $('fps').value = String(f === 'gif' ? gifFps : videoFps);
  hint();
}
document.querySelectorAll('#fmt button').forEach((b) => (b.onclick = () => setFormat(b.dataset.f)));
$('fps').onchange = () => {
  if (format === 'gif') gifFps = +$('fps').value;
  else videoFps = +$('fps').value;
  hint();
};
$('width').onchange = hint;

function outSize() {
  const w = video.videoWidth || 0, h = video.videoHeight || 0;
  const max = +$('width').value;
  if (!max || w <= max) return { w, h };
  return { w: max, h: Math.round((h * max) / w) };
}

function hint() {
  if (busy) return;
  const { w, h } = outSize();
  const frames = Math.max(1, Math.round((trimB - trimA) * +$('fps').value));
  $('status').innerHTML = w ? `<b>${w} × ${h}</b>&nbsp; ${frames} frames` : '';
}

// ---------- filmstrip + trim ----------

function layout() {
  const W = strip.clientWidth;
  const xa = (trimA / duration) * W, xb = (trimB / duration) * W;
  $('dimA').style.left = '0px';
  $('dimA').style.width = `${xa}px`;
  $('dimB').style.left = `${xb}px`;
  $('dimB').style.width = `${Math.max(0, W - xb)}px`;
  $('win').style.left = `${xa}px`;
  $('win').style.width = `${Math.max(28, xb - xa)}px`;
  $('gripA').style.left = `${xa + 7}px`;
  $('gripB').style.left = `${xb - 7}px`;
  $('lA').textContent = fmtT(trimA);
  $('lB').textContent = fmtT(trimB);
  $('lLen').textContent = `${(trimB - trimA).toFixed(1)} s`;
  hint();
}

let filmJob = 0;
async function renderFilm() {
  const job = ++filmJob;
  const dpr = devicePixelRatio || 1;
  const W = strip.clientWidth, H = strip.clientHeight;
  film.width = Math.round(W * dpr);
  film.height = Math.round(H * dpr);
  const ctx = film.getContext('2d');
  ctx.fillStyle = '#14171c';
  ctx.fillRect(0, 0, film.width, film.height);
  if (!video.videoWidth) return;
  const tileW = Math.max(40, Math.round(H * (video.videoWidth / video.videoHeight)));
  const n = Math.max(1, Math.ceil(W / tileW));
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = fileUrl;
  await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
  for (let i = 0; i < n; i++) {
    if (job !== filmJob) return;
    v.currentTime = Math.min(duration - 0.01, ((i + 0.5) / n) * duration);
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    const x = Math.round(i * tileW * dpr);
    const w = Math.round(tileW * dpr);
    // cover-fit each tile
    const sr = v.videoWidth / v.videoHeight, dr = w / film.height;
    let sw = v.videoWidth, sh = v.videoHeight, sx = 0, sy = 0;
    if (sr > dr) { sw = sh * dr; sx = (v.videoWidth - sw) / 2; } else { sh = sw / dr; sy = (v.videoHeight - sh) / 2; }
    ctx.drawImage(v, sx, sy, sw, sh, x, 0, w, film.height);
    ctx.fillStyle = 'rgba(20,23,28,0.9)';
    ctx.fillRect(x + w - Math.round(dpr), 0, Math.round(dpr), film.height);
  }
  v.removeAttribute('src');
  v.load();
}

let resizeTimer;
addEventListener('resize', () => {
  layout();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderFilm, 150);
});

function timeAt(clientX) {
  const r = strip.getBoundingClientRect();
  return clamp(((clientX - r.left) / r.width) * duration, 0, duration);
}

let dragging = null;
strip.addEventListener('pointerdown', (e) => {
  const t = timeAt(e.clientX);
  if (e.target.id === 'gripA') dragging = 'a';
  else if (e.target.id === 'gripB') dragging = 'b';
  else dragging = 'seek';
  strip.setPointerCapture(e.pointerId);
  video.pause();
  setPlaying(false);
  if (dragging === 'seek') seek(t);
});
strip.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const t = timeAt(e.clientX);
  const minLen = Math.min(0.2, duration / 4);
  if (dragging === 'a') {
    trimA = clamp(t, 0, trimB - minLen);
    seek(trimA);
  } else if (dragging === 'b') {
    trimB = clamp(t, trimA + minLen, duration);
    seek(trimB);
  } else seek(t);
  layout();
});
strip.addEventListener('pointerup', () => (dragging = null));

function seek(t) {
  video.currentTime = clamp(t, 0, duration);
  drawHead();
}

function drawHead() {
  $('head').style.left = `${(video.currentTime / duration) * 100}%`;
  $('tc').innerHTML = `${fmtT(video.currentTime)}<span>of ${fmtT(duration)}</span>`;
}

// ---------- playback ----------

function setPlaying(p) {
  $('play').innerHTML = p ? ICONS.pause : ICONS.play;
}

function play() {
  if (video.currentTime < trimA || video.currentTime >= trimB - 0.03) video.currentTime = trimA;
  video.play().then(() => setPlaying(true)).catch(() => {});
}

function togglePlay() {
  if (video.paused) play();
  else {
    video.pause();
    setPlaying(false);
  }
}
$('play').onclick = togglePlay;
video.onclick = togglePlay;

(function loop() {
  if (!video.paused && (video.currentTime >= trimB || video.currentTime < trimA - 0.05)) video.currentTime = trimA;
  drawHead();
  requestAnimationFrame(loop);
})();

// ---------- export ----------

api.on('preview:progress', (p) => {
  $('bar').style.width = `${Math.round(p * 100)}%`;
});

const DONE = { save: 'Saved', copy: 'Copied', upload: 'Link copied', share: 'Shared' };

async function run(action, extra = {}) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  $('bar').style.width = '0%';
  $('status').textContent = `Making ${format.toUpperCase()}`;
  const { w, h } = outSize();
  const opts = { format, start: trimA, end: trimB, fps: +$('fps').value, width: +$('width').value, outW: w, outH: h };
  const res = await api.invoke('rec:run', { action, opts, ...extra });
  busy = false;
  document.body.classList.remove('busy');
  const st = $('status');
  st.textContent = '';
  if (res && res.error) {
    st.textContent = `Couldn't finish: ${res.error}`;
    return;
  }
  const b = document.createElement('b');
  b.textContent = `${DONE[action]}`;
  st.append(b, ` ${format.toUpperCase()}, ${fmtSize(res.size)}`);
  if (res.url && (action === 'upload' || action === 'share')) {
    const u = document.createElement('span');
    u.className = 'url';
    u.textContent = res.url;
    st.append(u);
  }
}

$('save').onclick = () => run('save');
$('copy').onclick = () => run('copy');
$('upload').onclick = () => run('upload');
$('discard').onclick = () => api.send('rec:discard');

const SHARE = [
  { id: 'twitter', label: 'X', c: '#e7e9ea' },
  { id: 'reddit', label: 'Reddit', c: '#ff4500' },
  { id: 'facebook', label: 'Facebook', c: '#1877f2' },
  { id: 'pinterest', label: 'Pinterest', c: '#e60023' },
  { id: 'tumblr', label: 'Tumblr', c: '#36465d' },
  { id: 'vk', label: 'VK', c: '#0077ff' },
];
const menu = $('shareMenu');
for (const s of SHARE) {
  const b = document.createElement('button');
  b.innerHTML = `<span class="dot" style="background:${s.c}"></span>${s.label}`;
  b.onclick = () => {
    menu.hidden = true;
    run('share', { network: s.id });
  };
  menu.append(b);
}
$('share').onclick = (e) => {
  e.stopPropagation();
  if (!menu.hidden) return (menu.hidden = true);
  menu.hidden = false;
  const r = $('share').getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${r.top - menu.offsetHeight - 8}px`;
};
addEventListener('click', () => (menu.hidden = true));

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT') return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (e.key === ' ') {
    e.preventDefault();
    togglePlay();
  } else if (ctrl && k === 's') {
    e.preventDefault();
    run('save');
  } else if (ctrl && k === 'c') {
    e.preventDefault();
    run('copy');
  } else if (ctrl && k === 'd') {
    e.preventDefault();
    run('upload');
  } else if (k === 'i' || e.key === '[') {
    trimA = clamp(video.currentTime, 0, trimB - 0.1);
    layout();
  } else if (k === 'o' || e.key === ']') {
    trimB = clamp(video.currentTime, trimA + 0.1, duration);
    layout();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    video.pause();
    setPlaying(false);
    seek(video.currentTime + (e.key === 'ArrowLeft' ? -1 : 1) / (+$('fps').value || 15));
  }
});
