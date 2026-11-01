'use strict';
const api = window.glimpse;
const $ = (id) => document.getElementById(id);

const bg = $('bg');
const ann = $('ann');
const bgx = bg.getContext('2d', { willReadFrequently: true });
const ax = ann.getContext('2d');
const selEl = $('sel');
const sizeEl = $('size');
const loupe = $('loupe');
const loupeX = $('loupe-c').getContext('2d');
const loupeInfo = $('loupe-info');
const tv = $('tv');
const th = $('th');
const palette = $('palette');
const shareMenu = $('sharemenu');
const bubble = $('bubble');
const textEdit = $('textedit');
const crossX = $('cross-x');
const crossY = $('cross-y');

const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff2d92', '#ffffff', '#8e8e93', '#000000'];
const TOOLS = [
  { id: 'pen', key: 'P', tip: 'Pencil' },
  { id: 'line', key: 'L', tip: 'Line' },
  { id: 'arrow', key: 'A', tip: 'Arrow' },
  { id: 'rect', key: 'R', tip: 'Rectangle' },
  { id: 'ellipse', key: 'E', tip: 'Ellipse' },
  { id: 'marker', key: 'M', tip: 'Marker' },
  { id: 'text', key: 'T', tip: 'Text' },
  { id: 'blur', key: 'B', tip: 'Pixelate (hide info)' },
  { id: 'step', key: 'N', tip: 'Numbered step' },
];
const SHARE = [
  { id: 'twitter', label: 'X / Twitter', c: '#e7e9ea' },
  { id: 'facebook', label: 'Facebook', c: '#1877f2' },
  { id: 'reddit', label: 'Reddit', c: '#ff4500' },
  { id: 'pinterest', label: 'Pinterest', c: '#e60023' },
  { id: 'vk', label: 'VK', c: '#0077ff' },
  { id: 'tumblr', label: 'Tumblr', c: '#36465d' },
];
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

let mode = 'shot'; // 'shot' | 'rec'
let recKind = 'gif';
let S = 1; // physical pixels per CSS pixel
let hasImage = false;
let showMag = true;
let sel = null; // {x,y,w,h} in CSS px
let drag = null;
let tool = null;
let color = '#ff3b30';
let size = 3;
let shapes = [];
let redoStack = [];
let current = null;
let textState = null;
let mouse = { x: -1, y: -1 };
let busy = false;
const btns = {};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- init ----------

// The window is reused: main arms it on every hotkey press and resets it when it closes.
let currentGen = 0;

function sizeCanvases(w, h) {
  if (bg.width !== w || bg.height !== h) {
    bg.width = w;
    bg.height = h;
  }
  if (ann.width !== w || ann.height !== h) {
    ann.width = w;
    ann.height = h;
  }
  S = bg.width / innerWidth;
  renderAnn();
}

// Step 1, sent the instant the hotkey fires: dim the screen and show the crosshair.
api.on('overlay:arm', (cfg) => {
  resetState();
  currentGen = cfg.gen;
  mode = cfg.mode === 'shot' ? 'shot' : 'rec';
  if (mode === 'rec') recKind = cfg.mode;
  showMag = cfg.showMagnifier !== false;
  screens = cfg.screens || null;
  document.body.classList.remove('mode-shot', 'mode-rec');
  document.body.classList.add('mode-' + mode);
  hasImage = false;
  bg.style.display = 'none';
  sizeCanvases(Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio));
  buildToolbars();
  hideToolbars();
  if (cfg.cursor) mouse = cfg.cursor;
  updateCross();
  document.documentElement.style.visibility = '';
  if (mode === 'rec') api.send('overlay:ready', cfg.gen);
});

// Step 2, a few ms later in screenshot mode: paint the frozen screen in behind the dim.
api.on('overlay:image', ({ gen, image }) => {
  if (gen !== currentGen || !image) return;
  const { width, height, data, rgba } = image;
  const n = width * height * 4;
  let px;
  if (rgba && data.length >= n) {
    px = new Uint8ClampedArray(data.buffer, data.byteOffset, n);
  } else {
    px = new Uint8ClampedArray(n);
    const m = Math.min(n, data.length);
    for (let i = 0; i < m; i += 4) {
      px[i] = rgba ? data[i] : data[i + 2];
      px[i + 1] = data[i + 1];
      px[i + 2] = rgba ? data[i + 2] : data[i];
      px[i + 3] = 255;
    }
  }
  sizeCanvases(width, height);
  bgx.putImageData(new ImageData(px, width, height), 0, 0);
  bg.style.display = '';
  hasImage = true;
  updateLoupe();
  api.send('overlay:ready', gen);
});

