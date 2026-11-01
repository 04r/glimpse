'use strict';
// Make it pretty: a shots.so-style editor. The screenshot is drawn into a "card" (frame + rounded corners),
// the card is tilted in 3D on the GPU (perspective-correct), a blurred shadow of the tilted card is laid on the
// background, and the result exports at full resolution.
const api = window.glimpse;
const $ = (id) => document.getElementById(id);
const cv = $('cv');

$('copy').innerHTML = `${ICONS.copy}Copy`;
$('save').innerHTML = `${ICONS.save}Save`;
$('upload').innerHTML = `${ICONS.upload}Upload`;

// ---------- presets ----------

const GRADIENTS = [
  { id: 'sunrise', s: ['#ffd23f', '#ff7a59'] }, { id: 'sunset', s: ['#ff9966', '#ff5e62'] }, { id: 'peach', s: ['#ffe0c7', '#ff9a9e'] },
  { id: 'candy', s: ['#ff9ad5', '#9b7bff'] }, { id: 'mint', s: ['#b8f1d8', '#3fbf9f'] }, { id: 'ocean', s: ['#7fd3ff', '#2f6bff'] },
  { id: 'grape', s: ['#c7b3ff', '#6a4cff'] }, { id: 'lime', s: ['#e7ff8a', '#4fd18b'] }, { id: 'forest', s: ['#1f6f6e', '#76b39d'] },
  { id: 'dusk', s: ['#2b3440', '#5b4b6b'] }, { id: 'steel', s: ['#dfe4ea', '#9aa5b4'] }, { id: 'night', s: ['#0f1218', '#2a3140'] },
];
const MESHES = [
  { id: 'aurora', base: '#0e1730', b: [[0.15, 0.2, 0.75, '#3ec6a8'], [0.85, 0.2, 0.7, '#7a5cff'], [0.55, 0.95, 0.8, '#2f6bff']] },
  { id: 'bloom', base: '#ffd9c2', b: [[0.1, 0.1, 0.7, '#ff7a59'], [0.9, 0.3, 0.7, '#ffd23f'], [0.4, 0.95, 0.8, '#ff5e8a']] },
  { id: 'lagoon', base: '#d9fff4', b: [[0.2, 0.8, 0.75, '#2fbfa0'], [0.85, 0.15, 0.7, '#5ab8ff'], [0.6, 0.6, 0.5, '#b2f5ff']] },
  { id: 'berry', base: '#2a0f2f', b: [[0.2, 0.2, 0.7, '#ff4f8b'], [0.8, 0.8, 0.8, '#6a4cff'], [0.85, 0.15, 0.5, '#ff9a5a']] },
  { id: 'cloud', base: '#eef1f6', b: [[0.2, 0.2, 0.7, '#ffffff'], [0.8, 0.85, 0.8, '#cfd8ea'], [0.85, 0.2, 0.6, '#f6e7ff']] },
  { id: 'ember', base: '#160d0a', b: [[0.25, 0.85, 0.8, '#ff5a1f'], [0.8, 0.2, 0.6, '#ffb23f'], [0.6, 0.55, 0.4, '#ff2e63']] },
  { id: 'meadow', base: '#f2ffe0', b: [[0.15, 0.25, 0.7, '#b6f26a'], [0.85, 0.75, 0.8, '#3fbf9f'], [0.8, 0.1, 0.5, '#fff27a']] },
  { id: 'midnight', base: '#05070d', b: [[0.2, 0.15, 0.7, '#1d3b8f'], [0.85, 0.9, 0.8, '#3b1d8f'], [0.6, 0.4, 0.4, '#0f5c6b']] },
];
const SOLIDS = ['#1c2027', '#0d0f12', '#2b3440', '#ffffff', '#f4f5f7', '#e9e4d9', '#ffd23f', '#ff7a59', '#ff5e8a', '#3fbf9f', '#2f6bff', '#7a5cff'];
const FRAMES = [
  { id: 'none', label: 'None' }, { id: 'glass', label: 'Glass' }, { id: 'browser', label: 'Browser' }, { id: 'browserDark', label: 'Dark' },
  { id: 'window', label: 'Window' }, { id: 'phone', label: 'Phone' }, { id: 'tablet', label: 'Tablet' }, { id: 'laptop', label: 'Laptop' },
];
const TILTS = [
  { id: 'flat', label: 'Flat', rx: 0, ry: 0, rz: 0 },
  { id: 'left', label: 'Left', rx: 4, ry: 30, rz: 0 },
  { id: 'right', label: 'Right', rx: 4, ry: -30, rz: 0 },
  { id: 'back', label: 'Lay back', rx: -38, ry: 0, rz: 0 },
  { id: 'isoL', label: 'Iso', rx: -52, ry: 0, rz: -38 },
  { id: 'isoR', label: 'Iso flip', rx: -52, ry: 0, rz: 38 },
  { id: 'hero', label: 'Hero', rx: -18, ry: -24, rz: 5 },
  { id: 'tilt', label: 'Tilt', rx: 0, ry: 0, rz: -7 },
];
const SHADOWS = [
  { id: 'none', label: 'None' },
  { id: 'soft', label: 'Soft', b: 0.035, dy: 0.022, a: 0.42, sc: 1 },
  { id: 'deep', label: 'Deep', b: 0.07, dy: 0.05, a: 0.6, sc: 1, contact: true },
  { id: 'float', label: 'Float', b: 0.09, dy: 0.09, a: 0.42, sc: 0.88 },
  { id: 'hard', label: 'Hard', b: 0, dx: 0.02, dy: 0.024, a: 0.3, sc: 1 },
];
const SIZES = [
  { id: 'auto', label: 'Auto' }, { id: '16:9', w: 1920, h: 1080 }, { id: '4:3', w: 1600, h: 1200 }, { id: '3:2', w: 1800, h: 1200 },
  { id: '1:1', w: 1600, h: 1600 }, { id: '4:5', w: 1440, h: 1800 }, { id: '9:16', w: 1080, h: 1920 },
];

