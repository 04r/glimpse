'use strict';
// `electron . --multitest` with GLIMPSE_FAKE_DISPLAYS set: checks the multi-monitor overlay on a
// simulated layout (left 960x1080, right 960x700, leaving a dead gap under the right screen).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async (h) => {
  const log = (...a) => console.log('[multi]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = process.env.GLIMPSE_TEST_OUT || path.join(os.tmpdir(), 'glimpse-multi');
  fs.mkdirSync(out, { recursive: true });
  let ok = true;
  const expect = (cond, what) => {
    log(cond ? 'PASS' : 'FAIL', what);
    if (!cond) ok = false;
  };
  try {
    await wait(1500);
    h.startCapture('shot');
    const t0 = Date.now();
    while (![...h.overlays.values()].every((o) => o.ready) && Date.now() - t0 < 5000) await wait(20);
    expect(h.overlays.size === 1, `one overlay spans both screens (${h.overlays.size})`);
    const o = [...h.overlays.values()][0];
    const b = o.win.getBounds();
    expect(b.width === 1920 && b.height === 1080, `overlay covers the whole layout (${b.width}x${b.height})`);
    const js = (c) => o.win.webContents.executeJavaScript(c);

    // a selection crossing both screens, bottom-right near the bottom of the short right screen
    const r = await js(`(() => {
      sel = { x: 700, y: 300, w: 900, h: 380 }; update();
      const v = tv.getBoundingClientRect(), hz = th.getBoundingClientRect();
      return { screens, v: [v.left, v.top, v.right, v.bottom], h: [hz.left, hz.top, hz.right, hz.bottom], bg: [bg.width, bg.height] };
    })()`);
    log('screens', JSON.stringify(r.screens), 'frozen image', r.bg.join('x'));
    expect(r.screens && r.screens.length === 2, 'renderer knows both screens');
    const inRight = (q) => q[0] >= 960 && q[2] <= 1920 && q[1] >= 0 && q[3] <= 700;
    expect(inRight(r.v), `side toolbar stays on the right screen ${JSON.stringify(r.v.map(Math.round))}`);
    expect(inRight(r.h), `bottom toolbar stays on the right screen, not in the gap ${JSON.stringify(r.h.map(Math.round))}`);
    fs.writeFileSync(path.join(out, 'multi-span.png'), (await o.win.webContents.capturePage()).toPNG());

    // Ctrl+A: the screen under the cursor, then every screen
    const key = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))`;
    const a1 = await js(`mouse = { x: 1400, y: 300 }; window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true })); JSON.stringify(sel)`);
    expect(a1 === JSON.stringify({ x: 960, y: 0, w: 960, h: 700 }), `Ctrl+A selects the right screen ${a1}`);
    const a2 = await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true })); JSON.stringify(sel)`);
    expect(a2 === JSON.stringify({ x: 0, y: 0, w: 1920, h: 1080 }), `Ctrl+A again selects every screen ${a2}`);
    fs.writeFileSync(path.join(out, 'multi-all.png'), (await o.win.webContents.capturePage()).toPNG());
    h.startCapture('shot'); // close
    await wait(600);

    // recording an area that crosses both screens is trimmed to the one holding most of it
    h.startCapture('gif');
    await wait(600);
    await js(`sel = { x: 600, y: 200, w: 800, h: 300 }; update(); startRec('gif'); true`);
    const t1 = Date.now();
    while (!(h.getRec() && h.getRec().barWin && h.getRec().barWin.isVisible()) && Date.now() - t1 < 10000) await wait(50);
    const rec = h.getRec();
    expect(!!rec, 'recording started');
    if (rec) {
      const fb = rec.frameWin.getBounds();
      log('recording display', rec.display.id, 'frame', JSON.stringify(fb));
      expect(rec.display.id === 2, 'records the right screen (it holds more of the area)');
      expect(fb.x >= 960 - 4 && fb.x + fb.width <= 1920 + 4, 'recording frame sits on the right screen');
      rec.barWin.webContents.send('rec:stop');
      await wait(2500);
      for (const w of BrowserWindow.getAllWindows()) if (/Edit recording/.test(w.getTitle())) w.close();
    }
  } catch (e) {
    ok = false;
    log('FAIL', e.stack || e);
  }
  log(ok ? 'ALL PASSED' : 'FAILED');
  setTimeout(() => app.exit(0), 400);
};
