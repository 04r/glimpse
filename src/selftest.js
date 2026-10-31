'use strict';
// Drives the real windows end to end: `npm start -- --selftest`. Writes snapshots + outputs to GLIMPSE_TEST_OUT.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async (h) => {
  const out = process.env.GLIMPSE_TEST_OUT || path.join(os.tmpdir(), 'glimpse-test');
  fs.mkdirSync(out, { recursive: true });
  const log = (...a) => console.log('[selftest]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, t = 15000, what = 'condition') => {
    const s = Date.now();
    while (Date.now() - s < t) {
      const v = fn();
      if (v) return v;
      await wait(100);
    }
    throw new Error('timeout waiting for ' + what);
  };
  const snap = async (win, name) => fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
  const files = (ext) => fs.readdirSync(out).filter((f) => f.startsWith('Glimpse') && f.endsWith(ext));
  const overlaysReady = () => h.overlays.size && [...h.overlays.values()].every((o) => o.ready && o.win.isVisible());

  h.setSetting('quickSave', true);
  h.setSetting('saveDir', out);
  let ok = true;
  try {
    await wait(1500);

    // 1. screenshot overlay with annotations
    h.startCapture('shot');
    await until(overlaysReady, 15000, 'shot overlay');
    const o = [...h.overlays.values()][0];
    await wait(300);
    await o.win.webContents.executeJavaScript(`(() => {
      sel = { x: 200, y: 150, w: 700, h: 420 };
      shapes.push({ type: 'rect', color: '#ff3b30', size: 4, x1: 240, y1: 190, x2: 520, y2: 330 });
      shapes.push({ type: 'arrow', color: '#0a84ff', size: 4, x1: 600, y1: 500, x2: 780, y2: 300 });
      shapes.push({ type: 'ellipse', color: '#bf5af2', size: 3, x1: 300, y1: 420, x2: 460, y2: 520 });
      shapes.push({ type: 'text', color: '#ffcc00', size: 28, x: 260, y: 360, text: 'Hello Glimpse' });
      shapes.push({ type: 'step', color: '#34c759', size: 3, x: 840, y: 200, n: 1 });
      shapes.push({ type: 'blur', size: 4, x1: 600, y1: 180, x2: 760, y2: 260 });
      shapes.push({ type: 'marker', color: '#ffcc00', size: 3, points: [[230, 480], [420, 470], [560, 480]] });
      shapes.push({ type: 'pen', color: '#ff2d92', size: 3, points: [[700, 420], [720, 440], [760, 430], [800, 470]] });
      renderAnn(); updateUndo(); setTool('pen'); mouse = { x: -1, y: -1 }; update(); updateCross(); updateLoupe();
      return true; })()`);
    await wait(400);
    await snap(o.win, '1-overlay.png');
    await o.win.webContents.executeJavaScript(`act('save'); true`);
    await until(() => files('.png').length, 10000, 'png save');
    log('PASS screenshot saved:', files('.png')[0]);
    log('native grab:', h.nativeGrab, 'animations off:', h.noAnimOk);

    // 1b. copy to clipboard, using the reused overlay
    const { clipboard } = require('electron');
    await clipboard.writeText('x');
    await wait(500);
    h.startCapture('shot');
    await until(overlaysReady, 5000, 'shot overlay (reuse)');
    const oc = [...h.overlays.values()][0];
    const fresh = await oc.win.webContents.executeJavaScript(`shapes.length === 0 && sel === null`);
    if (!fresh) throw new Error('overlay state not reset between captures');
    await oc.win.webContents.executeJavaScript(`sel = { x: 50, y: 60, w: 320, h: 200 }; update(); act('copy'); true`);
    await until(() => false, 1500, 'x').catch(() => {});
    const items = await clipboard.read();
    const types = items.flatMap((i) => i.types);
    if (!types.includes('image/png')) throw new Error('clipboard has no image: ' + types.join(','));
    const blob = await items.find((i) => i.types.includes('image/png')).getType('image/png');
    log('PASS clipboard image', blob.size, 'bytes, types', types.join(','));
    for (let i = 0; i < 3; i++) {
      await wait(400);
      h.startCapture('shot');
      await until(overlaysReady, 5000, 'repeat overlay');
      await wait(150);
      h.startCapture('shot'); // second press closes, like the hotkey
    }
    log('hotkey -> frozen screen (ms):', JSON.stringify(h.timings));

    log('animation-off results (0 = ok):', JSON.stringify(h.noAnimResults));

    // 1c. record-mode overlay must keep apps behind it drawing
    const ticker = new BrowserWindow({ x: 1500, y: 640, width: 260, height: 220, show: false, frame: false, alwaysOnTop: true });
    ticker.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<body style="margin:0"><div id=b style="width:100vw;height:100vh"></div><script>window.h=0;(function f(){h=(h+7)%360;b.style.background=`hsl(${h},90%,50%)`;requestAnimationFrame(f)})()</script>'
        )
    );
    await new Promise((r) => ticker.once('ready-to-show', r));
    ticker.showInactive();
    await wait(400);
    h.startCapture('gif');
    await until(overlaysReady, 5000, 'gif overlay');
    await wait(400);
    const frames = [];
    for (let i = 0; i < 4; i++) {
      frames.push(await ticker.webContents.executeJavaScript('h'));
      await wait(200);
    }
    h.startCapture('gif'); // close
    ticker.destroy();
    const live = new Set(frames).size >= 3;
    log('record overlay: app behind keeps drawing?', live, JSON.stringify(frames));
    if (!live) throw new Error('app behind record overlay froze');

    // 2. GIF recording
    await wait(800);
    h.startCapture('gif');
    await until(overlaysReady, 15000, 'gif overlay');
    const o2 = [...h.overlays.values()][0];
    await o2.win.webContents.executeJavaScript(`sel = { x: 120, y: 120, w: 640, h: 360 }; update(); true`);
    await wait(300);
    await snap(o2.win, '2-rec-overlay.png');
    await o2.win.webContents.executeJavaScript(`startRec(); true`);
    await until(() => h.getRec() && h.getRec().barWin.isVisible(), 15000, 'recording start');
    log('PASS recording started');
    await wait(1000);
    await snap(h.getRec().barWin, '3-recbar.png');
    await wait(2000);
    h.stopRecording();
    await until(() => h.previews.size, 20000, 'preview window');
    const pid = [...h.previews.keys()][0];
    const pwin = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === pid);
    await until(() => pwin.isVisible(), 10000, 'preview visible');
    await wait(1500);
    await snap(pwin, '4-preview.png');
    log('preview duration', h.previews.get(pid).duration);
    await pwin.webContents.executeJavaScript(`run('save')`);
    await until(() => files('.gif').length, 30000, 'gif save');
    log('PASS gif saved:', files('.gif')[0], fs.statSync(path.join(out, files('.gif')[0])).size, 'bytes');
    await pwin.webContents.executeJavaScript(`setFormat('mp4'); run('save')`);
    await until(() => files('.mp4').length, 30000, 'mp4 save');
    log('PASS mp4 saved:', files('.mp4')[0], fs.statSync(path.join(out, files('.mp4')[0])).size, 'bytes');
    await snap(pwin, '5-preview-after.png');
    pwin.close();

    // 3. history + settings windows
    h.openHistory();
    await until(() => h.getHistoryWin() && h.getHistoryWin().isVisible(), 10000, 'history');
    await wait(1200);
    await snap(h.getHistoryWin(), '6-history.png');
    h.openSettings();
    await until(() => h.getSettingsWin() && h.getSettingsWin().isVisible(), 10000, 'settings');
    await wait(800);
    await snap(h.getSettingsWin(), '7-settings.png');
    log('PASS windows');
  } catch (e) {
    ok = false;
    log('FAIL', e.stack || e);
  }
  log(ok ? 'ALL PASSED' : 'FAILED');
  setTimeout(() => app.exit(ok ? 0 : 1), 500);
};