const DEFAULTS = {
  frame: 'browser', url: '', rad: 16, border: 0, borderColor: 'light', shadow: 'soft', shadowStr: 60,
  tilt: 'flat', rx: 0, ry: 0, rz: 0, depth: 60, zoom: 82, ox: 0, oy: 0,
  bgKind: 'gradient', bg: 'sunrise', custom: '#ffd23f', grain: false, size: 'auto', scale: 1,
};
let opt = { ...DEFAULTS };
try {
  opt = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('pretty2') || '{}'), url: '' };
} catch {}
const save = () => {
  try {
    localStorage.setItem('pretty2', JSON.stringify(opt));
  } catch {}
};

let img = null;

// ---------- 2D helpers ----------

function rr(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function cover(c, im, x, y, w, h) {
  const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
  const s = Math.max(w / iw, h / ih);
  const sw = w / s, sh = h / s;
  c.drawImage(im, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// ---------- the card: screenshot + frame ----------

let card = null, cardKey = '';
function buildCard() {
  const key = JSON.stringify([opt.frame, opt.url, opt.rad, opt.border, opt.borderColor, img && img.src.length]);
  if (card && key === cardKey) return card;
  cardKey = key;
  const s = Math.min(1, 3600 / Math.max(img.naturalWidth, img.naturalHeight));
  const iw = Math.round(img.naturalWidth * s), ih = Math.round(img.naturalHeight * s);
  const L = Math.max(iw, ih);
  const u = L / 1000;
  const r = opt.rad * u;
  const bw = opt.border * u;
  const border = opt.borderColor === 'dark' ? 'rgba(0,0,0,0.38)' : 'rgba(255,255,255,0.6)';
  let c, x;
  const f = opt.frame;
  const outline = (w, h, rad) => {
    if (!bw) return;
    x.save();
    x.lineWidth = bw;
    x.strokeStyle = border;
    rr(x, bw / 2, bw / 2, w - bw, h - bw, Math.max(0, rad - bw / 2));
    x.stroke();
    x.restore();
  };

  if (f === 'glass') {
    const g = Math.round(L * 0.024);
    c = canvas(iw + g * 2, ih + g * 2);
    x = c.getContext('2d');
    rr(x, 0, 0, c.width, c.height, r + g);
    x.fillStyle = 'rgba(255,255,255,0.22)';
    x.fill();
    x.lineWidth = Math.max(1, 1.6 * u);
    x.strokeStyle = 'rgba(255,255,255,0.55)';
    x.stroke();
    x.save();
    rr(x, g, g, iw, ih, r);
    x.clip();
    x.drawImage(img, g, g, iw, ih);
    x.restore();
    outline(c.width, c.height, r + g);
  } else if (f === 'browser' || f === 'browserDark' || f === 'window') {
    const dark = f === 'browserDark';
    const barH = Math.round(L * (f === 'window' ? 0.034 : 0.046));
    c = canvas(iw, ih + barH);
    x = c.getContext('2d');
    x.save();
    rr(x, 0, 0, c.width, c.height, r);
    x.clip();
    x.fillStyle = dark ? '#262a32' : '#eef0f3';
    x.fillRect(0, 0, c.width, barH);
    x.fillStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)';
    x.fillRect(0, barH - Math.max(1, u), c.width, Math.max(1, u));
    const dr = barH * 0.13;
    ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => {
      x.beginPath();
      x.arc(barH * 0.62 + i * dr * 3.3, barH / 2, dr, 0, Math.PI * 2);
      x.fillStyle = col;
      x.fill();
    });
    if (f !== 'window') {
      const pw = Math.min(iw * 0.46, iw - barH * 4), ph = barH * 0.56;
      rr(x, (iw - pw) / 2, (barH - ph) / 2, pw, ph, ph / 2);
      x.fillStyle = dark ? '#1b1e24' : '#ffffff';
      x.fill();
      if (opt.url) {
        x.fillStyle = dark ? '#9aa0aa' : '#6b7280';
        x.font = `500 ${Math.round(ph * 0.52)}px "Barlow", "Segoe UI", sans-serif`;
        x.textAlign = 'center';
        x.textBaseline = 'middle';
        x.fillText(opt.url, iw / 2, barH / 2 + ph * 0.03, pw * 0.9);
      }
    }
    x.drawImage(img, 0, barH, iw, ih);
    x.restore();
    outline(c.width, c.height, r);
  } else if (f === 'phone') {
    const land = iw > ih;
    // screen keeps a phone-like shape; the screenshot is fitted inside, never cropped
    const ratio = Math.min(2.3, Math.max(1.9, Math.max(iw, ih) / Math.min(iw, ih)));
    const SL = Math.max(iw, ih), SS = Math.round(Math.max(Math.min(iw, ih), SL / ratio));
    const SL2 = Math.round(SS * ratio);
    const sw = land ? SL2 : SS, sh = land ? SS : SL2;
    const b = Math.round(SS * 0.045);
    const R = SS * 0.165;
    c = canvas(sw + b * 2, sh + b * 2);
    x = c.getContext('2d');
    const gr = x.createLinearGradient(0, 0, c.width, c.height);
    gr.addColorStop(0, '#30343c');
    gr.addColorStop(1, '#101215');
    rr(x, 0, 0, c.width, c.height, R);
    x.fillStyle = gr;
    x.fill();
    x.lineWidth = Math.max(1, b * 0.16);
    x.strokeStyle = '#4a4f59';
    x.stroke();
    x.save();
    rr(x, b, b, sw, sh, R - b * 0.95);
    x.clip();
    // fill the spare screen area with the screenshot's own edge colour so it blends in
    const px = canvas(1, 1).getContext('2d');
    px.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1);
    const [pr, pg, pb] = px.getImageData(0, 0, 1, 1).data;
    x.fillStyle = `rgb(${pr},${pg},${pb})`;
    x.fillRect(b, b, sw, sh);
    // portrait shots leave room under the island; landscape ones sit centred
    const top = land ? 0 : Math.min(SS * 0.16, Math.max(0, sh - ih));
    const k = Math.min(sw / iw, (sh - top) / ih);
    const dw = iw * k, dh = ih * k;
    x.drawImage(img, b + (sw - dw) / 2, b + top + (sh - top - dh) / 2, dw, dh);
    x.restore();
    // camera: island on portrait, a small lens in the bezel on landscape
    x.fillStyle = '#050506';
    if (land) {
      x.beginPath();
      x.arc(b / 2, c.height / 2, b * 0.22, 0, Math.PI * 2);
      x.fillStyle = '#23262c';
      x.fill();
    } else {
      const iL = SS * 0.27, iT = SS * 0.075;
      rr(x, (c.width - iL) / 2, b + SS * 0.035, iL, iT, iT / 2);
      x.fill();
    }
  } else if (f === 'tablet') {
    const S = Math.min(iw, ih);
    const b = Math.round(S * 0.05);
    const R = S * 0.05 + b;
    c = canvas(iw + b * 2, ih + b * 2);
    x = c.getContext('2d');
    rr(x, 0, 0, c.width, c.height, R);
    x.fillStyle = '#16181c';
    x.fill();
    x.lineWidth = Math.max(1, b * 0.12);
    x.strokeStyle = '#3d424b';
    x.stroke();
    x.save();
    rr(x, b, b, iw, ih, R - b);
    x.clip();
    x.drawImage(img, b, b, iw, ih);
    x.restore();
    x.beginPath();
    x.arc(c.width / 2, b / 2, b * 0.13, 0, Math.PI * 2);
    x.fillStyle = '#2c3038';
    x.fill();
  } else if (f === 'laptop') {
    const b = Math.round(iw * 0.022), chin = Math.round(b * 1.9);
    const lw = iw + b * 2, lh = ih + b + chin;
    const bwid = Math.round(lw * 1.16), bh = Math.round(lw * 0.036);
    c = canvas(bwid, lh + bh);
    x = c.getContext('2d');
    const lx = (bwid - lw) / 2;
    rr(x, lx, 0, lw, lh + b, b * 1.4);
    x.fillStyle = '#17191d';
    x.fill();
    x.lineWidth = Math.max(1, b * 0.1);
    x.strokeStyle = '#3a3e46';
    x.stroke();
    x.drawImage(img, lx + b, b, iw, ih);
    x.beginPath();
    x.arc(bwid / 2, b / 2, b * 0.16, 0, Math.PI * 2);
    x.fillStyle = '#30343c';
    x.fill();
    const gr = x.createLinearGradient(0, lh, 0, lh + bh);
    gr.addColorStop(0, '#e2e5ea');
    gr.addColorStop(0.55, '#b9bec6');
    gr.addColorStop(1, '#8d929a');
    x.beginPath();
    x.moveTo(0, lh);
    x.lineTo(bwid, lh);
    x.lineTo(bwid - bh * 0.6, lh + bh);
    x.lineTo(bh * 0.6, lh + bh);
    x.closePath();
    x.fillStyle = gr;
    x.fill();
    rr(x, bwid / 2 - lw * 0.08, lh, lw * 0.16, bh * 0.38, bh * 0.19);
    x.fillStyle = '#9da2aa';
    x.fill();
  } else {
    c = canvas(iw, ih);
    x = c.getContext('2d');
    x.save();
    rr(x, 0, 0, iw, ih, r);
    x.clip();
    x.drawImage(img, 0, 0, iw, ih);
    x.restore();
    outline(iw, ih, r);
  }
  card = c;
  return c;
}

