'use strict';
// `electron . --clipstest`: turns instant replay on, saves a clip, checks the file and the library, and
// snapshots each page of the Clips window to GLIMPSE_TEST_OUT. Uses temp folders only.
const { app, BrowserWindow } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async ({ clips, getSettings, saveSettings, ffmpegBin }) => {
  const out = process.env.GLIMPSE_TEST_OUT || path.join(os.tmpdir(), 'glimpse-clipstest');
  fs.mkdirSync(out, { recursive: true });
  const folder = path.join(os.tmpdir(), 'glimpse-clipstest-clips');
  fs.rmSync(folder, { recursive: true, force: true });
  const log = (...a) => console.log('[clips]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let ok = true;
  const expect = (c, what) => {
    log(c ? 'PASS' : 'FAIL', what);
    if (!c) ok = false;
  };
  const probe = (file) => new Promise((resolve) => execFile(ffmpegBin(), ['-hide_banner', '-i', file], { windowsHide: true }, (_e, _o, err) => resolve(String(err))));
  const snap = async (win, name) => fs.writeFileSync(path.join(out, `c-${name}.png`), (await win.webContents.capturePage()).toPNG());

  try {
    const s = getSettings();
    s.clips = { folder, length: 20, notify: false, sound: false, ...(process.env.CLIPS_CFG ? JSON.parse(process.env.CLIPS_CFG) : {}) };
    saveSettings(s);

    if (process.env.CLIPS_SYNC) return await syncTest();

    // 1. engine: on, wait, save
    await clips.setEnabled(true, { quiet: true });
    for (let i = 0; i < 80 && clips.status().state !== 'on'; i++) await wait(100);
    expect(clips.status().state === 'on', `instant replay starts (${clips.status().state} ${clips.status().error || ''})`);
    await wait(+(process.env.CLIPS_WAIT || 7000));
    const st = clips.status();
    log('status', JSON.stringify({ ...st, plan: st.plan && { ...st.plan } }));
    const t0 = Date.now();
    const file = await clips.save(5);
    log('save took', Date.now() - t0, 'ms', file);
    expect(file && fs.existsSync(file), 'a clip file is written');
    if (file) {
      const info = await probe(file);
      const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
      const secs = d ? +d[2] * 60 + +d[3] : 0;
      log(info.split(/\r?\n/).filter((l) => /Duration|Stream|handler_name/.test(l)).join('\n'));
      expect(secs >= 4.5 && secs <= 6.5, `the clip is about 5 seconds long (${secs})`);
      expect(/Video: h264|Video: hevc/.test(info), 'it has video');
      const nAudio = (info.match(/Audio: aac/g) || []).length;
      expect(nAudio >= 1, `it has sound tracks (${nAudio})`);
      expect(path.basename(path.dirname(file)) !== path.basename(folder) || !getSettings().clips.perAppFolders === false, 'saved in a folder named after the app in front');
    }

    // 1b. a full recording next to the replay
    await clips.toggleRecording();
    expect(clips.isRecording(), 'a full recording starts');
    await wait(4000);
    await clips.toggleRecording();
    const rec = fs.readdirSync(folder, { recursive: true }).map((f) => path.join(folder, String(f))).find((f) => /recording\.(mp4|mkv)$/.test(f));
    if (rec) {
      const info = await probe(rec);
      const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
      log('recording', path.basename(rec), d && d[0]);
      expect(d && +d[3] >= 3 && +d[3] <= 5.5, 'the recording is saved with the right length');
    } else expect(false, 'the recording is saved');
    expect(!fs.readdirSync(folder, { recursive: true }).some((f) => /\.recording\.mkv$/.test(String(f))), 'the temporary recording file is cleaned up');

    // 2. the window
    clips.open();
    let win = null;
    for (let i = 0; i < 50 && !win; i++) {
      await wait(100);
      win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Glimpse Clips' && w.isVisible());
    }
    expect(!!win, 'the Clips window opens');
    await wait(2500);
    const js = (c) => win.webContents.executeJavaScript(c);
    const cards = await js('document.querySelectorAll(".card").length');
    expect(cards >= 1, `the library lists the clip (${cards} cards)`);
    await snap(win, 'library');
    for (const p of ['replay', 'video', 'audio', 'saving']) {
      await js(`go('${p}'); true`);
      await wait(p === 'audio' ? 1800 : 700);
      await snap(win, p);
    }
    const meters = await js('[...document.querySelectorAll(".meter b")].map((b) => b.textContent)');
    log('meters', JSON.stringify(meters));
    expect(meters.length >= 1, 'the audio page shows live meters');

    // 3. player + export
    await js('go("library"); true');
    await wait(800);
    await js('document.querySelector(".card").click(); true');
    await wait(2500);
    const pl = await js('({ dur, tracks: document.getElementById("track").options.length, film: document.querySelectorAll("#film img").length, playing: !document.getElementById("vid").paused, w: document.getElementById("vid").videoWidth })');
    log('player', JSON.stringify(pl));
    expect(pl.dur > 2 && pl.w > 0, 'the player loads the clip');
    await snap(win, 'player');
    await js('tIn = 1; tOut = 3; drawTrim(); expKind = "small"; document.getElementById("expSize").value = "10"; true');
    const ex = await js('api.invoke("clips:export", { file: cur.file, start: 1, end: 3, kind: "small", track: "0", targetMB: 10 })');
    log('export', JSON.stringify(ex));
    expect(ex.file && fs.existsSync(ex.file) && fs.statSync(ex.file).size < 10 * 1048576, 'export to a small file works');
    const fast = await js('api.invoke("clips:export", { file: cur.file, start: 1, end: 3, kind: "copy", track: "all" })');
    if (fast.file) {
      const info = await probe(fast.file);
      const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
      log('fast trim', d && d[0]);
      expect(d && +d[3] >= 1.5 && +d[3] <= 3.2, 'fast trim keeps about 2 seconds');
    } else expect(false, `fast trim (${fast.error})`);

    clips.setEnabled(false, { quiet: true });
    await wait(1200);
    expect(clips.status().state === 'off', 'instant replay stops');
    win.close();
  } catch (e) {
    ok = false;
    log('FAIL', e.stack || e);
  }
  log(ok ? 'ALL PASSED' : 'FAILED');
  setTimeout(() => app.exit(0), 800);

  // a window flashes white and clicks at the same instant, once a second; the saved clip should have
  // the flashes and the clicks at the same times
  async function syncTest() {
    const { screen } = require('electron');
    const w = new BrowserWindow({ x: 100, y: 100, width: 320, height: 240, frame: false, alwaysOnTop: true, show: false, backgroundColor: '#000' });
    w.setAlwaysOnTop(true, 'screen-saver');
    await w.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:#000"><script>
      const ac = new AudioContext();
      function flash() {
        document.body.style.background = '#fff';
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = 1000; g.gain.value = 0.08; o.connect(g).connect(ac.destination);
        o.start(); o.stop(ac.currentTime + 0.08);
        setTimeout(() => (document.body.style.background = '#000'), 120);
      }
      setInterval(flash, 1000);
    </script></body>`));
    w.showInactive();
    const d = screen.getDisplayNearestPoint({ x: 200, y: 200 });
    const s = getSettings();
    s.clips.video = { ...(s.clips.video || {}), display: String(d.id), target: 'screen' };
    saveSettings(s);
    await clips.setEnabled(true, { quiet: true });
    for (let i = 0; i < 80 && clips.status().state !== 'on'; i++) await wait(100);
    await wait(8000);
    const file = await clips.save(6);
    await clips.setEnabled(false, { quiet: true });
    w.destroy();
    const sf = d.scaleFactor;
    const b = { x: Math.round((100 - d.bounds.x) * sf) + 20, y: Math.round((100 - d.bounds.y) * sf) + 20, w: 200, h: 140 };
    const run = (args, max = 64 * 1048576) => new Promise((resolve, reject) =>
      execFile(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'buffer', maxBuffer: max, windowsHide: true }, (e, o) => (e ? reject(e) : resolve(o))));
    const lum = await run(['-i', file, '-vf', `crop=${b.w}:${b.h}:${b.x}:${b.y},scale=1:1,format=gray`, '-fps_mode', 'cfr', '-r', '60', '-f', 'rawvideo', '-']);
    const pcm = await run(['-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
    const vOn = [];
    for (let i = 1; i < lum.length; i++) if (lum[i] > 128 && lum[i - 1] <= 128) vOn.push(i / 60);
    const a = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
    const aOn = [];
    let last = -1;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > 0.02 && i / 48000 - last > 0.5) aOn.push((last = i / 48000));
    log('flashes', vOn.map((t) => t.toFixed(3)).join(' '));
    log('clicks ', aOn.map((t) => t.toFixed(3)).join(' '));
    const pairs = vOn.map((v) => aOn.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), Infinity) - v).filter((x) => Math.abs(x) < 0.3);
    const sorted = pairs.slice().sort((x, y) => x - y);
    const avg = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; // median: ignores a stray sound
    log('sound minus picture (ms):', pairs.map((x) => Math.round(x * 1000)).join(' '), 'median', Math.round(avg * 1000));
    expect(pairs.length >= 3 && Math.abs(avg) < 0.04, `sound and picture line up within 40 ms (${Math.round(avg * 1000)} ms)`);
    log(ok ? 'ALL PASSED' : 'FAILED');
    setTimeout(() => app.exit(0), 800);
  }
};