api.on('overlay:reset', () => {
  document.documentElement.style.visibility = 'hidden';
  resetState();
  bgx.clearRect(0, 0, bg.width, bg.height);
  // let a blank frame reach the screen before main parks the window, so the next arm never flashes an old capture
  requestAnimationFrame(() => requestAnimationFrame(() => api.send('overlay:parked')));
});

function resetState() {
  cancelText();
  sel = null;
  drag = null;
  current = null;
  shapes = [];
  redoStack = [];
  tool = null;
  busy = false;
  mouse = { x: -1, y: -1 };
  hidePops();
  hideTip();
  bubble.hidden = true;
  loupe.hidden = true;
  selEl.classList.remove('drawing');
  document.body.classList.remove('has-sel', 'dragging');
  document.body.style.cursor = 'crosshair';
  ax.setTransform(1, 0, 0, 1, 0, 0);
  ax.clearRect(0, 0, ann.width, ann.height);
  update();
  updateCross();
}

addEventListener('resize', () => {
  if (!hasImage && bg.width !== Math.round(innerWidth * devicePixelRatio)) {
    bg.width = ann.width = Math.round(innerWidth * devicePixelRatio);
    bg.height = ann.height = Math.round(innerHeight * devicePixelRatio);
  }
  S = bg.width / innerWidth;
  renderAnn();
  update();
});

api.on('overlay:clear', () => {
  cancelText();
  sel = null;
  drag = null;
  current = null;
  shapes = [];
  redoStack = [];
  renderAnn();
  update();
  updateCross();
});

// ---------- toolbars ----------

function button(icon, tip, kbd, onClick, cls = '') {
  const b = document.createElement('button');
  b.className = 'tb ' + cls;
  b.innerHTML = icon;
  b.dataset.tip = tip;
  if (kbd) b.dataset.kbd = kbd;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(b, e);
  });
  return b;
}
const sep = () => Object.assign(document.createElement('div'), { className: 'sep' });

const keycaps = (kbd) =>
  kbd ? `<span class="keys">${kbd.split('+').map((k) => `<span class="key">${k}</span>`).join('')}</span>` : '';

function buildToolbars() {
  tv.innerHTML = '';
  th.innerHTML = '';
  if (mode === 'shot') {
    const groups = [['pen', 'line', 'arrow', 'rect', 'ellipse', 'marker'], ['text', 'step', 'blur']];
    groups.forEach((g, i) => {
      if (i) tv.append(sep());
      for (const id of g) {
        const t = TOOLS.find((x) => x.id === id);
        btns[id] = button(ICONS[id], t.tip, t.key, () => setTool(id));
        tv.append(btns[id]);
      }
    });
    tv.append(sep());
    btns.color = button('<span class="swatch"></span>', 'Color and thickness', '', (b) => togglePalette(b));
    tv.append(btns.color, sep());
    btns.undo = button(ICONS.undo, 'Undo', 'Ctrl+Z', undo);
    btns.redo = button(ICONS.redo, 'Redo', 'Ctrl+Y', redo);
    tv.append(btns.undo, btns.redo);

    th.append(
      button(ICONS.upload, 'Upload and copy link', 'Ctrl+D', () => act('upload')),
      button(ICONS.share, 'Share', '', (b) => toggleShare(b)),
      button(ICONS.search, 'Find similar images on Google', 'Ctrl+F', () => act('search')),
      button(ICONS.print, 'Print', 'Ctrl+P', () => act('print')),
      sep(),
      button(ICONS.gif, 'Record this area as a GIF', 'Ctrl+G', () => startRec('gif')),
      button(ICONS.video, 'Record this area as a video', 'Ctrl+R', () => startRec('video')),
      sep(),
      button(ICONS.save, 'Save as file', 'Ctrl+S', () => act('save')),
      button(`${ICONS.copy}<span>Copy</span>${keycaps('Ctrl+C')}`, 'Copy to clipboard', '', () => act('copy'), 'label primary'),
      button(ICONS.close, 'Close', 'Esc', close)
    );
    buildPalette();
    buildShare();
    updateColor();
    updateUndo();
  } else {
    const seg = document.createElement('div');
    seg.className = 'seg';
    const segBtn = (label, kind) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        setRecKind(kind);
      });
      seg.append(b);
      return b;
    };
    btns.segGif = segBtn('GIF', 'gif');
    btns.segVid = segBtn('Video', 'video');
    th.append(
      seg,
      sep(),
      button(`<span class="dot"></span><span>Record</span>${keycaps('Enter')}`, 'Start recording', '', () => startRec(), 'label record'),
      button(ICONS.close, 'Cancel', 'Esc', close)
    );
    setRecKind(recKind);
  }
}

