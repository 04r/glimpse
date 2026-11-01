'use strict';
// `electron . --featuretest`: copy text (OCR), searchable history, window snapping, scrolling capture,
// make it pretty. Writes snapshots to GLIMPSE_TEST_OUT. Moves the mouse briefly (scrolling capture).
const { app, BrowserWindow, screen, clipboard, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async (h) => {
  const out = process.env.GLIMPSE_TEST_OUT || path.join(os.tmpdir(), 'glimpse-features');
  fs.mkdirSync(out, { recursive: true });
  const log = (...a) => console.log('[feat]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let ok = true;
  const expect = (c, what) => {
    log(c ? 'PASS' : 'FAIL', what);
    if (!c) ok = false;
  };
  const until = async (fn, ms = 10000) => {
    const t = Date.now();
    while (!fn() && Date.now() - t < ms) await wait(50);
    return fn();
  };
  const page = (html, opts) => {
    const w = new BrowserWindow({ show: false, frame: false, ...opts });
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return w;
  };

  async function scrollPart() {
    const rows = Array.from({ length: 36 }, (_, i) =>
      `<div style="height:90px;display:flex;align-items:center;padding-left:28px;font:600 30px Segoe UI;background:${i % 2 ? '#eef2f7' : '#ffffff'};color:#15181d">Row ${i + 1} of 36</div>`
    ).join('');
    const sw = page(`<body style="margin:0;overflow-y:scroll"><div style="position:sticky;top:0;height:70px;background:#1c2027;color:#ffd23f;font:700 28px Segoe UI;display:flex;align-items:center;padding-left:28px">Sticky header</div>${rows}</body>`,
      { x: 300, y: 150, width: 720, height: 600, useContentSize: true, alwaysOnTop: true });
    await new Promise((r) => sw.webContents.once('did-finish-load', r));
    sw.showInactive();
    await wait(700);
    const d = screen.getDisplayNearestPoint({ x: 400, y: 300 });
    const b = sw.getContentBounds();
    const t1 = Date.now();
    const shot = await h.runScrollCapture(d, { x: b.x - d.bounds.x, y: b.y - d.bounds.y, width: b.width, height: b.height });
    sw.destroy();
    const sres = nativeImage.createFromPath(shot.file);
    const sz = sres.getSize();
    log('scroll', Date.now() - t1, 'ms, result', sz.width, 'x', sz.height);
    fs.copyFileSync(shot.file, path.join(out, 'f-scroll.png'));
    // the page is 70 + 36 x 90 = 3310 px tall
    expect(Math.abs(sz.height - 3310) <= 30, `stitched image is the full page height (${sz.height} vs 3310)`);
    const stext = (await h.ocr.ocrImage(sres)).join('\n');
    const headers = (stext.match(/Sticky header/g) || []).length;
    expect(/Row 1 of 36/.test(stext) && /Row 36 of 36/.test(stext), 'contains the first and the last row');
    expect(headers === 1, `the sticky header appears once, not repeated (${headers})`);
    const missing = Array.from({ length: 36 }, (_, i) => i + 1).filter((n) => !new RegExp(`Row ${n} of`).test(stext));
    expect(missing.length <= 2, `every row made it in (missing: ${missing.join(',') || 'none'})`);

  }

  // ---------- 5. make it pretty ----------
  async function prettyPart(entry) {
    const pw = h.openPretty(entry);
    await until(() => pw.isVisible());
    await wait(900);
    fs.writeFileSync(path.join(out, 'f-pretty.png'), (await pw.webContents.capturePage()).toPNG());
    await clipboard.writeText('x');
    // a few looks, saved for review
    const looks = [
      { frame: 'browser', url: 'fjordnotes.example', tilt: 'hero', rx: -18, ry: -24, rz: 5, bgKind: 'gradient', bg: 'sunrise', shadow: 'deep', size: '16:9' },
      { frame: 'phone', tilt: 'left', rx: 4, ry: 30, rz: 0, bgKind: 'mesh', bg: 'aurora', shadow: 'float', size: '4:5' },
      { frame: 'laptop', tilt: 'isoL', rx: -52, ry: 0, rz: -38, bgKind: 'mesh', bg: 'bloom', shadow: 'soft', size: '1:1' },
      { frame: 'glass', tilt: 'back', rx: -38, ry: 0, rz: 0, bgKind: 'blur', bg: '', shadow: 'soft', size: '9:16', grain: true },
      { frame: 'browserDark', tilt: 'right', rx: 4, ry: -30, rz: 0, bgKind: 'solid', bg: '#2b3440', shadow: 'hard', size: '3:2' },
      { frame: 'tablet', tilt: 'flat', rx: 0, ry: 0, rz: 0, bgKind: 'gradient', bg: 'ocean', shadow: 'soft', size: 'auto' },
    ];
    for (let i = 0; i < looks.length; i++) {
      await pw.webContents.executeJavaScript(`Object.assign(opt, ${JSON.stringify(looks[i])}); sync(); draw(); true`);
      await wait(500);
      fs.writeFileSync(path.join(out, `f-pretty-${i + 1}.png`), (await pw.webContents.capturePage()).toPNG());
    }
    await pw.webContents.executeJavaScript(`Object.assign(opt, { size: '1:1', tilt: 'hero', rx: -18, ry: -24, rz: 5 }); sync(); run('copy')`);
    let ci = { width: 0, height: 0 };
    for (let i = 0; i < 50 && !ci.width; i++) {
      await wait(100);
      const items = await clipboard.read();
      const it = items.find((x) => x.types.includes('image/png'));
      if (it) ci = nativeImage.createFromBuffer(Buffer.from(await (await it.getType('image/png')).arrayBuffer())).getSize();
    }
    log('pretty copy', JSON.stringify(ci));
    expect(ci.width === ci.height && ci.width === 1600, `Make it pretty exports a tilted 1:1 image at full size (${ci.width} x ${ci.height})`);
    pw.close();
  }

  try {
    await wait(1200);

    if (process.env.GLIMPSE_ONLY_PRETTY) {
      const tw = page(`<body style="margin:0;background:#fff;font:600 34px Segoe UI;color:#111;padding:30px">Invoice 48213<br>Total due: 1,250.00 EUR<br>Glimpse reads text offline</body>`, { width: 700, height: 260, useContentSize: true });
      await new Promise((r) => tw.webContents.once("did-finish-load", r));
      await wait(300);
      const timg = await tw.webContents.capturePage();
      tw.destroy();
      await prettyPart(h.addHistory({ type: "image", buf: timg.toPNG(), ext: "png", w: 700, h: 260 }));
      log(ok ? "ALL PASSED" : "FAILED");
      return setTimeout(() => app.exit(0), 300);
    }
    if (process.env.GLIMPSE_ONLY_SCROLL) { await scrollPart(); log('DONE'); return setTimeout(() => app.exit(0), 300); }
    // ---------- 1. copy text (OCR) ----------
    const tw = page(`<body style="margin:0;background:#fff;font:600 34px Segoe UI;color:#111;padding:30px">
      Invoice 48213<br>Total due: 1,250.00 EUR<br>Glimpse reads text offline</body>`, { width: 700, height: 260, useContentSize: true });
    await new Promise((r) => tw.webContents.once('did-finish-load', r));
    await wait(300);
    const timg = await tw.webContents.capturePage();
    tw.destroy();
    const t0 = Date.now();
    const lines = await h.ocr.ocrImage(timg);
    const text = lines.join(' ');
    log('ocr', Date.now() - t0, 'ms:', JSON.stringify(lines));
    expect(/48213/.test(text) && /1,250\.00/.test(text) && /offline/i.test(text), 'reads the text in a capture');

    // ---------- 1b. grab text inside the overlay ----------
    const gw = page(`<body style="margin:0;background:#fff;font:600 40px Segoe UI;color:#111;padding:36px">
      Order 77341 shipped<br>Tracking ZX-55120</body>`, { x: 200, y: 150, width: 760, height: 260, useContentSize: true, alwaysOnTop: true });
    await new Promise((r) => gw.webContents.once('did-finish-load', r));
    gw.showInactive();
    await wait(600);
    h.startCapture('shot');
    await until(() => [...h.overlays.values()].every((x) => x.ready));
    const go = [...h.overlays.values()][0];
    const gjs = (c) => go.win.webContents.executeJavaScript(c);
    const b0 = gw.getContentBounds(), ob = go.win.getBounds();
    const gx = b0.x - ob.x, gy = b0.y - ob.y;
    await clipboard.writeText('-');
    await gjs(`(() => {
      sel = { x: 40, y: 40, w: 300, h: 200 }; update();
      setTool('ocr');
      const ev = (t, x, y) => document.body.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, button: 0, bubbles: true }));
      ev('mousedown', ${gx + 20}, ${gy + 20});
      ev('mousemove', ${gx + 600}, ${gy + 200});
      ev('mouseup', ${gx + 600}, ${gy + 200});
      return true; })()`);
    await until(() => false, 200).catch(() => {});
    let grab = null;
    for (let i = 0; i < 60; i++) {
      await wait(100);
      grab = await gjs(`({ status: ocrStatus.textContent, text: ocrText.value, panel: !ocrPanel.hidden, sel: JSON.stringify(sel), tool })`);
      if (/Copied|No text/.test(grab.status)) break;
    }
    const clip = await clipboard.readText();
    log('grab', JSON.stringify(grab), 'clipboard:', JSON.stringify(clip));
    expect(/77341/.test(grab.text) && /ZX-55120/.test(grab.text), 'dragging over text reads just that text');
    expect(/77341/.test(clip), 'the text is on the clipboard right away');
    expect(grab.panel && /Copied/.test(grab.status), 'a small panel shows what was copied');
    expect(h.overlays.size && [...h.overlays.values()][0].ready && grab.sel === JSON.stringify({ x: 40, y: 40, w: 300, h: 200 }), 'the screenshot overlay and its selection stay put');
    fs.writeFileSync(path.join(out, 'f-grabtext.png'), (await go.win.webContents.capturePage()).toPNG());
    h.startCapture('shot'); // close
    gw.destroy();
    await wait(600);

    // ---------- 2. searchable history ----------
    const entry = h.addHistory({ type: 'image', buf: timg.toPNG(), ext: 'png', w: 700, h: 260 });
    await until(() => typeof h.findEntry(entry.id).text === 'string', 15000);
    expect(/48213/.test(h.findEntry(entry.id).text || ''), 'new captures get their text indexed in the background');
    h.openHistory();
    const hw = await (async () => {
      await until(() => h.getHistoryWin() && h.getHistoryWin().isVisible());
      return h.getHistoryWin();
    })();
    await wait(800);
    const found = await hw.webContents.executeJavaScript(`(async () => {
      const q = document.getElementById('q'); q.value = '48213'; q.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 600));
      return { tiles: document.querySelectorAll('.shot').length, snip: (document.querySelector('.snip') || {}).textContent || '' };
    })()`);
    log('search', JSON.stringify(found));
    expect(found.tiles >= 1 && /48213/.test(found.snip), 'Captures search finds it by its text, with a snippet');
    fs.writeFileSync(path.join(out, 'f-search.png'), (await hw.webContents.capturePage()).toPNG());
    hw.close();

    // ---------- 3. snap to a window ----------
    // a window from another process (our own windows are skipped on purpose)
    const ps = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms;$f=New-Object Windows.Forms.Form;$f.FormBorderStyle="None";' +
      '$f.StartPosition="Manual";$f.Left=320;$f.Top=210;$f.Width=640;$f.Height=380;$f.TopMost=$true;$f.ShowInTaskbar=$false;' +
      '$f.BackColor=[Drawing.Color]::FromArgb(47,107,255);[Windows.Forms.Application]::Run($f)']);
    await wait(2500);
    h.startCapture('shot');
    await until(() => [...h.overlays.values()].every((o) => o.ready));
    const o = [...h.overlays.values()][0];
    const js = (c) => o.win.webContents.executeJavaScript(c);
    const snap = await js(`(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 600, clientY: 400 }));
      const hovered = snap && { ...snap };
      document.body.dispatchEvent(new MouseEvent('mousedown', { clientX: 600, clientY: 400, button: 0, bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mouseup', { clientX: 600, clientY: 400, button: 0, bubbles: true }));
      return { hovered, sel, wins: wins.length };
    })()`);
    log('snap', JSON.stringify(snap));
    const near = (r) => r && Math.abs(r.x - 320) <= 2 && Math.abs(r.y - 210) <= 2 && Math.abs(r.w - 640) <= 3 && Math.abs(r.h - 380) <= 3;
    expect(near(snap.hovered), 'hovering highlights the window under the cursor');
    expect(near(snap.sel), 'a click without dragging selects exactly that window');
    fs.writeFileSync(path.join(out, 'f-snap.png'), (await o.win.webContents.capturePage()).toPNG());
    h.startCapture('shot'); // close
    ps.kill();
    await wait(800);

    await scrollPart();

    await prettyPart(entry);
  } catch (e) {
    ok = false;
    log('FAIL', e.stack || e);
  }
  log(ok ? 'ALL PASSED' : 'FAILED');
  setTimeout(() => app.exit(0), 500);
};
