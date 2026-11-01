'use strict';
const api = window.glimpse;
const $ = (id) => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d');

$('copy').innerHTML = `${ICONS.copy}Copy`;
$('save').innerHTML = `${ICONS.save}Save`;
$('upload').innerHTML = `${ICONS.upload}Upload`;

const BGS = [
  { id: 'sunrise', g: ['#ffd23f', '#ff7a59'] },
  { id: 'sunset', g: ['#ff9966', '#ff5e62'] },
  { id: 'peach', g: ['#ffe0c7', '#ff9a9e'] },
  { id: 'mint', g: ['#b8f1d8', '#3fbf9f'] },
  { id: 'ocean', g: ['#7fd3ff', '#2f6bff'] },
  { id: 'grape', g: ['#c7b3ff', '#7a5cff'] },
  { id: 'forest', g: ['#1f6f6e', '#76b39d'] },
  { id: 'dusk', g: ['#2b3440', '#5b4b6b'] },
  { id: 'graphite', c: '#1c2027' },
  { id: 'paper', c: '#f4f5f7' },
  { id: 'black', c: '#0d0f12' },
  { id: 'none' },
];

const DEFAULTS = { bg: 'sunrise', pad: 80, rad: 14, shadow: 'soft', bar: 'none', ratio: 'auto' };
let opt = { ...DEFAULTS };
try {
  opt = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('pretty') || '{}') };
} catch {}

let img = null;

// ---------- controls ----------

for (const b of BGS) {
  const el = document.createElement('button');
  el.dataset.v = b.id;
  el.title = b.id[0].toUpperCase() + b.id.slice(1);
  if (b.g) el.style.background = `linear-gradient(135deg, ${b.g[0]}, ${b.g[1]})`;
  else if (b.c) el.style.background = b.c;
  else el.className = 'none';
  el.onclick = () => set('bg', b.id);
  $('bgs').append(el);
}
for (const id of ['shadow', 'bar', 'ratio']) {
  for (const el of $(id).querySelectorAll('button')) el.onclick = () => set(id, el.dataset.v);
}
$('pad').oninput = () => set('pad', +$('pad').value);
$('rad').oninput = () => set('rad', +$('rad').value);

function set(k, v) {
  opt[k] = v;
  try {
    localStorage.setItem('pretty', JSON.stringify(opt));
  } catch {}
  sync();
  draw();
}

function sync() {
  for (const el of $('bgs').children) el.classList.toggle('on', el.dataset.v === opt.bg);
  for (const id of ['shadow', 'bar', 'ratio']) for (const el of $(id).querySelectorAll('button')) el.classList.toggle('on', el.dataset.v === String(opt[id]));
  $('pad').value = opt.pad;
  $('rad').value = opt.rad;
  $('padV').textContent = opt.pad;
  $('radV').textContent = opt.rad;
}

// ---------- drawing ----------

function rounded(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function draw() {
  if (!img) return;
  let W = img.naturalWidth, H = img.naturalHeight;
  // canvases have size limits: very tall scrolling captures are drawn scaled down
  const k = Math.min(1, 12000 / Math.max(W, H));
  W = Math.round(W * k);
  H = Math.round(H * k);
  const unit = Math.max(W, H) / 1000;
  const pad = Math.round(opt.pad * unit);
  const rad = Math.round(opt.rad * unit);
  const barH = opt.bar === 'none' ? 0 : Math.round(Math.max(22, W * 0.034));
  const cw = W, ch = H + barH;
  let w = cw + pad * 2, h = ch + pad * 2;
  if (opt.ratio !== 'auto') {
    const r = +opt.ratio;
    if (w / h < r) w = Math.round(h * r);
    else h = Math.round(w / r);
  }
  cv.width = w;
  cv.height = h;
  const x = Math.round((w - cw) / 2), y = Math.round((h - ch) / 2);

  const bg = BGS.find((b) => b.id === opt.bg) || BGS[0];
  ctx.clearRect(0, 0, w, h);
  if (bg.g) {
    const gr = ctx.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, bg.g[0]);
    gr.addColorStop(1, bg.g[1]);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, w, h);
  } else if (bg.c) {
    ctx.fillStyle = bg.c;
    ctx.fillRect(0, 0, w, h);
  }

  if (opt.shadow !== 'none' && (pad > 0 || opt.ratio !== 'auto')) {
    const strong = opt.shadow === 'strong';
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${strong ? 0.5 : 0.3})`;
    ctx.shadowBlur = (strong ? 70 : 40) * unit;
    ctx.shadowOffsetY = (strong ? 28 : 16) * unit;
    rounded(ctx, x, y, cw, ch, rad);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  rounded(ctx, x, y, cw, ch, rad);
  ctx.clip();
  if (barH) {
    const dark = opt.bar === 'dark';
    ctx.fillStyle = dark ? '#2a2f38' : '#eef0f3';
    ctx.fillRect(x, y, cw, barH);
    ctx.fillStyle = dark ? '#4a515e' : '#cfd3da';
    const dr = barH * 0.16;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(x + barH * 0.62 + i * dr * 3.2, y + barH / 2, dr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.drawImage(img, x, y + barH, W, H);
  ctx.restore();
  $('dims').textContent = `${w} × ${h}`;
}

// ---------- in / out ----------

api.on('pretty:init', ({ fileUrl }) => {
  const im = new Image();
  im.onload = () => {
    img = im;
    sync();
    draw();
  };
  im.src = fileUrl;
});

let busy = false;
async function run(action) {
  if (busy || !img) return;
  busy = true;
  $('status').textContent = 'Working…';
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const png = new Uint8Array(await blob.arrayBuffer());
  const res = await api.invoke('pretty:action', { action, png, w: cv.width, h: cv.height });
  busy = false;
  if (!res || res.error) {
    $('status').textContent = `Couldn’t finish: ${(res && res.error) || 'unknown error'}`;
    return;
  }
  const b = document.createElement('b');
  b.textContent = { copy: 'Copied', save: 'Saved', upload: 'Link copied' }[action];
  $('status').textContent = '';
  $('status').append(b, ` ${cv.width} × ${cv.height}`);
}
$('copy').onclick = () => run('copy');
$('save').onclick = () => run('save');
$('upload').onclick = () => run('upload');
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (!(e.ctrlKey || e.metaKey)) return;
  if (k === 'c') { e.preventDefault(); run('copy'); }
  if (k === 's') { e.preventDefault(); run('save'); }
  if (k === 'd') { e.preventDefault(); run('upload'); }
});
addEventListener('resize', draw);
sync();
