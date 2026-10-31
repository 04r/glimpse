'use strict';
// `electron . --docs`: renders the README screenshots into docs/ from a neutral sample page
// (tools/sample-desktop.html) and demo history, so no personal screen content ever ends up in the repo.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const ff = require('./ffmpeg');

// Demo history written before the app loads it (called from main.js at startup).
function seed(userData) {
  const cap = path.join(userData, 'captures');
  fs.mkdirSync(cap, { recursive: true });
  const now = Date.now();
  const e = (id, type, ext, w, h, ago, extra = {}) => ({
    id, type, ext, file: path.join(cap, `${id}.${ext}`), w, h, size: 0, date: now - ago * 1000, url: null, savedPath: null, ...extra,
  });
  const history = [
    e('doc1', 'image', 'png', 1026, 496, 95),
    e('doc2', 'gif', 'gif', 640, 309, 60 * 14, { url: 'https://files.catbox.moe/7f3k2a.gif' }),
    e('doc3', 'image', 'png', 470, 240, 60 * 52, { savedPath: 'C:\\Users\\you\\Pictures\\Glimpse\\Trip details.png' }),
    e('doc4', 'video', 'mp4', 952, 460, 60 * 60 * 3),
    e('doc5', 'image', 'png', 1680, 972, 60 * 60 * 26, { url: 'https://files.catbox.moe/q81mzd.png' }),
    e('doc6', 'image', 'png', 470, 300, 60 * 60 * 27),
  ];
  fs.writeFileSync(path.join(userData, 'history.json'), JSON.stringify(history));
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ saveDir: 'C:\\Users\\you\\Pictures\\Glimpse', snipWarned: true })
  );
}

