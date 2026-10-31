'use strict';
// Design review: renders every screen in hidden windows with sample data and saves snapshots.
// `electron . --review` with GLIMPSE_REVIEW_OUT (folder) and GLIMPSE_REVIEW_IMG (a sample screenshot PNG)
// and optionally GLIMPSE_REVIEW_VIDEO (a sample mp4).
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

module.exports = async ({ preload }) => {
  const out = process.env.GLIMPSE_REVIEW_OUT;
  fs.mkdirSync(out, { recursive: true });
  const log = (...a) => console.log('[review]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const UI = (f) => path.join(__dirname, 'ui', f);
  const page = async (file, w, h, transparent = false) => {
    const win = new BrowserWindow({
      width: w, height: h, show: false, frame: false, transparent, backgroundColor: transparent ? '#00000000' : '#1c2027',
      webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    await win.loadFile(UI(file));
    return win;
  };
  const snap = async (win, name) => {
    await wait(350);
    fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
    log('saved', name);
  };
  const js = (win, code) => win.webContents.executeJavaScript(code);

  try {
    // overlay, screenshot mode
    const img = nativeImage.createFromPath(process.env.GLIMPSE_REVIEW_IMG).resize({ width: 1600, height: 900 });
    const { width, height } = img.getSize();
    const image = { width, height, data: img.toBitmap(), rgba: false };
    const ov = await page('overlay.html', 1600, 900);
    ov.webContents.send('overlay:arm', { gen: 1, mode: 'shot', showMagnifier: true, cursor: { x: 1100, y: 300 } });
    ov.webContents.send('overlay:image', { gen: 1, image });
    await wait(300);
    await snap(ov, 'a-overlay-idle.png');
    await js(ov, `(() => {
      sel = { x: 380, y: 170, w: 760, h: 440 };
      shapes.push({ type: 'rect', color: '#ff3b30', size: 4, x1: 420, y1: 210, x2: 640, y2: 330 });
      shapes.push({ type: 'arrow', color: '#ffd23f', size: 5, x1: 700, y1: 560, x2: 900, y2: 360 });
      shapes.push({ type: 'text', color: '#ffffff', size: 26, x: 430, y: 380, text: 'Drift line here' });
      shapes.push({ type: 'step', color: '#0a84ff', size: 3, x: 1080, y: 230, n: 1 });
      shapes.push({ type: 'step', color: '#0a84ff', size: 3, x: 1080, y: 290, n: 2 });
      shapes.push({ type: 'blur', size: 4, x1: 940, y1: 470, x2: 1110, y2: 560 });
      renderAnn(); updateUndo(); mouse = { x: -1, y: -1 }; updateCross(); updateLoupe(); setTool('arrow'); update();
      return true; })()`);
    await snap(ov, 'b-overlay-selected.png');
    await js(ov, `togglePalette(btns.color); const t = document.querySelector('.tb[data-tip="Undo"]'); t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); true`);
    await snap(ov, 'c-overlay-palette.png');
    ov.webContents.send('overlay:arm', { gen: 2, mode: 'gif', showMagnifier: true });
    await wait(200);
    await js(ov, `sel = { x: 300, y: 200, w: 900, h: 480 }; update(); true`);
    await snap(ov, 'd-overlay-record.png');
    ov.destroy();

    // recording bar
    const bar = await page('recbar.html', 380, 66, true);
    await js(bar, `kind='gif'; maxS=60; document.getElementById('time').textContent='0:12.4';
      document.getElementById('of').innerHTML='<b>GIF</b>of 1:00'; document.getElementById('prog').style.width='21%'; true`);
    await snap(bar, 'e-recbar.png');
    bar.destroy();
    const frame = await page('frame.html', 420, 260, true);
    await snap(frame, 'f-frame.png');
    frame.destroy();

    // toasts
    const toast = await page('toast.html', 400, 82, true);
    toast.webContents.send('toast:show', { title: 'Link copied', sub: 'https://files.catbox.moe/a1b2c3.gif', kind: 'success', clickable: true, actionLabel: 'Open link' });
    await snap(toast, 'g-toast-success.png');
    toast.webContents.send('toast:show', { title: 'Upload failed', sub: 'The host did not answer. Check your connection.', kind: 'error', clickable: false });
    await snap(toast, 'h-toast-error.png');
    toast.webContents.send('toast:show', { title: 'Uploading…', sub: '2.4 MB', kind: 'info', clickable: false });
    await snap(toast, 'i-toast-busy.png');
    toast.destroy();

    // editor
    if (process.env.GLIMPSE_REVIEW_VIDEO) {
      const ed = await page('preview.html', 1080, 800);
      ed.webContents.send('preview:init', {
        fileUrl: pathToFileURL(process.env.GLIMPSE_REVIEW_VIDEO).href, duration: 3, kind: 'gif', gifFps: 15, gifMaxWidth: 0, videoFps: 30,
      });
      await wait(4500);
      await js(ed, `video.pause(); setPlaying(false); trimA = 0.6; trimB = 2.4; layout(); seek(1.2); true`);
      await snap(ed, 'j-editor.png');
      ed.destroy();
    }

    // captures + settings
    const hist = await page('history.html', 1140, 800);
    await wait(800);
    await js(hist, "document.querySelectorAll('img').forEach((i) => (i.loading = 'eager')); true");
    await wait(800);
    await snap(hist, 'k-history.png');
    hist.destroy();
    const dash = await page('dashboard.html', 940, 640);
    await wait(600);
    await js(dash, "document.querySelectorAll('img').forEach((i) => (i.loading = 'eager')); true");
    await wait(600);
    await snap(dash, 'm-dashboard.png');
    await js(dash, "document.getElementById('shot').classList.add('hov'); true");
    dash.destroy();
    const set = await page('settings.html', 900, 740);
    await wait(500);
    await snap(set, 'l-settings.png');
    set.destroy();
    log('DONE');
  } catch (e) {
    log('FAIL', e.stack || e);
  }
  setTimeout(() => app.exit(0), 300);
};