// ---------- 3D projection ----------

const RAD = Math.PI / 180;
// corners of a w x h card tilted by (rx, ry, rz), in projected pixels; order TL, TR, BL, BR. w = depth for the GPU.
function project(w, h, rx, ry, rz, depth) {
  const f = Math.max(w, h) * (0.9 + ((100 - depth) / 100) * 6);
  const ax = rx * RAD, ay = ry * RAD, az = rz * RAD;
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2]].map(([x0, y0]) => {
    const x1 = x0 * Math.cos(az) - y0 * Math.sin(az), y1 = x0 * Math.sin(az) + y0 * Math.cos(az);
    const y2 = y1 * Math.cos(ax), z2 = y1 * Math.sin(ax);
    const x3 = x1 * Math.cos(ay) + z2 * Math.sin(ay), z3 = -x1 * Math.sin(ay) + z2 * Math.cos(ay);
    const zc = f + z3;
    return { x: (x3 * f) / zc, y: (y2 * f) / zc, w: zc / f };
  });
}

// output size and where the card's corners land
function layout(cw, ch, scaleMul) {
  const P = project(cw, ch, opt.rx, opt.ry, opt.rz, opt.depth);
  const xs = P.map((p) => p.x), ys = P.map((p) => p.y);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const bw = maxx - minx, bh = maxy - miny;
  const zoom = opt.zoom / 100;
  const size = SIZES.find((s) => s.id === opt.size) || SIZES[0];
  let W, H;
  if (size.id === 'auto') {
    W = bw / zoom;
    H = bh / zoom;
  } else {
    W = size.w;
    H = size.h;
  }
  W = Math.round(W * scaleMul);
  H = Math.round(H * scaleMul);
  const k = Math.min((W * zoom) / bw, (H * zoom) / bh);
  const fx = (W - bw * k) / 2, fy = (H - bh * k) / 2;
  const cx = W / 2 + (opt.ox / 50) * fx, cy = H / 2 + (opt.oy / 50) * fy;
  const mx = (minx + maxx) / 2, my = (miny + maxy) / 2;
  return {
    W, H, size: Math.max(bw, bh) * k,
    pts: P.map((p) => ({ x: (p.x - mx) * k + cx, y: (p.y - my) * k + cy, w: p.w })),
  };
}

