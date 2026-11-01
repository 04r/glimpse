'use strict';
// Builds the installer assets into build/: icon.ico (16-256 px), icon.png, installerSidebar.bmp, installerHeader.bmp.
// Run: npx electron tools/make-assets.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { iconPNG } = require('../src/icon');

const OUT = path.join(__dirname, '..', 'build');

// ICO container holding PNG images (supported since Windows Vista)
function ico(sizes) {
  const pngs = sizes.map((s) => iconPNG(s));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    head[e] = s >= 256 ? 0 : s;
    head[e + 1] = s >= 256 ? 0 : s;
    head[e + 2] = 0;
    head[e + 3] = 0;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([head, ...pngs]);
}

// 24-bit bottom-up BMP from a BGRA bitmap
function bmp(width, height, bgra) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x++) {
      data[y * rowSize + x * 3] = bgra[src + x * 4];
      data[y * rowSize + x * 3 + 1] = bgra[src + x * 4 + 1];
      data[y * rowSize + x * 3 + 2] = bgra[src + x * 4 + 2];
    }
  }
  const h = Buffer.alloc(54);
  h.write('BM', 0);
  h.writeUInt32LE(54 + data.length, 2);
  h.writeUInt32LE(54, 10);
  h.writeUInt32LE(40, 14);
  h.writeInt32LE(width, 18);
  h.writeInt32LE(height, 22);
  h.writeUInt16LE(1, 26);
  h.writeUInt16LE(24, 28);
  h.writeUInt32LE(data.length, 34);
  h.writeInt32LE(2835, 38);
  h.writeInt32LE(2835, 42);
  return Buffer.concat([h, data]);
}

async function render(part, w2, h2, w, h) {
  const win = new BrowserWindow({ width: w2, height: h2, useContentSize: true, show: false, frame: false });
  await win.loadFile(path.join(__dirname, 'installer-art.html'), { query: { part } });
  await new Promise((r) => setTimeout(r, 600));
  const img = (await win.webContents.capturePage()).resize({ width: w, height: h, quality: 'best' });
  win.destroy();
  return img;
}

app.on('window-all-closed', () => {}); // keep running between renders
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico([16, 20, 24, 32, 40, 48, 64, 128, 256]));
  fs.writeFileSync(path.join(OUT, 'icon.png'), iconPNG(512));
  const side = await render('sidebar', 328, 628, 164, 314);
  fs.writeFileSync(path.join(OUT, 'installerSidebar.bmp'), bmp(164, 314, side.toBitmap()));
  const head = await render('header', 300, 114, 150, 57);
  fs.writeFileSync(path.join(OUT, 'installerHeader.bmp'), bmp(150, 57, head.toBitmap()));
  console.log('assets written to', OUT);
  app.exit(0);
});