async function run({ preload, userData }) {
  const out = path.join(__dirname, '..', 'docs');
  const tmp = path.join(app.getPath('temp'), 'glimpse-docs-tmp');
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const cap = path.join(userData, 'captures');
  const log = (...a) => console.log('[docs]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const UI = (f) => path.join(__dirname, 'ui', f);
  const win = async (file, w, h, { transparent = false, query } = {}) => {
    const b = new BrowserWindow({
      width: w, height: h, useContentSize: true, show: false, frame: false, transparent,
      backgroundColor: transparent ? '#00000000' : '#1c2027',
      webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    await b.loadFile(file, query ? { query } : undefined);
    return b;
  };
  const grab = async (b) => (await b.webContents.capturePage()).resize({ width: b.getContentSize()[0] });
  const js = (b, code) => b.webContents.executeJavaScript(code);
  const save = async (b, name) => {
    await wait(400);
    fs.writeFileSync(path.join(out, name), (await grab(b)).toPNG());
    log('saved', name);
  };

  try {
    // 1. the sample desktop, plus a plane-less copy of its hero for the demo clip
    const desk = await win(path.join(__dirname, '..', 'tools', 'sample-desktop.html'), 1920, 1080);
    await wait(500);
    const sample = await grab(desk);
    const samplePng = path.join(tmp, 'sample.png');
    fs.writeFileSync(samplePng, sample.toPNG());
    const heroRect = await js(desk, `(() => { const r = document.querySelector('.hero').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
    const cardRect = await js(desk, `(() => { const r = document.querySelector('.card').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
    const daysRect = { x: cardRect.x, y: cardRect.y + cardRect.height + 20, width: cardRect.width, height: 300 };
    fs.writeFileSync(path.join(cap, 'doc1.png'), sample.crop(heroRect).toPNG());
    fs.writeFileSync(path.join(cap, 'doc3.png'), sample.crop(cardRect).toPNG());
    fs.writeFileSync(path.join(cap, 'doc5.png'), sample.crop({ x: 120, y: 54, width: 1680, height: 972 }).toPNG());
    fs.writeFileSync(path.join(cap, 'doc6.png'), sample.crop(daysRect).toPNG());
    await js(desk, `document.querySelector('.plane').style.display = 'none'; true`);
    await wait(200);
    const heroBg = (await grab(desk)).crop(heroRect);
    fs.writeFileSync(path.join(tmp, 'hero.png'), heroBg.toPNG());
    desk.destroy();

    // the paper plane on a transparent page
    const planeWin = new BrowserWindow({ width: 120, height: 80, useContentSize: true, show: false, frame: false, transparent: true, backgroundColor: '#00000000' });
    await planeWin.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:transparent"><svg viewBox="0 0 120 80" width="120" height="80"><polygon points="4,40 116,6 60,74" fill="#fff"/><polygon points="116,6 60,74 52,48" fill="#dfe6ec"/><polygon points="116,6 52,48 40,62" fill="#c5d0d8"/></svg></body>'));
    await wait(300);
    fs.writeFileSync(path.join(tmp, 'plane.png'), (await planeWin.webContents.capturePage()).toPNG());
    planeWin.destroy();

    // 2. a 3 s demo clip of the plane gliding over the hero, as MP4 and GIF
    const bin = ff.bin();
    const clip = path.join(cap, 'doc4.mp4');
    const W = heroRect.width - (heroRect.width % 2), H = heroRect.height - (heroRect.height % 2);
    execFileSync(bin, ['-y', '-loop', '1', '-i', path.join(tmp, 'hero.png'), '-loop', '1', '-i', path.join(tmp, 'plane.png'),
      '-filter_complex', `[1]scale=96:-1[p];[0]crop=${W}:${H}:0:0[b];[b][p]overlay=x='40+t*300':y='150-t*20+40*sin(t*2.6)':shortest=1,format=yuv420p`,
      '-t', '3', '-r', '30', '-c:v', 'libx264', '-crf', '18', clip], { stdio: 'ignore' });
    execFileSync(bin, ['-y', '-i', clip, '-vf', 'fps=15,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', path.join(cap, 'doc2.gif')], { stdio: 'ignore' });
    for (const id of ['doc1.png', 'doc2.gif', 'doc3.png', 'doc4.mp4', 'doc5.png', 'doc6.png']) {
      const f = path.join(cap, id);
      if (!fs.existsSync(f)) throw new Error('missing ' + id);
    }
    const hist = JSON.parse(fs.readFileSync(path.join(userData, 'history.json'), 'utf8'));
    for (const h of hist) h.size = fs.statSync(h.file).size;
    fs.writeFileSync(path.join(userData, 'history.json'), JSON.stringify(hist));

    // 3. capture overlay over the sample, with mark-up
    const img = sample.resize({ width: 1600, height: 900, quality: 'best' });
    const image = { width: 1600, height: 900, data: img.toBitmap(), rgba: false };
    const k = 1600 / 1920;
    const sel = { x: Math.round(heroRect.x * k) - 14, y: Math.round(heroRect.y * k) - 14, w: Math.round(heroRect.width * k) + 28, h: Math.round(heroRect.height * k) + 28 };
    const ov = await win(UI('overlay.html'), 1600, 900);
    ov.webContents.send('overlay:arm', { gen: 1, mode: 'shot', showMagnifier: true });
    ov.webContents.send('overlay:image', { gen: 1, image });
    await wait(300);
    const px = (fx, fy) => [Math.round(sel.x + sel.w * fx), Math.round(sel.y + sel.h * fy)];
    const [ax1, ay1] = px(0.22, 0.86), [ax2, ay2] = px(0.43, 0.42), [tx, ty] = px(0.06, 0.08), [sx, sy] = px(0.93, 0.12);
    await js(ov, `(() => {
      sel = ${JSON.stringify(sel)};
      shapes.push({ type: 'arrow', color: '#ff3b30', size: 5, x1: ${ax1}, y1: ${ay1}, x2: ${ax2}, y2: ${ay2} });
      shapes.push({ type: 'text', color: '#ffffff', size: 30, x: ${tx}, y: ${ty}, text: 'the glide' });
      shapes.push({ type: 'step', color: '#ffd23f', size: 3, x: ${sx}, y: ${sy}, n: 1 });
      renderAnn(); updateUndo(); setTool('arrow'); mouse = { x: -1, y: -1 }; updateCross(); updateLoupe(); update();
      return true; })()`);
    await save(ov, 'screenshot-overlay.png');
    await js(ov, `togglePalette(btns.color); true`);
    await save(ov, 'screenshot-palette.png');
    // magnifier before selecting
    ov.webContents.send('overlay:arm', { gen: 2, mode: 'shot', showMagnifier: true, cursor: { x: Math.round(sel.x + sel.w * 0.47), y: Math.round(sel.y + sel.h * 0.36) } });
    ov.webContents.send('overlay:image', { gen: 2, image });
    await save(ov, 'screenshot-freeze.png');
    // record mode
    ov.webContents.send('overlay:arm', { gen: 3, mode: 'gif', showMagnifier: true });
    ov.webContents.send('overlay:image', { gen: 3, image });
    await wait(200);
    await js(ov, `document.body.classList.remove('mode-shot'); document.body.classList.add('mode-rec'); mode = 'rec'; buildToolbars(); sel = ${JSON.stringify(sel)}; update(); true`);
    await save(ov, 'screenshot-record-area.png');
    ov.destroy();

    // 4. recording bar + toast on transparent windows
    const bar = await win(UI('recbar.html'), 380, 66, { transparent: true });
    await js(bar, `kind = 'gif'; maxS = 60; document.getElementById('time').textContent = '0:04.2'; document.getElementById('of').innerHTML = '<b>GIF</b>of 1:00'; document.getElementById('prog').style.width = '7%'; true`);
    await save(bar, 'recording-bar.png');
    bar.destroy();
    const toast = await win(UI('toast.html'), 400, 82, { transparent: true });
    toast.webContents.send('toast:show', { title: 'Link copied', sub: 'https://files.catbox.moe/7f3k2a.gif', kind: 'success', clickable: true, actionLabel: 'Open link' });
    await save(toast, 'toast.png');
    toast.destroy();

    // 5. editor, dashboard, captures, settings
    const ed = await win(UI('preview.html'), 1080, 800);
    ed.webContents.send('preview:init', { fileUrl: pathToFileURL(clip).href, duration: 3, kind: 'gif', gifFps: 15, gifMaxWidth: 0, videoFps: 30 });
    await wait(4500);
    await js(ed, 'layout(); true');
    await js(ed, `video.pause(); setPlaying(false); trimA = 0.4; trimB = 2.6; layout(); seek(1.4); true`);
    await save(ed, 'editor.png');
    ed.destroy();
    for (const [file, w, h, name] of [['dashboard.html', 940, 640, 'dashboard.png'], ['history.html', 1140, 800, 'captures.png'], ['settings.html', 900, 740, 'settings.png']]) {
      const b = await win(UI(file), w, h);
      await wait(700);
      await js(b, `document.querySelectorAll('img').forEach((i) => (i.loading = 'eager')); true`);
      await wait(900);
      await save(b, name);
      b.destroy();
    }
    // banner (README header and GitHub social preview)
    const ban = await win(path.join(__dirname, '..', 'tools', 'banner.html'), 1280, 640);
    await wait(800);
    await save(ban, 'banner.png');
    ban.destroy();
    log('DONE');
  } catch (e) {
    log('FAIL', e.stack || e);
  }
  setTimeout(() => app.exit(0), 300);
}

module.exports = { seed, run };
