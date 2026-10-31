'use strict';
const api = window.glimpse;
const $ = (id) => document.getElementById(id);

$('pause').innerHTML = ICONS.pause;
$('stopIcon').innerHTML = ICONS.stop;
$('cancel').innerHTML = ICONS.close;

let stream = null;
let recorder = null;
let chunks = [];
let mime = '';
let startT = 0;
let pausedAcc = 0;
let pauseT = 0;
let paused = false;
let stopping = false;
let cancelled = false;
let maxS = 60;
let kind = 'gif';
let tick = null;

const fmt = (s) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
};
const elapsed = () => (performance.now() - startT - pausedAcc - (paused ? performance.now() - pauseT : 0)) / 1000;

api.on('rec:init', (cfg) => start(cfg).catch((e) => fail(e)));
api.on('rec:stop', () => stop(false));

$('stop').onclick = () => stop(false);
$('cancel').onclick = () => stop(true);
$('pause').onclick = togglePause;

function fail(e) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  api.invoke('rec:finish', { error: String((e && e.message) || e) });
}

async function getStream(cfg, w, h) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: cfg.sourceId,
          minWidth: w, maxWidth: w, minHeight: h, maxHeight: h,
          maxFrameRate: cfg.fps,
        },
      },
    });
  } catch (err) {
    // newer Electron path (main process answers with the chosen screen)
    return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: cfg.fps }, audio: false });
  }
}

async function start(cfg) {
  kind = cfg.kind;
  maxS = cfg.maxSeconds || 60;
  const { display, rect } = cfg;
  const pw = Math.round(display.width * display.scale);
  const ph = Math.round(display.height * display.scale);
  stream = await getStream(cfg, pw, ph);

  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  for (let i = 0; i < 50 && !video.videoWidth; i++) await new Promise((r) => setTimeout(r, 20));

  const sx = video.videoWidth / display.width;
  const sy = video.videoHeight / display.height;
  let cw = Math.max(2, Math.round(rect.width * sx));
  let ch = Math.max(2, Math.round(rect.height * sy));
  cw -= cw % 2;
  ch -= ch % 2;
  const cx = Math.round(rect.x * sx);
  const cy = Math.round(rect.y * sy);

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { alpha: false });
  const draw = () => {
    if (!paused) ctx.drawImage(video, cx, cy, cw, ch, 0, 0, cw, ch);
  };
  draw();
  if ('requestVideoFrameCallback' in video) {
    const loop = () => {
      draw();
      if (!stopping) video.requestVideoFrameCallback(loop);
    };
    video.requestVideoFrameCallback(loop);
  } else {
    setInterval(draw, 1000 / cfg.fps);
  }

  const out = canvas.captureStream(cfg.fps);
  mime =
    ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm;codecs=h264', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t)
    ) || 'video/webm';
  const bitrate = Math.round(Math.min(40e6, Math.max(4e6, cw * ch * cfg.fps * 0.3)));
  recorder = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: bitrate });
  recorder.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  recorder.onstop = finish;
  recorder.start(1000);
  startT = performance.now();
  tick = setInterval(updateTime, 100);
  updateTime();
  api.send('rec:started');
}

function updateTime() {
  const t = elapsed();
  $('time').textContent = fmt(t);
  $('of').innerHTML = `<b>${kind === 'gif' ? 'GIF' : 'Video'}</b>of ${fmt(maxS).replace(/\.0$/, '')}`;
  $('prog').style.width = `${Math.min(100, (t / maxS) * 100)}%`;
  if (t >= maxS) stop(false);
}

function togglePause() {
  if (!recorder || stopping) return;
  if (paused) {
    pausedAcc += performance.now() - pauseT;
    paused = false;
    recorder.resume();
  } else {
    pauseT = performance.now();
    paused = true;
    recorder.pause();
  }
  document.body.classList.toggle('paused', paused);
  $('pause').innerHTML = paused ? ICONS.play : ICONS.pause;
  $('pause').title = paused ? 'Resume' : 'Pause';
}

function stop(cancel) {
  if (stopping) return;
  if (!recorder) {
    // still starting up
    cancelled = true;
    return api.invoke('rec:finish', { cancelled: true });
  }
  stopping = true;
  cancelled = cancel;
  clearInterval(tick);
  if (paused) {
    pausedAcc += performance.now() - pauseT;
    paused = false;
  }
  finalDuration = elapsed();
  document.body.classList.add('saving');
  $('time').textContent = cancel ? 'Discarding' : 'Opening editor';
  $('of').textContent = '';
  if (recorder.state !== 'inactive') recorder.stop();
}

let finalDuration = 0;

async function finish() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (cancelled) return api.invoke('rec:finish', { cancelled: true });
  const blob = new Blob(chunks, { type: mime });
  const data = new Uint8Array(await blob.arrayBuffer());
  api.invoke('rec:finish', { data, duration: finalDuration, kind });
}

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') stop(true);
});
