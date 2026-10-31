'use strict';
const { spawn } = require('child_process');
const fs = require('fs');

let bin = null;
try {
  bin = require('ffmpeg-static');
  if (bin) bin = bin.replace('app.asar', 'app.asar.unpacked');
} catch {}
if (!bin || !fs.existsSync(bin)) bin = 'ffmpeg';

function parseTime(s) {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

function run(args, { duration = 0, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-hide_banner', '-nostdin', ...args], { windowsHide: true });
    let log = '';
    p.stderr.on('data', (d) => {
      const s = d.toString();
      log = (log + s).slice(-8000);
      if (onProgress && duration > 0) {
        const t = parseTime(s);
        if (t != null) onProgress(Math.min(1, t / duration));
      }
    });
    p.on('error', (e) => reject(new Error(`Could not start ffmpeg: ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(log.trim().split(/\r?\n/).slice(-3).join('\n') || `ffmpeg exited with ${code}`));
    });
  });
}

// Rewrites MediaRecorder output so it has a duration and seek index.
function remux(input, output) {
  return run(['-y', '-i', input, '-c', 'copy', output]);
}

function encode(input, output, opts, onProgress) {
  const start = Math.max(0, opts.start || 0);
  const dur = Math.max(0.1, (opts.end || 0) - start);
  const fps = Math.max(1, Math.min(60, opts.fps || 15));
  const width = opts.width > 0 ? opts.width : 0;
  const args = ['-y', '-i', input, '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-an'];

  if (opts.format === 'gif') {
    const scale = width ? `scale='min(iw,${width})':-1:flags=lanczos,` : '';
    args.push(
      '-vf',
      `fps=${fps},${scale}split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
      '-loop', '0',
      output
    );
  } else if (opts.format === 'mp4') {
    const scale = width ? `scale='min(iw,${width})':-2` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
    args.push(
      '-vf', scale,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-fps_mode', 'cfr', '-r', String(fps),
      '-movflags', '+faststart',
      output
    );
  } else {
    const scale = width ? `scale='min(iw,${width})':-2` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
    args.push(
      '-vf', scale,
      '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4',
      '-fps_mode', 'cfr', '-r', String(fps),
      output
    );
  }
  return run(args, { duration: dur, onProgress });
}

module.exports = { run, remux, encode, bin: () => bin };
