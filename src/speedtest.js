'use strict';
// `electron . --speedtest`:
//  1. presses the capture hotkey 5 times and reports how long until the frozen screen is painted, and whether
//     the frozen image is clean (the dim overlay must never end up inside its own grab)
//  2. checks that apps behind the GIF overlay keep drawing (they must not freeze in record mode)
const { app, BrowserWindow } = require('electron');

module.exports = async (h) => {
  const log = (...a) => console.log('[speed]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ns = require('node-screenshots');
  const grab = () => {
    const img = ns.Monitor.all()[0].captureImageSync();
    return { w: img.width, raw: img.toRawSync() };
  };
  const lum = ({ w, raw }, x, y) => {
    let sum = 0;
    for (let dy = -20; dy <= 20; dy += 4)
      for (let dx = -20; dx <= 20; dx += 4) {
        const i = ((y + dy) * w + (x + dx)) * 4;
        sum += raw[i] + raw[i + 1] + raw[i + 2];
      }
    return Math.round(sum / 121 / 3);
  };
  const px = ({ w, raw }, x, y) => {
    const i = (y * w + x) * 4;
    return [raw[i], raw[i + 1], raw[i + 2]].join(',');
  };
  let ok = true;
  try {
    await wait(1500);
    for (let i = 0; i < 5; i++) {
      const lb = lum(grab(), 400, 400);
      const t0 = performance.now();
      h.startCapture('shot');
      const o = [...h.overlays.values()][0];
      while (!o.ready && performance.now() - t0 < 3000) await wait(2);
      const t = Math.round(performance.now() - t0);
      const inner = await o.win.webContents.executeJavaScript(`(() => {
        let s = 0; for (let dy = -20; dy <= 20; dy += 4) for (let dx = -20; dx <= 20; dx += 4) { const p = bgx.getImageData(400 + dx, 400 + dy, 1, 1).data; s += p[0] + p[1] + p[2]; }
        return Math.round(s / 121 / 3); })()`);
      if (Math.abs(inner - lb) > 6) ok = false;
      log(`press ${i + 1}: frozen in ${t} ms, brightness before ${lb}, in frozen image ${inner}`);
      await wait(250);
      h.startCapture('shot'); // second press closes
      await wait(400);
      if (!o.parked) ok = false;
    }
    log('timings (ms):', JSON.stringify(h.timings));

    // apps behind the GIF overlay must keep drawing
    const t = new BrowserWindow({ x: 1500, y: 640, width: 260, height: 220, show: false, frame: false, alwaysOnTop: true });
    t.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<body style="margin:0"><div id=b style="width:100vw;height:100vh"></div><script>window.h=0;(function f(){h=(h+7)%360;b.style.background=`hsl(${h},90%,50%)`;requestAnimationFrame(f)})()</script>'
        )
    );
    await new Promise((r) => t.once('ready-to-show', r));
    t.showInactive();
    await wait(500);
    const seen = (label) => {
      const a = px(grab(), 1630, 760);
      return a;
    };
    log('before overlay, grab sees test window:', seen(), seen());
    h.startCapture('gif');
    await wait(600);
    const frames = [];
    for (let i = 0; i < 4; i++) {
      frames.push(await t.webContents.executeJavaScript('h'));
      await wait(200);
    }
    log('behind GIF overlay, test window frame counter:', JSON.stringify(frames), 'grab sees:', seen());
    const live = new Set(frames).size >= 3;
    if (!live) ok = false;
    h.startCapture('gif'); // close
    t.destroy();
    log(live ? 'PASS app behind overlay keeps drawing' : 'FAIL app behind overlay froze');
  } catch (e) {
    ok = false;
    log('FAIL', e.stack || e);
  }
  log(ok ? 'ALL PASSED' : 'FAILED');
  setTimeout(() => app.exit(0), 300);
};