function setRecKind(k) {
  recKind = k;
  btns.segGif.classList.toggle('on', k === 'gif');
  btns.segVid.classList.toggle('on', k === 'video');
}

function buildPalette() {
  palette.innerHTML = `
    <div class="grid"></div>
    <div class="row"><span>Thickness</span><input type="range" min="1" max="40" step="1"><span class="val readout"></span></div>
    <label class="custom"><input type="color"><span>Custom color</span></label>`;
  const grid = palette.querySelector('.grid');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.style.background = c;
    b.dataset.c = c;
    b.title = c.toUpperCase();
    b.addEventListener('click', () => {
      color = c;
      updateColor();
    });
    grid.append(b);
  }
  palette.querySelector('input[type="range"]').addEventListener('input', (e) => {
    size = +e.target.value;
    updateColor();
    if (textState) styleText();
  });
  palette.querySelector('input[type="color"]').addEventListener('input', (e) => {
    color = e.target.value;
    updateColor();
  });
}

function buildShare() {
  shareMenu.innerHTML = '';
  for (const s of SHARE) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="dot" style="background:${s.c}"></span>${s.label}`;
    b.addEventListener('click', () => {
      shareMenu.hidden = true;
      act('share', { network: s.id });
    });
    shareMenu.append(b);
  }
}

function updateColor() {
  const sw = btns.color && btns.color.querySelector('.swatch');
  if (sw) sw.style.background = color;
  for (const b of palette.querySelectorAll('.grid button')) b.classList.toggle('on', b.dataset.c === color);
  const range = palette.querySelector('input[type="range"]');
  if (range) {
    range.value = size;
    palette.querySelector('.val').textContent = size;
    palette.querySelector('input[type="color"]').value = color;
  }
  if (textState) styleText();
}

function updateUndo() {
  if (!btns.undo) return;
  btns.undo.disabled = !shapes.length;
  btns.redo.disabled = !redoStack.length;
}

function setTool(id) {
  commitText();
  tool = tool === id ? null : id;
  for (const t of TOOLS) btns[t.id].classList.toggle('on', t.id === tool);
  updateCursor(mouse.x, mouse.y);
}

function placePop(pop, anchor, prefer = 'left') {
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x, y;
  if (prefer === 'left') {
    x = r.left - pw - 8;
    if (x < 4) x = r.right + 8;
    y = clamp(r.top, 4, innerHeight - ph - 4);
  } else {
    x = clamp(r.left, 4, innerWidth - pw - 4);
    y = r.top - ph - 8;
    if (y < 4) y = r.bottom + 8;
  }
  // never sit on top of the action bar
  if (!th.hidden && pop !== shareMenu) {
    const t = th.getBoundingClientRect();
    if (x < t.right && x + pw > t.left && y < t.bottom && y + ph > t.top) {
      y = t.top - ph - 8 >= 4 ? t.top - ph - 8 : t.bottom + 8;
    }
  }
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
}

function togglePalette(anchor) {
  shareMenu.hidden = true;
  if (!palette.hidden) return (palette.hidden = true);
  placePop(palette, anchor, 'left');
}

function toggleShare(anchor) {
  palette.hidden = true;
  if (!shareMenu.hidden) return (shareMenu.hidden = true);
  placePop(shareMenu, anchor, 'up');
}

function hidePops() {
  palette.hidden = true;
  shareMenu.hidden = true;
}

function hideToolbars() {
  tv.hidden = true;
  th.hidden = true;
  hidePops();
  hideTip();
}

// The monitors this overlay covers, in overlay pixels. One overlay can span several monitors
// (same scaling), and the bounding box can contain gaps that no monitor shows.
let screens = null;
function screenAt(x, y) {
  const all = screens && screens.length ? screens : [{ x: 0, y: 0, w: innerWidth, h: innerHeight }];
  let best = all[0], bestD = Infinity;
  for (const r of all) {
    const dx = Math.max(r.x - x, 0, x - (r.x + r.w)), dy = Math.max(r.y - y, 0, y - (r.y + r.h));
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

function showToolbars() {
  if (!sel) return;
  const m = 8;
  // keep both toolbars on the monitor that shows the selection's bottom-right corner
  const A = screenAt(sel.x + sel.w - 1, sel.y + sel.h - 1);
  const L = A.x + 2, T = A.y + 2, R = A.x + A.w - 2, B = A.y + A.h - 2;
  if (mode === 'shot') {
    tv.hidden = false;
    const vw = tv.offsetWidth, vh = tv.offsetHeight;
    let x = sel.x + sel.w + m;
    if (x + vw > R) x = sel.x - m - vw;
    if (x < L) x = sel.x + sel.w - vw - m;
    x = clamp(x, L, R - vw);
    let y = sel.y + sel.h - vh;
    y = clamp(y, T, B - vh);
    tv.style.left = x + 'px';
    tv.style.top = y + 'px';
  }
  th.hidden = false;
  const hw = th.offsetWidth, hh = th.offsetHeight;
  let x = sel.x + sel.w - hw;
  x = clamp(x, L, R - hw);
  let y = sel.y + sel.h + m;
  if (y + hh > B) y = sel.y - m - hh;
  if (y < T) y = sel.y + sel.h - hh - m;
  y = clamp(y, T, B - hh);
  // keep clear of the vertical toolbar if both ended up inside the selection
  if (mode === 'shot' && !tv.hidden) {
    const a = tv.getBoundingClientRect();
    if (x < a.right && x + hw > a.left && y < a.bottom && y + hh > a.top) x = clamp(a.left - hw - 6, L, R - hw);
  }
  th.style.left = x + 'px';
  th.style.top = y + 'px';
}

// tooltips
const tip = document.createElement('div');
tip.className = 'tip';
tip.hidden = true;
document.body.append(tip);
document.addEventListener('mouseover', (e) => {
  const b = e.target.closest('[data-tip]');
  if (!b) return hideTip();
  tip.innerHTML = `<span>${b.dataset.tip}</span>${keycaps(b.dataset.kbd)}`;
  tip.hidden = false;
  const r = b.getBoundingClientRect();
  const vertical = !!b.closest('.vertical');
  let x, y;
  if (vertical) {
    x = r.left - tip.offsetWidth - 8;
    if (x < 4) x = r.right + 8;
    y = r.top + r.height / 2 - tip.offsetHeight / 2;
  } else {
    x = r.left + r.width / 2 - tip.offsetWidth / 2;
    y = r.top - tip.offsetHeight - 8;
    if (y < 4) y = r.bottom + 8;
  }
  tip.style.left = clamp(x, 4, innerWidth - tip.offsetWidth - 4) + 'px';
  tip.style.top = clamp(y, 4, innerHeight - tip.offsetHeight - 4) + 'px';
});
function hideTip() {
  tip.hidden = true;
}

// ---------- selection geometry ----------

function norm(x1, y1, x2, y2) {
  x1 = clamp(x1, 0, innerWidth);
  x2 = clamp(x2, 0, innerWidth);
  y1 = clamp(y1, 0, innerHeight);
  y2 = clamp(y2, 0, innerHeight);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

const inSel = (x, y) => sel && x >= sel.x && x <= sel.x + sel.w && y >= sel.y && y <= sel.y + sel.h;

function hitHandle(x, y) {
  if (!sel || drag) return null;
  const { x: sx, y: sy, w, h } = sel;
  const pts = {
    nw: [sx, sy], n: [sx + w / 2, sy], ne: [sx + w, sy], e: [sx + w, sy + h / 2],
    se: [sx + w, sy + h], s: [sx + w / 2, sy + h], sw: [sx, sy + h], w: [sx, sy + h / 2],
  };
  for (const [k, [px, py]] of Object.entries(pts)) if (Math.abs(x - px) <= 7 && Math.abs(y - py) <= 7) return k;
  if (tool) return null; // with a tool active, only the handle squares resize
  const inX = x > sx && x < sx + w, inY = y > sy && y < sy + h;
  if (inY && Math.abs(x - sx) <= 4) return 'w';
  if (inY && Math.abs(x - sx - w) <= 4) return 'e';
  if (inX && Math.abs(y - sy) <= 4) return 'n';
  if (inX && Math.abs(y - sy - h) <= 4) return 's';
  return null;
}

function physRect() {
  const x = clamp(Math.round(sel.x * S), 0, bg.width - 1);
  const y = clamp(Math.round(sel.y * S), 0, bg.height - 1);
  const w = clamp(Math.round(sel.w * S), 1, bg.width - x);
  const h = clamp(Math.round(sel.h * S), 1, bg.height - y);
  return { x, y, w, h };
}

function update() {
  document.body.classList.toggle('has-sel', !!sel);
  if (!sel) {
    selEl.hidden = true;
    sizeEl.hidden = true;
    hideToolbars();
    return;
  }
  selEl.hidden = false;
  selEl.style.left = sel.x + 'px';
  selEl.style.top = sel.y + 'px';
  selEl.style.width = sel.w + 'px';
  selEl.style.height = sel.h + 'px';
  sizeEl.hidden = false;
  selEl.classList.toggle('tiny', sel.w < 70 || sel.h < 70);
  sizeEl.innerHTML = `${Math.round(sel.w * S)}<span class="x">×</span>${Math.round(sel.h * S)}`;
  let ly = sel.y - 3 - 22 - 5;
  let lx = sel.x - 3;
  if (ly < 4) {
    ly = sel.y + 24;
    lx = sel.x + 6;
  }
  sizeEl.style.left = clamp(lx, 4, innerWidth - sizeEl.offsetWidth - 4) + 'px';
  sizeEl.style.top = ly + 'px';
  if (drag && drag.type !== 'draw') hideToolbars();
  else if (!drag && sel.w >= 3 && sel.h >= 3) showToolbars();
}

function updateCursor(x, y) {
  let c = 'crosshair';
  const h = hitHandle(x, y);
  if (h) c = CURSORS[h];
  else if (inSel(x, y)) c = tool ? (tool === 'text' ? 'text' : 'crosshair') : 'move';
  else if (tool && sel) c = 'default';
  document.body.style.cursor = c;
}

function updateCross() {
  const show = !sel && !drag && mouse.x >= 0;
  crossX.hidden = crossY.hidden = !show;
  if (show) {
    crossX.style.top = mouse.y + 'px';
    crossY.style.left = mouse.x + 'px';
  }
}

function pixelAt(px, py) {
  const d = bgx.getImageData(clamp(px, 0, bg.width - 1), clamp(py, 0, bg.height - 1), 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function updateLoupe() {
  const show = hasImage && showMag && mouse.x >= 0 && (!sel || (drag && drag.type === 'new'));
  loupe.hidden = !show;
  if (!show) return;
  const px = Math.floor(mouse.x * S), py = Math.floor(mouse.y * S);
  const N = 11, Z = 12;
  loupeX.imageSmoothingEnabled = false;
  loupeX.fillStyle = '#000';
  loupeX.fillRect(0, 0, 132, 132);
  loupeX.drawImage(bg, px - 5, py - 5, N, N, 0, 0, N * Z, N * Z);
  loupeX.strokeStyle = 'rgba(255,255,255,0.08)';
  loupeX.lineWidth = 1;
  loupeX.beginPath();
  for (let i = 1; i < N; i++) {
    loupeX.moveTo(i * Z + 0.5, 0);
    loupeX.lineTo(i * Z + 0.5, 132);
    loupeX.moveTo(0, i * Z + 0.5);
    loupeX.lineTo(132, i * Z + 0.5);
  }
  loupeX.stroke();
  loupeX.strokeStyle = '#ffd23f';
  loupeX.lineWidth = 2;
  loupeX.strokeRect(5 * Z, 5 * Z, Z, Z);
  const hex = pixelAt(px, py);
  loupeInfo.innerHTML =
    `<span class="k">Position</span><span>${px}, ${py}</span>` +
    `<span class="hex"><span class="sw" style="background:${hex}"></span>${hex.toUpperCase()}</span>` +
    `<span class="note">Press C to copy the color</span>`;
  const scr = screenAt(mouse.x, mouse.y);
  let x = mouse.x + 22, y = mouse.y + 22;
  if (x + 140 > scr.x + scr.w) x = mouse.x - 22 - 140;
  if (y + 200 > scr.y + scr.h) y = mouse.y - 22 - 200;
  loupe.style.left = x + 'px';
  loupe.style.top = y + 'px';
}

// ---------- mouse ----------

addEventListener('contextmenu', (e) => e.preventDefault());

addEventListener('mousedown', (e) => {
  if (e.target.closest('.toolbar, .pop, #textedit')) return;
  hidePops();
  if (e.button === 2) return onRightClick();
  if (e.button !== 0) return;
  const x = e.clientX, y = e.clientY;
  if (textState) {
    commitText();
    if (tool !== 'text') return;
  }
  const h = hitHandle(x, y);
  if (h) {
    drag = { type: 'resize', h, start: { ...sel }, mx: x, my: y };
  } else if (sel && inSel(x, y) && tool) {
    return startShape(x, y);
  } else if (sel && inSel(x, y)) {
    drag = { type: 'move', start: { ...sel }, mx: x, my: y };
  } else if (sel && tool) {
    return;
  } else {
    sel = { x, y, w: 0, h: 0 };
    drag = { type: 'new', ox: x, oy: y };
    api.send('overlay:selecting');
  }
  document.body.classList.add('dragging');
  update();
  updateCross();
});

addEventListener('mousemove', (e) => {
  const x = e.clientX, y = e.clientY;
  mouse = { x, y };
  if (drag) {
    if (drag.type === 'new') {
      let x2 = x, y2 = y;
      if (e.shiftKey) {
        const d = Math.max(Math.abs(x - drag.ox), Math.abs(y - drag.oy));
        x2 = drag.ox + Math.sign(x - drag.ox || 1) * d;
        y2 = drag.oy + Math.sign(y - drag.oy || 1) * d;
      }
      sel = norm(drag.ox, drag.oy, x2, y2);
    } else if (drag.type === 'move') {
      const s = drag.start;
      sel = {
        ...s,
        x: clamp(s.x + x - drag.mx, 0, innerWidth - s.w),
        y: clamp(s.y + y - drag.my, 0, innerHeight - s.h),
      };
    } else if (drag.type === 'resize') {
      const s = drag.start, dx = x - drag.mx, dy = y - drag.my;
      let l = s.x, t = s.y, r = s.x + s.w, b = s.y + s.h;
      if (drag.h.includes('w')) l += dx;
      if (drag.h.includes('e')) r += dx;
      if (drag.h.includes('n')) t += dy;
      if (drag.h.includes('s')) b += dy;
      sel = norm(l, t, r, b);
    } else if (drag.type === 'draw') {
      updateShape(x, y, e.shiftKey);
      renderAnn();
    }
    update();
  } else {
    updateCursor(x, y);
  }
  updateLoupe();
  updateCross();
});

addEventListener('mouseup', () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  document.body.classList.remove('dragging');
  if (d.type === 'draw') finishShape();
  if (d.type === 'new' && sel && (sel.w < 3 || sel.h < 3)) sel = null;
  update();
  updateLoupe();
  updateCross();
  updateCursor(mouse.x, mouse.y);
});

addEventListener('mouseleave', () => {
  mouse = { x: -1, y: -1 };
  updateLoupe();
  updateCross();
});

addEventListener(
  'wheel',
  (e) => {
    if (e.target.closest('.toolbar, .pop')) return;
    size = clamp(size + (e.deltaY < 0 ? 1 : -1), 1, 40);
    showBubble();
    if (textState) styleText();
  },
  { passive: true }
);

let bubbleTimer;
function showBubble(text) {
  const d = Math.min(40, Math.max(4, strokeWidth({ type: tool || 'pen', size })));
  bubble.innerHTML = text || `<i style="width:${d}px;height:${d}px;background:${color}"></i>Thickness ${size}`;
  updateColor();
  bubble.hidden = false;
  bubble.style.left = clamp(mouse.x + 18, 4, innerWidth - bubble.offsetWidth - 4) + 'px';
  bubble.style.top = clamp(mouse.y - bubble.offsetHeight - 10, 4, innerHeight - bubble.offsetHeight - 4) + 'px';
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => (bubble.hidden = true), 900);
}

function onRightClick() {
  if (textState) return cancelText();
  if (tool) return setTool(tool);
  if (sel) {
    sel = null;
    update();
    updateCross();
    return;
  }
  close();
}

// ---------- keyboard ----------

addEventListener('keydown', (e) => {
  if (e.target === textEdit) {
    if (e.key === 'Escape') {
      cancelText();
      e.preventDefault();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      commitText();
      e.preventDefault();
    }
    return;
  }
  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  const lower = k.length === 1 ? k.toLowerCase() : k;

  if (k === 'Escape') {
    e.preventDefault();
    if (!palette.hidden || !shareMenu.hidden) return hidePops();
    return close();
  }
  if (ctrl && lower === 'a') {
    e.preventDefault();
    // first press: the monitor under the cursor; again: every monitor
    const scr = screenAt(mouse.x >= 0 ? mouse.x : innerWidth / 2, mouse.y >= 0 ? mouse.y : innerHeight / 2);
    const same = sel && sel.x === scr.x && sel.y === scr.y && sel.w === scr.w && sel.h === scr.h;
    sel = same && screens && screens.length > 1 ? { x: 0, y: 0, w: innerWidth, h: innerHeight } : { x: scr.x, y: scr.y, w: scr.w, h: scr.h };
    api.send('overlay:selecting');
    update();
    updateCross();
    updateLoupe();
    return;
  }
  if (!sel) {
    if (lower === 'c' && !ctrl && hasImage && mouse.x >= 0) {
      const hex = pixelAt(Math.floor(mouse.x * S), Math.floor(mouse.y * S));
      navigator.clipboard.writeText(hex).catch(() => {});
      showBubble(`<i style="width:12px;height:12px;background:${hex}"></i>Copied ${hex}`);
    }
    return;
  }

  if (k.startsWith('Arrow')) {
    e.preventDefault();
    const step = ctrl ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[k];
    if (e.shiftKey) {
      sel = norm(sel.x, sel.y, sel.x + Math.max(1, sel.w + d[0]), sel.y + Math.max(1, sel.h + d[1]));
    } else {
      sel = { ...sel, x: clamp(sel.x + d[0], 0, innerWidth - sel.w), y: clamp(sel.y + d[1], 0, innerHeight - sel.h) };
    }
    update();
    return;
  }

  if (mode === 'rec') {
    if (k === 'Enter') startRec();
    return;
  }

  if (ctrl) {
    const map = {
      c: () => act('copy'),
      s: () => act('save'),
      d: () => act('upload'),
      p: () => act('print'),
      f: () => act('search'),
      g: () => startRec('gif'),
      r: () => startRec('video'),
      y: redo,
      z: () => (e.shiftKey ? redo() : undo()),
    };
    if (map[lower]) {
      e.preventDefault();
      map[lower]();
    }
    return;
  }
  if (k === 'Enter') return act('copy');
  const t = TOOLS.find((x) => x.key.toLowerCase() === lower);
  if (t) setTool(t.id);
});

// ---------- annotations ----------

const strokeWidth = (s) => (s.type === 'marker' ? s.size * 4 + 8 : s.size);
const fontSize = (sz) => Math.max(12, 10 + sz * 3);

function startShape(x, y) {
  if (tool === 'text') return openText(x, y);
  if (tool === 'step') {
    const n = shapes.filter((s) => s.type === 'step').length + 1;
    return pushShape({ type: 'step', x, y, n, color, size });
  }
  current = { type: tool, color, size, x1: x, y1: y, x2: x, y2: y };
  if (tool === 'pen' || tool === 'marker') current.points = [[x, y]];
  drag = { type: 'draw' };
  selEl.classList.add('drawing');
  renderAnn();
}

function updateShape(x, y, shift) {
  const c = current;
  if (!c) return;
  if (c.points) {
    if (shift && c.type === 'marker') {
      c.points = [c.points[0], [x, c.points[0][1]]];
    } else {
      c.points.push([x, y]);
    }
    return;
  }
  if (shift) {
    const dx = x - c.x1, dy = y - c.y1;
    if (c.type === 'line' || c.type === 'arrow') {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      x = c.x1 + Math.cos(ang) * len;
      y = c.y1 + Math.sin(ang) * len;
    } else {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      x = c.x1 + Math.sign(dx || 1) * d;
      y = c.y1 + Math.sign(dy || 1) * d;
    }
  }
  c.x2 = x;
  c.y2 = y;
}

function finishShape() {
  selEl.classList.remove('drawing');
  const c = current;
  current = null;
  if (!c) return;
  const moved = c.points ? c.points.length > 1 || c.type === 'pen' : Math.hypot(c.x2 - c.x1, c.y2 - c.y1) > 2;
  if (moved) pushShape(c);
  else renderAnn();
}

function pushShape(s) {
  shapes.push(s);
  redoStack = [];
  renderAnn();
  updateUndo();
}

function undo() {
  if (!shapes.length) return;
  redoStack.push(shapes.pop());
  renderAnn();
  updateUndo();
}

function redo() {
  if (!redoStack.length) return;
  shapes.push(redoStack.pop());
  renderAnn();
  updateUndo();
}

function renderAnn() {
  ax.setTransform(1, 0, 0, 1, 0, 0);
  ax.clearRect(0, 0, ann.width, ann.height);
  for (const s of shapes) drawShape(ax, s);
  if (current) drawShape(ax, current);
}

const tmpCanvas = document.createElement('canvas');

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function drawShape(ctx, s) {
  ctx.save();
  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = strokeWidth(s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (s.type) {
    case 'pen':
    case 'marker': {
      const p = s.points;
      if (s.type === 'marker') ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      if (p.length === 1) ctx.lineTo(p[0][0] + 0.01, p[0][1]);
      for (let i = 1; i < p.length - 1; i++) {
        const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
        ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
      }
      if (p.length > 1) ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
      ctx.stroke();
      break;
    }
    case 'line':
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
      break;
    case 'arrow': {
      const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      const head = Math.min(len * 0.7, Math.max(14, s.size * 4.5));
      const th = 0.42;
      const back = head * Math.cos(th) * 0.8;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2 - Math.cos(ang) * back, s.y2 - Math.sin(ang) * back);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 - head * Math.cos(ang - th), s.y2 - head * Math.sin(ang - th));
      ctx.lineTo(s.x2 - head * Math.cos(ang + th), s.y2 - head * Math.sin(ang + th));
      ctx.closePath();
      ctx.lineWidth = Math.max(1, s.size * 0.5);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'rect': {
      ctx.lineJoin = 'miter';
      const r = norm(s.x1, s.y1, s.x2, s.y2);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'ellipse': {
      const r = norm(s.x1, s.y1, s.x2, s.y2);
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.5, r.w / 2), Math.max(0.5, r.h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'text': {
      const fs = s.size;
      const lh = fs * 1.25;
      ctx.font = `600 ${fs}px Barlow, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'top';
      s.text.split('\n').forEach((line, i) => ctx.fillText(line, s.x + 3, s.y + 3 + i * lh + (lh - fs) / 2));
      break;
    }
    case 'blur': {
      if (!hasImage) break;
      const r = norm(s.x1, s.y1, s.x2, s.y2);
      const px = Math.round(r.x * S), py = Math.round(r.y * S);
      const pw = Math.round(r.w * S), ph = Math.round(r.h * S);
      if (pw < 1 || ph < 1) break;
      const block = Math.max(4, Math.round((s.size * 2 + 6) * S));
      const tw = Math.max(1, Math.ceil(pw / block)), tt = Math.max(1, Math.ceil(ph / block));
      tmpCanvas.width = tw;
      tmpCanvas.height = tt;
      const tx = tmpCanvas.getContext('2d');
      tx.imageSmoothingEnabled = true;
      tx.drawImage(bg, px, py, pw, ph, 0, 0, tw, tt);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.save();
      ctx.beginPath();
      ctx.rect(px, py, pw, ph);
      ctx.clip();
      ctx.drawImage(tmpCanvas, 0, 0, tw, tt, px, py, tw * block, tt * block);
      ctx.restore();
      if (s === current) {
        ctx.setTransform(S, 0, 0, S, 0, 0);
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(r.x, r.y, r.w, r.h);
      }
      break;
    }
    case 'step': {
      const r = 11 + s.size * 1.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
      ctx.fillStyle = luminance(s.color) > 0.65 ? '#111' : '#fff';
      ctx.font = `700 ${Math.round(r * 1.1)}px Barlow, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(s.n), s.x, s.y + r * 0.05);
      break;
    }
  }
  ctx.restore();
}

// ---------- text tool ----------

function openText(x, y) {
  textState = { x, y, fs: fontSize(size) };
  textEdit.value = '';
  textEdit.hidden = false;
  textEdit.style.left = x + 'px';
  textEdit.style.top = y + 'px';
  styleText();
  setTimeout(() => textEdit.focus(), 0);
}

function styleText() {
  if (!textState) return;
  textState.fs = fontSize(size);
  textEdit.style.color = color;
  textEdit.style.fontSize = textState.fs + 'px';
  autosizeText();
}

function autosizeText() {
  const fs = textState.fs;
  const lines = textEdit.value.split('\n');
  ax.save();
  ax.font = `600 ${fs}px Barlow, "Segoe UI", sans-serif`;
  const w = Math.max(...lines.map((l) => ax.measureText(l).width), fs);
  ax.restore();
  textEdit.style.width = Math.ceil(w + fs * 0.8 + 6) + 'px';
  textEdit.style.height = Math.ceil(lines.length * fs * 1.25 + 6) + 'px';
}
textEdit.addEventListener('input', autosizeText);

function commitText() {
  if (!textState) return;
  const text = textEdit.value.replace(/\s+$/, '');
  const { x, y, fs } = textState;
  textState = null;
  textEdit.hidden = true;
  if (text) pushShape({ type: 'text', x, y, text, color, size: fs });
}

function cancelText() {
  textState = null;
  textEdit.hidden = true;
}

// ---------- actions ----------

async function act(action, extra = {}) {
  if (!sel || busy || !hasImage) return;
  busy = true;
  commitText();
  const r = physRect();
  const c = document.createElement('canvas');
  c.width = r.w;
  c.height = r.h;
  const cx = c.getContext('2d');
  cx.drawImage(bg, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  cx.drawImage(ann, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  document.documentElement.style.visibility = 'hidden';
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  const png = new Uint8Array(await blob.arrayBuffer());
  api.invoke('shot:action', { action, png, w: r.w, h: r.h, ...extra });
}

function startRec(kind) {
  if (!sel || busy) return;
  if (sel.w * S < 16 || sel.h * S < 16) return showBubble('Area too small to record');
  busy = true;
  document.documentElement.style.visibility = 'hidden';
  api.invoke('rec:start', { rect: { x: sel.x, y: sel.y, width: sel.w, height: sel.h }, kind: kind || recKind });
}

function close() {
  api.send('overlay:close');
}