// ---------- GPU: draw the tilted card (perspective-correct) ----------

const glc = document.createElement('canvas');
const gl = glc.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true, alpha: true });
const prog = (() => {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, 'attribute vec4 aPos; attribute vec2 aUV; varying vec2 vUV; void main() { gl_Position = aPos; vUV = aUV; }'));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER,
    'precision mediump float; varying vec2 vUV; uniform sampler2D uTex; uniform float uSil;' +
    'void main() { vec4 c = texture2D(uTex, vUV); gl_FragColor = uSil > 0.5 ? vec4(0.0, 0.0, 0.0, c.a) : c; }'));
  gl.linkProgram(p);
  return p;
})();
const posBuf = gl.createBuffer();
const uvBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
const tex = gl.createTexture();
let texFor = null;

function upload(c) {
  if (texFor === c) return;
  texFor = c;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
}

function drawQuad(W, H, pts, silhouette) {
  if (glc.width !== W || glc.height !== H) {
    glc.width = W;
    glc.height = H;
  }
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(prog);
  const v = [];
  for (const p of pts) v.push((p.x / W * 2 - 1) * p.w, (1 - p.y / H * 2) * p.w, 0, p.w);
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 4, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  const aUV = gl.getAttribLocation(prog, 'aUV');
  gl.enableVertexAttribArray(aUV);
  gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
  gl.uniform1f(gl.getUniformLocation(prog, 'uSil'), silhouette ? 1 : 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// ---------- background, grain, shadow ----------

function bgPaint(c, W, H) {
  c.clearRect(0, 0, W, H);
  if (opt.bgKind === 'gradient') {
    const g = GRADIENTS.find((x) => x.id === opt.bg) || GRADIENTS[0];
    const gr = c.createLinearGradient(0, 0, W, H);
    gr.addColorStop(0, g.s[0]);
    gr.addColorStop(1, g.s[1]);
    c.fillStyle = gr;
    c.fillRect(0, 0, W, H);
  } else if (opt.bgKind === 'mesh') {
    const m = MESHES.find((x) => x.id === opt.bg) || MESHES[0];
    c.fillStyle = m.base;
    c.fillRect(0, 0, W, H);
    const D = Math.max(W, H);
    for (const [bx, by, br, col] of m.b) {
      const gr = c.createRadialGradient(bx * W, by * H, 0, bx * W, by * H, br * D);
      gr.addColorStop(0, col);
      gr.addColorStop(1, col + '00');
      c.fillStyle = gr;
      c.fillRect(0, 0, W, H);
    }
  } else if (opt.bgKind === 'solid') {
    c.fillStyle = opt.bg === 'custom' ? opt.custom : SOLIDS.includes(opt.bg) ? opt.bg : SOLIDS[0];
    c.fillRect(0, 0, W, H);
  } else if (opt.bgKind === 'blur') {
    const D = Math.max(W, H);
    c.save();
    c.filter = `blur(${Math.round(D * 0.04)}px) saturate(1.3)`;
    cover(c, img, -D * 0.08, -D * 0.08, W + D * 0.16, H + D * 0.16);
    c.restore();
    c.fillStyle = 'rgba(0,0,0,0.12)';
    c.fillRect(0, 0, W, H);
  }
  if (opt.grain && opt.bgKind !== 'none') {
    c.save();
    c.globalAlpha = 0.5;
    c.fillStyle = c.createPattern(noiseTile(), 'repeat');
    c.fillRect(0, 0, W, H);
    c.restore();
  }
}

let noise = null;
function noiseTile() {
  if (noise) return noise;
  noise = canvas(160, 160);
  const x = noise.getContext('2d');
  const d = x.createImageData(160, 160);
  let s = 1234567;
  for (let i = 0; i < d.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = s & 1 ? 255 : 0;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = 22 + (s >> 8) % 18;
  }
  x.putImageData(d, 0, 0);
  return noise;
}

function shadowPaint(c, L) {
  const s = SHADOWS.find((x) => x.id === opt.shadow);
  if (!s || !s.a) return;
  const strength = opt.shadowStr / 60;
  const pass = (blur, dx, dy, alpha, sc) => {
    const cx = L.pts.reduce((a, p) => a + p.x, 0) / 4, cy = L.pts.reduce((a, p) => a + p.y, 0) / 4;
    const pts = L.pts.map((p) => ({ x: cx + (p.x - cx) * sc + dx * L.size, y: cy + (p.y - cy) * sc + dy * L.size, w: p.w }));
    drawQuad(L.W, L.H, pts, true);
    c.save();
    c.globalAlpha = Math.min(1, alpha * strength);
    if (blur) c.filter = `blur(${Math.max(1, Math.round(blur * L.size))}px)`;
    c.drawImage(glc, 0, 0);
    c.restore();
  };
  pass(s.b, s.dx || 0, s.dy, s.a, s.sc);
  if (s.contact) pass(0.012, 0, 0.008, 0.35, 1);
}

// ---------- render ----------

function render(target, scaleMul, maxSide) {
  if (!img) return null;
  const cd = buildCard();
  const L = layout(cd.width, cd.height, scaleMul);
  if (maxSide) {
    const p = Math.min(1, maxSide / Math.max(L.W, L.H));
    L.W = Math.max(1, Math.round(L.W * p));
    L.H = Math.max(1, Math.round(L.H * p));
    L.size *= p;
    L.pts = L.pts.map((q) => ({ x: q.x * p, y: q.y * p, w: q.w }));
  }
  target.width = L.W;
  target.height = L.H;
  const c = target.getContext('2d');
  bgPaint(c, L.W, L.H);
  upload(cd);
  shadowPaint(c, L);
  drawQuad(L.W, L.H, L.pts, false);
  c.drawImage(glc, 0, 0);
  return L;
}

let pending = false;
function draw() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const full = layout(...(img ? [buildCard().width, buildCard().height] : [1, 1]), opt.scale);
    render(cv, 1, 1700);
    $('dims').textContent = img ? `${full.W} × ${full.H}` : '';
  });
}

// ---------- controls ----------

function el(tag, props = {}, html = '') {
  const e = Object.assign(document.createElement(tag), props);
  if (html) e.innerHTML = html;
  return e;
}
function set(k, v) {
  opt[k] = v;
  save();
  sync();
  draw();
}

// canvas size chips
for (const s of SIZES) {
  const ar = s.w ? s.w / s.h : 1.4;
  const iw = ar >= 1 ? 16 : 16 * ar, ih = ar >= 1 ? 16 / ar : 16;
  const b = el('button', { title: s.w ? `${s.w} × ${s.h}` : 'Fit the screenshot' }, s.id === 'auto' ? 'Auto' : `<i style="width:${iw}px;height:${ih}px"></i>${s.id}`);
  b.dataset.v = s.id;
  b.onclick = () => set('size', s.id);
  $('sizes').append(b);
}

// frames
const FRAME_ICON = {
  none: '<rect x="6" y="9" width="36" height="24" rx="4" fill="currentColor" opacity=".35"/>',
  glass: '<rect x="4" y="7" width="40" height="28" rx="6" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".6"/><rect x="8" y="11" width="32" height="20" rx="3" fill="currentColor" opacity=".35"/>',
  browser: '<rect x="5" y="8" width="38" height="27" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 14h38" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="11" r="1" fill="currentColor"/><circle cx="12" cy="11" r="1" fill="currentColor"/><rect x="18" y="10" width="14" height="2.4" rx="1.2" fill="currentColor" opacity=".5"/>',
  browserDark: '<rect x="5" y="8" width="38" height="27" rx="3.5" fill="currentColor" opacity=".25"/><rect x="5" y="8" width="38" height="6" rx="3" fill="currentColor"/><rect x="18" y="10" width="14" height="2.4" rx="1.2" fill="#1c2027"/>',
  window: '<rect x="5" y="8" width="38" height="27" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 13h38" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10.6" r="1" fill="currentColor"/><circle cx="12" cy="10.6" r="1" fill="currentColor"/><circle cx="15" cy="10.6" r="1" fill="currentColor"/>',
  phone: '<rect x="16" y="4" width="16" height="34" rx="4" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="21" y="6.5" width="6" height="1.8" rx=".9" fill="currentColor"/>',
  tablet: '<rect x="9" y="6" width="30" height="30" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="12" y="9" width="24" height="24" rx="1.5" fill="currentColor" opacity=".3"/>',
  laptop: '<rect x="10" y="8" width="28" height="19" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 30h38l-2 3H7z" fill="currentColor"/>',
};
for (const f of FRAMES) {
  const b = el('button', { className: 'tile', title: f.label }, `<svg width="48" height="40" viewBox="0 0 48 42">${FRAME_ICON[f.id]}</svg><span>${f.label}</span>`);
  b.dataset.v = f.id;
  b.onclick = () => set('frame', f.id);
  $('frames').append(b);
}
$('url').addEventListener('input', () => set('url', $('url').value.slice(0, 60)));

// tilt presets, previewed with the same projection the card uses
for (const t of TILTS) {
  const P = project(40, 28, t.rx, t.ry, t.rz, 40);
  const xs = P.map((p) => p.x), ys = P.map((p) => p.y);
  const sc = Math.min(34 / (Math.max(...xs) - Math.min(...xs)), 24 / (Math.max(...ys) - Math.min(...ys)), 1);
  const mx = (Math.max(...xs) + Math.min(...xs)) / 2, my = (Math.max(...ys) + Math.min(...ys)) / 2;
  const q = (i) => `${(24 + (P[i].x - mx) * sc).toFixed(1)},${(17 + (P[i].y - my) * sc).toFixed(1)}`;
  const b = el('button', { className: 'tile', title: t.label },
    `<svg width="48" height="34" viewBox="0 0 48 34"><polygon points="${q(0)} ${q(1)} ${q(3)} ${q(2)}" fill="currentColor" opacity=".32" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg><span>${t.label}</span>`);
  b.dataset.v = t.id;
  b.onclick = () => {
    opt.rx = t.rx;
    opt.ry = t.ry;
    opt.rz = t.rz;
    set('tilt', t.id);
  };
  $('tilts').append(b);
}

// shadow presets
const SHADOW_ICON = {
  none: '<rect x="12" y="8" width="22" height="16" rx="3" fill="currentColor" opacity=".35"/>',
  soft: '<rect x="12" y="11" width="22" height="16" rx="3" fill="currentColor" opacity=".18"/><rect x="12" y="8" width="22" height="16" rx="3" fill="currentColor" opacity=".55"/>',
  deep: '<rect x="11" y="13" width="24" height="17" rx="4" fill="currentColor" opacity=".22"/><rect x="12" y="7" width="22" height="16" rx="3" fill="currentColor" opacity=".6"/>',
  float: '<ellipse cx="23" cy="29" rx="10" ry="2.4" fill="currentColor" opacity=".3"/><rect x="12" y="5" width="22" height="16" rx="3" fill="currentColor" opacity=".55"/>',
  hard: '<rect x="15" y="11" width="22" height="16" rx="3" fill="currentColor" opacity=".3"/><rect x="11" y="7" width="22" height="16" rx="3" fill="currentColor" opacity=".6"/>',
};
for (const s of SHADOWS) {
  const b = el('button', { className: 'tile', title: s.label }, `<svg width="44" height="32" viewBox="0 0 46 34">${SHADOW_ICON[s.id]}</svg><span>${s.label}</span>`);
  b.dataset.v = s.id;
  b.onclick = () => set('shadow', s.id);
  $('shadows').append(b);
}

// sliders
const SLIDERS = { rad: '', border: '', shadowStr: '%', rx: '°', ry: '°', rz: '°', depth: '', zoom: '%', ox: '', oy: '' };
for (const [id, unit] of Object.entries(SLIDERS)) {
  $(id).addEventListener('input', () => {
    opt[id] = +$(id).value;
    if (id === 'rx' || id === 'ry' || id === 'rz') opt.tilt = 'custom';
    save();
    sync();
    draw();
  });
  $(id).addEventListener('dblclick', () => set(id, DEFAULTS[id]));
}
for (const id of ['borderColor', 'scale', 'bgKind']) {
  for (const b of $(id).querySelectorAll('button')) {
    b.onclick = () => {
      const v = id === 'scale' ? +b.dataset.v : b.dataset.v;
      if (id === 'bgKind') {
        opt.bg = v === 'gradient' ? GRADIENTS[0].id : v === 'mesh' ? MESHES[0].id : v === 'solid' ? SOLIDS[0] : '';
      }
      set(id, v);
    };
  }
}
$('custom').addEventListener('input', () => {
  opt.custom = $('custom').value;
  set('bg', 'custom');
});
$('grain').addEventListener('change', () => set('grain', $('grain').checked));

function swatches() {
  const box = $('bgs');
  box.textContent = '';
  let list = [];
  if (opt.bgKind === 'gradient') list = GRADIENTS.map((g) => ({ id: g.id, css: `linear-gradient(135deg, ${g.s[0]}, ${g.s[1]})` }));
  if (opt.bgKind === 'mesh') {
    list = MESHES.map((m) => ({
      id: m.id,
      css: m.b.map(([x, y, r, col]) => `radial-gradient(circle at ${x * 100}% ${y * 100}%, ${col} 0, ${col}00 ${r * 100}%)`).join(',') + `, ${m.base}`,
    }));
  }
  if (opt.bgKind === 'solid') list = SOLIDS.map((c) => ({ id: c, css: c }));
  box.hidden = !list.length;
  for (const s of list) {
    const b = el('button', { title: s.id });
    b.style.background = s.css;
    b.dataset.v = s.id;
    b.onclick = () => set('bg', s.id);
    box.append(b);
  }
}

function sync() {
  const on = (box, v) => { for (const b of $(box).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === String(v)); };
  on('sizes', opt.size);
  on('frames', opt.frame);
  on('tilts', opt.tilt);
  on('shadows', opt.shadow);
  on('borderColor', opt.borderColor);
  on('scale', opt.scale);
  on('bgKind', opt.bgKind);
  if ($('bgs').dataset.kind !== opt.bgKind) {
    $('bgs').dataset.kind = opt.bgKind;
    swatches();
  }
  on('bgs', opt.bg);
  for (const [id, unit] of Object.entries(SLIDERS)) {
    $(id).value = opt[id];
    $(id + 'V').textContent = opt[id] + unit;
  }
  $('urlRow').hidden = !(opt.frame === 'browser' || opt.frame === 'browserDark');
  $('customRow').hidden = opt.bgKind !== 'solid';
  $('custom').value = opt.custom;
  $('grain').checked = !!opt.grain;
  const device = ['phone', 'tablet', 'laptop'].includes(opt.frame);
  $('rad').disabled = $('border').disabled = device;
}

// ---------- in / out ----------

api.on('pretty:init', ({ fileUrl }) => {
  const im = new Image();
  im.onload = () => {
    img = im;
    card = null;
    sync();
    draw();
  };
  im.src = fileUrl;
});

let busy = false;
async function run(action) {
  if (busy || !img) return;
  busy = true;
  $('status').textContent = 'Rendering…';
  await new Promise((r) => setTimeout(r, 20));
  const out = document.createElement('canvas');
  render(out, opt.scale, 0);
  const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  const png = new Uint8Array(await blob.arrayBuffer());
  const res = await api.invoke('pretty:action', { action, png, w: out.width, h: out.height });
  busy = false;
  if (!res || res.error) {
    $('status').textContent = `Couldn’t finish: ${(res && res.error) || 'unknown error'}`;
    return;
  }
  $('status').textContent = '';
  const b = document.createElement('b');
  b.textContent = { copy: 'Copied', save: 'Saved', upload: 'Link copied' }[action];
  $('status').append(b, ` ${out.width} × ${out.height}`);
}
$('copy').onclick = () => run('copy');
$('save').onclick = () => run('save');
$('upload').onclick = () => run('upload');
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
  const k = e.key.toLowerCase();
  if (!(e.ctrlKey || e.metaKey)) return;
  if (k === 'c') { e.preventDefault(); run('copy'); }
  if (k === 's') { e.preventDefault(); run('save'); }
  if (k === 'd') { e.preventDefault(); run('upload'); }
});
addEventListener('resize', draw);
sync();
