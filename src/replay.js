'use strict';
// Instant replay, like ShadowPlay: the screen (and sound) is recorded all the time into a rolling set of
// one-second pieces on disk, and "save clip" joins the newest pieces into an MP4 without re-encoding.
//
// Video: ffmpeg's ddagrab (Desktop Duplication, frames stay on the GPU) straight into the hardware
//        encoder (NVENC / AMF / Quick Sync), or into x264 when there is none.
// Sound: src/bin/glimpse-audio.exe captures system sound, single apps and the microphone with WASAPI
//        and streams each one to ffmpeg through a named pipe; ffmpeg sets volumes, cleans up the mic,
//        mixes, and writes one or more audio tracks.

const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const unpacked = (p) => p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const HELPER = unpacked(path.join(__dirname, 'bin', 'glimpse-audio.exe'));
const SEG = 1; // seconds per piece
const AUDIO_LATENCY_MS = 15;

/** run the audio helper once and parse its JSON (--list, --outputs) */
function helperJSON(args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(HELPER, args, { windowsHide: true, timeout }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      try {
        resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).pop()));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---------- encoders ----------

const ENCODERS = {
  nvenc: { name: 'NVIDIA NVENC', h264: 'h264_nvenc', hevc: 'hevc_nvenc', av1: 'av1_nvenc' },
  amf: { name: 'AMD AMF', h264: 'h264_amf', hevc: 'hevc_amf', av1: 'av1_amf' },
  qsv: { name: 'Intel Quick Sync', h264: 'h264_qsv', hevc: 'hevc_qsv', av1: 'av1_qsv' },
  cpu: { name: 'CPU (x264 / x265)', h264: 'libx264', hevc: 'libx265' },
};

let encoderCache = null;
/** which encoder + codec pairs actually work on this PC: ['nvenc:h264', 'nvenc:hevc', 'cpu:h264', ...] */
function probeEncoders(ffmpeg) {
  if (encoderCache) return encoderCache;
  const tries = [];
  for (const [key, e] of Object.entries(ENCODERS)) {
    for (const codec of ['h264', 'hevc', 'av1']) {
      if (!e[codec]) continue;
      tries.push(new Promise((resolve) => {
        const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30',
          '-frames:v', '3', '-pix_fmt', key === 'qsv' ? 'nv12' : 'yuv420p', '-c:v', e[codec], '-f', 'null', '-'];
        execFile(ffmpeg, args, { windowsHide: true, timeout: 15000 }, (err) => resolve(err ? null : `${key}:${codec}`));
      }));
    }
  }
  encoderCache = Promise.all(tries).then((r) => r.filter(Boolean));
  return encoderCache;
}

// ---------- the ffmpeg command ----------

/** video encoder options for a plan */
function videoArgs(p) {
  const enc = ENCODERS[p.encoder][p.codec];
  const kbps = Math.round(p.mbps * 1000);
  const max = Math.round(kbps * (p.rc === 'cbr' ? 1 : 1.5));
  const buf = Math.round(kbps * 2);
  const g = String(Math.max(1, Math.round(p.fps * SEG)));
  const a = ['-c:v', enc, '-g', g];
  if (p.encoder === 'nvenc') {
    a.push('-preset', p.preset || 'p4', '-tune', 'hq', '-spatial-aq', '1', '-bf', p.codec === 'h264' ? '2' : '0');
    if (p.rc === 'cq') a.push('-rc', 'vbr', '-cq', String(p.cq), '-b:v', '0', '-maxrate', `${max}k`, '-bufsize', `${buf}k`);
    else a.push('-rc', p.rc === 'cbr' ? 'cbr' : 'vbr', '-b:v', `${kbps}k`, '-maxrate', `${max}k`, '-bufsize', `${buf}k`);
  } else if (p.encoder === 'amf') {
    a.push('-usage', 'transcoding', '-quality', 'balanced');
    if (p.rc === 'cq') a.push('-rc', 'cqp', '-qp_i', String(p.cq), '-qp_p', String(p.cq + 2));
    else a.push('-rc', p.rc === 'cbr' ? 'cbr' : 'vbr_peak', '-b:v', `${kbps}k`, '-maxrate', `${max}k`, '-bufsize', `${buf}k`);
  } else if (p.encoder === 'qsv') {
    a.push('-preset', 'medium');
    if (p.rc === 'cq') a.push('-global_quality', String(p.cq));
    else a.push('-b:v', `${kbps}k`, '-maxrate', `${max}k`, '-bufsize', `${buf}k`);
  } else {
    a.push('-preset', p.codec === 'hevc' ? 'fast' : 'veryfast');
    if (p.rc === 'cq') a.push('-crf', String(p.cq), '-maxrate', `${max}k`, '-bufsize', `${buf}k`);
    else a.push('-b:v', `${kbps}k`, '-maxrate', `${max}k`, '-bufsize', `${buf}k`);
  }
  // NVENC/AMF convert the captured RGB with BT.601; say so, so players show the right colours
  a.push('-colorspace', 'bt470bg', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv');
  return a;
}

/** filter chain that takes ddagrab's GPU frames to what the encoder wants */
function videoChain(p) {
  const scale = p.scaleTo ? `scale=${p.scaleTo.w}:${p.scaleTo.h}:flags=bicubic,` : '';
  if (p.encoder === 'cpu' || p.scaleTo) return `hwdownload,format=bgra,${scale}format=${p.encoder === 'qsv' ? 'nv12' : 'yuv420p'}`;
  if (p.encoder === 'qsv') return 'hwmap=derive_device=qsv,format=qsv';
  return ''; // NVENC and AMF take the D3D11 frames as they are
}

/** audio filter graph: volumes, mic cleanup, the mix and the extra tracks */
function audioGraph(p) {
  const A = p.audio;
  if (!A || !A.sources.length) return { graph: [], maps: [], titles: [] };
  const graph = [];
  const n = A.sources.length;
  const game = [], mic = [];
  A.sources.forEach((s, i) => {
    const f = [];
    if (s.kind === 'mic') {
      f.push('highpass=f=80');
      if (s.denoise) f.push('afftdn=nr=14:nf=-35:tn=1');
      if (s.gate) f.push(`agate=threshold=${Math.pow(10, (s.gateDb || -45) / 20).toFixed(5)}:ratio=8:attack=4:release=180`);
    }
    f.push(`volume=${((s.volume == null ? 100 : s.volume) / 100).toFixed(3)}`);
    graph.push(`[${i + 1}:a]${f.join(',')}[s${i}]`);
    (s.kind === 'mic' ? mic : game).push(i);
  });
  const sep = A.tracks === 'separate' && game.length && mic.length;
  // each source may feed the mix and its own group
  const uses = (i) => (sep ? 2 : 1);
  const out = A.sources.map((_, i) => []);
  A.sources.forEach((_, i) => {
    if (uses(i) === 1) out[i] = [`s${i}`];
    else {
      graph.push(`[s${i}]asplit=2[s${i}a][s${i}b]`);
      out[i] = [`s${i}a`, `s${i}b`];
    }
  });
  const mix = (labels, name) => {
    if (labels.length === 1) graph.push(`[${labels[0]}]anull[${name}]`);
    else graph.push(`${labels.map((l) => `[${l}]`).join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[${name}]`);
  };
  const maps = [], titles = [];
  const finish = (label, title) => {
    // captured sound reaches us ~15 ms after it played (Windows mixing + capture buffers), measured
    // with a flash-and-click test; pull it forward by that much, plus the user's own sync setting
    const ms = (A.offsetMs || 0) - AUDIO_LATENCY_MS;
    const shift = ms > 0 ? `adelay=${ms}:all=1,` : ms < 0 ? `atrim=start=${(-ms / 1000).toFixed(3)},asetpts=PTS-STARTPTS,` : '';
    graph.push(`[${label}]${shift}alimiter=limit=0.97:level=0[o${maps.length}]`);
    maps.push(`[o${maps.length}]`);
    titles.push(title);
  };
  mix(A.sources.map((_, i) => out[i][0]), 'mixall');
  finish('mixall', n > 1 ? 'Everything' : A.sources[0].kind === 'mic' ? 'Microphone' : 'Game and apps');
  if (sep) {
    mix(game.map((i) => out[i][1]), 'mixgame');
    finish('mixgame', 'Game and apps');
    mix(mic.map((i) => out[i][1]), 'mixmic');
    finish('mixmic', 'Microphone');
  }
  return { graph, maps, titles };
}

function ffmpegArgs(p, pipes, dir, outFile) {
  // a full recording reads 'q' on stdin to finish cleanly; the replay never needs stdin
  const a = ['-hide_banner', ...(outFile ? [] : ['-nostdin']), '-loglevel', process.env.GLIMPSE_REPLAY_DEBUG ? 'verbose' : 'warning', '-stats', '-stats_period', '2'];
  let dd = `ddagrab=output_idx=${p.outputIdx}:framerate=${p.fps}:draw_mouse=${p.cursor ? 1 : 0}`;
  if (p.crop) dd += `:video_size=${p.crop.w}x${p.crop.h}:offset_x=${p.crop.x}:offset_y=${p.crop.y}`;
  a.push('-f', 'lavfi', '-thread_queue_size', '64', '-i', dd);
  for (const name of pipes) {
    a.push('-thread_queue_size', '2048', '-probesize', '32', '-analyzeduration', '0', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', `\\\\.\\pipe\\${name}`);
  }
  const chain = videoChain(p);
  const au = audioGraph(p);
  const graph = [...(chain ? [`[0:v]${chain}[v]`] : []), ...au.graph];
  if (graph.length) a.push('-filter_complex', graph.join(';'));
  a.push('-map', chain ? '[v]' : '0:v');
  for (const m of au.maps) a.push('-map', m);
  a.push(...videoArgs(p));
  if (au.maps.length) a.push('-c:a', 'aac', '-b:a', `${p.audio.kbps || 192}k`, '-ar', '48000');
  a.push('-max_muxing_queue_size', '4096');
  if (outFile) {
    a.push('-f', 'matroska', '-y', outFile);
    return { args: a, titles: au.titles };
  }
  const wrap = Math.ceil(p.length / SEG) + 6;
  a.push('-f', 'segment', '-segment_time', String(SEG), '-segment_format', p.codec === 'av1' ? 'matroska' : 'mpegts',
    '-reset_timestamps', p.codec === 'av1' ? '1' : '0', '-segment_wrap', String(wrap), path.join(dir, `seg%05d.${p.codec === 'av1' ? 'mkv' : 'ts'}`));
  return { args: a, titles: au.titles };
}

// ---------- the running replay ----------

class Replay extends EventEmitter {
  constructor({ ffmpeg, root }) {
    super();
    this.ffmpeg = ffmpeg;
    this.root = root;
    this.state = 'off'; // off | starting | on | error
    this.error = '';
    this.plan = null;
    this.want = false;
    this.run = 0;
    this.fails = 0;
    this.levels = [];
    this.stats = null;
    this.muted = new Set();
  }

  get dir() {
    return path.join(this.root, `run-${this.run}`);
  }

  _set(state, error = '') {
    this.state = state;
    this.error = error;
    this.emit('state', { state, error });
  }

  async start(plan) {
    this.stop(true);
    this.plan = plan;
    this.want = true;
    this.fails = 0;
    this.titles = [];
    await this._launch();
  }

  async _launch() {
    if (!this.want) return;
    const run = ++this.run;
    const p = this.plan;
    this._set('starting');
    // wipe pieces from earlier runs
    try {
      for (const d of fs.readdirSync(this.root)) if (d.startsWith('run-')) fs.rmSync(path.join(this.root, d), { recursive: true, force: true });
    } catch {}
    fs.mkdirSync(this.dir, { recursive: true });

    // 1. the sound helper, which opens one named pipe per source
    const pipes = [];
    if (p.audio && p.audio.sources.length) {
      const args = ['--levels'];
      p.audio.sources.forEach((s, i) => {
        const name = `glimpse-${process.pid}-${run}-${i}`;
        pipes.push(name);
        args.push('--source', s.spec, '--pipe', name);
        if (s.kind === 'mic' && s.ptt) args.push('--ptt', String(s.ptt));
      });
      const helper = spawn(HELPER, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.helper = helper;
      let ready;
      const isReady = new Promise((r) => (ready = r));
      let buf = '';
      helper.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const m = JSON.parse(line);
            if (m.ready) ready(true);
            if (m.levels) {
              this.levels = m.levels;
              this.emit('levels', m.levels);
            }
          } catch {}
        }
      });
      let herr = '';
      helper.stderr.on('data', (d) => (herr = (herr + d).slice(-4000)));
      helper.on('error', () => ready(false));
      helper.on('exit', () => {
        ready(false);
        if (run === this.run && this.want && this.proc) this._crashed(run, 'The sound capture stopped. ' + herr.trim().split(/\r?\n/).pop());
      });
      const ok = await Promise.race([isReady, new Promise((r) => setTimeout(() => r(false), 6000))]);
      if (run !== this.run) return;
      if (!ok) return this._crashed(run, 'Could not start sound capture. ' + herr.trim().split(/\r?\n/).pop());
      // keep mic mutes across restarts
      for (const i of this.muted) this._helperCmd(`mute ${i} 1`);
    }

    // 2. ffmpeg
    const { args, titles } = ffmpegArgs(p, pipes, this.dir);
    this.titles = titles;
    this.lastArgs = args;
    const proc = spawn(this.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    try {
      require('os').setPriority(proc.pid, require('os').constants.priority.PRIORITY_ABOVE_NORMAL);
    } catch {}
    let log = '';
    const started = Date.now();
    proc.stderr.on('data', (d) => {
      const s = String(d);
      log = (log + s).slice(-6000);
      const m = /frame=\s*(\d+).*?fps=\s*([\d.]+).*?(?:dup=(\d+))?\s*(?:drop=(\d+))?\s*speed=/.exec(s);
      const fr = /frame=\s*(\d+)/.exec(s);
      if (fr) {
        const dup = /dup=(\d+)/.exec(s), drop = /drop=(\d+)/.exec(s), fps = /fps=\s*([\d.]+)/.exec(s);
        this.stats = { frames: +fr[1], fps: fps ? +fps[1] : 0, dup: dup ? +dup[1] : 0, drop: drop ? +drop[1] : 0 };
        if (this.state !== 'on' && run === this.run && +fr[1] > 0) {
          this.fails = 0;
          this._set('on');
        }
      }
      void m;
    });
    proc.on('error', (e) => this._crashed(run, `Could not start ffmpeg: ${e.message}`));
    proc.on('exit', (code) => {
      if (run !== this.run || !this.want) return;
      try {
        fs.writeFileSync(path.join(this.root, 'last-crash.log'), `${args.join(' ')}\n\n${log}`);
      } catch {}
      const tail = log.trim().split(/\r?\n/).filter((l) => !/^frame=/.test(l)).slice(-2).join(' ').slice(0, 300);
      this._crashed(run, tail || `The recorder stopped (code ${code})`, Date.now() - started);
    });
  }

  _crashed(run, message, ranFor = 0) {
    if (run !== this.run || !this.want) return;
    this._kill();
    // a run that worked for a while (screen locked, display changed) just restarts
    if (ranFor > 20000) this.fails = 0;
    this.fails++;
    this.emit('crash', { message, fails: this.fails });
    if (this.fails >= 4) {
      this.want = false;
      this._set('error', message);
      return;
    }
    this._set('starting', message);
    const delay = [800, 2000, 5000][Math.min(this.fails - 1, 2)];
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this._launch(), delay);
  }

  _helperCmd(line) {
    try {
      if (this.helper && this.helper.stdin.writable) this.helper.stdin.write(line + '\n');
    } catch {}
  }

  /** mute / unmute one sound source (by index) in the recording */
  mute(i, on) {
    if (on) this.muted.add(i);
    else this.muted.delete(i);
    this._helperCmd(`mute ${i} ${on ? 1 : 0}`);
  }

  _kill() {
    const { proc, helper } = this;
    this.proc = null;
    this.helper = null;
    if (proc) {
      try {
        proc.kill();
      } catch {}
    }
    if (helper) {
      try {
        helper.stdin.end('quit\n');
      } catch {}
      setTimeout(() => {
        try {
          helper.kill();
        } catch {}
      }, 1500);
    }
  }

  stop(silent) {
    this.want = false;
    clearTimeout(this.retry);
    this._kill();
    this.run++;
    this.levels = [];
    if (!silent) this._set('off');
    // wipe the old pieces once ffmpeg has let go of them, but never the folder of a run started since
    setTimeout(() => {
      try {
        const live = this.want ? `run-${this.run}` : '';
        for (const d of fs.readdirSync(this.root)) if (d.startsWith('run-') && d !== live) fs.rmSync(path.join(this.root, d), { recursive: true, force: true });
      } catch {}
    }, 800);
  }

  /** seconds currently buffered (roughly) */
  buffered() {
    try {
      return fs.readdirSync(this.dir).filter((f) => /^seg\d+\./.test(f)).length * SEG;
    } catch {
      return 0;
    }
  }

  /** join the newest pieces covering `seconds` into outFile (mp4/mkv). Resolves { file, seconds } */
  async save(seconds, outFile) {
    if (this.state !== 'on') throw new Error('Instant replay is not running');
    const dir = this.dir;
    const list = () => fs.readdirSync(dir)
      .filter((f) => /^seg\d+\.(ts|mkv)$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { f: path.join(dir, f), t: st.mtimeMs, size: st.size };
      })
      .filter((x) => x.size > 1024)
      .sort((a, b) => a.t - b.t);
    let pieces = list();
    if (!pieces.length) throw new Error('Nothing recorded yet');
    // the newest piece is still being written; wait for it to finish (at most a second) so the clip
    // ends exactly at the moment the hotkey was pressed and has no half-written frame
    const current = pieces[pieces.length - 1].f;
    const t0 = Date.now();
    while (Date.now() - t0 < SEG * 1000 + 1500) {
      await new Promise((r) => setTimeout(r, 80));
      const now = list();
      if (now.length && now[now.length - 1].f !== current) {
        pieces = now;
        break;
      }
    }
    const upto = pieces.findIndex((x) => x.f === current);
    if (upto >= 0) pieces = pieces.slice(0, upto + 1);
    const pick = pieces.slice(-Math.ceil(seconds / SEG));
    const work = path.join(this.root, `save-${Date.now()}`);
    fs.mkdirSync(work, { recursive: true });
    try {
      let input;
      if (/\.ts$/.test(pick[0].f)) {
        // MPEG-TS pieces with running timestamps join by simply putting the bytes back to back
        input = ['-i', path.join(work, 'joined.ts')];
        const fd = fs.openSync(input[1], 'w');
        for (const x of pick) fs.writeSync(fd, fs.readFileSync(x.f));
        fs.closeSync(fd);
      } else {
        const list = pick.map((x, i) => {
          const copy = path.join(work, `${String(i).padStart(4, '0')}${path.extname(x.f)}`);
          fs.copyFileSync(x.f, copy);
          return `file '${copy.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
        });
        fs.writeFileSync(path.join(work, 'list.txt'), list.join('\n'));
        input = ['-f', 'concat', '-safe', '0', '-i', path.join(work, 'list.txt')];
      }
      const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', ...input, '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero'];
      this.titles.forEach((t, i) => args.push(`-metadata:s:a:${i}`, `title=${t}`, `-metadata:s:a:${i}`, `handler_name=${t}`));
      if (this.titles.length > 1) args.push('-disposition:a:0', 'default', ...this.titles.slice(1).flatMap((_, i) => [`-disposition:a:${i + 1}`, '0']));
      if (/\.mp4$/i.test(outFile)) args.push('-movflags', '+faststart', ...(this.plan.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []));
      args.push('-y', outFile);
      await new Promise((resolve, reject) => {
        execFile(this.ffmpeg, args, { windowsHide: true, timeout: 120000 }, (err, _o, stderr) =>
          err ? reject(new Error(String(stderr || err.message).trim().split(/\r?\n/).pop())) : resolve());
      });
      return { file: outFile, seconds: Math.min(seconds, pick.length * SEG) };
    } finally {
      fs.rm(work, { recursive: true, force: true }, () => {});
    }
  }
}

// ---------- a full recording (start / stop), same settings as the replay ----------

function spawnHelper(p, tag, onLevels) {
  return new Promise((resolve, reject) => {
    const pipes = [];
    const args = ['--levels'];
    p.audio.sources.forEach((src, i) => {
      const name = `glimpse-${process.pid}-${tag}-${i}`;
      pipes.push(name);
      args.push('--source', src.spec, '--pipe', name);
      if (src.kind === 'mic' && src.ptt) args.push('--ptt', String(src.ptt));
    });
    const helper = spawn(HELPER, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', err = '', done = false;
    const t = setTimeout(() => !done && ((done = true), helper.kill(), reject(new Error('Could not start sound capture'))), 6000);
    helper.stderr.on('data', (d) => (err = (err + d).slice(-3000)));
    helper.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.ready && !done) {
            done = true;
            clearTimeout(t);
            resolve({ helper, pipes });
          }
          if (m.levels && onLevels) onLevels(m.levels);
        } catch {}
      }
    });
    helper.on('exit', () => !done && ((done = true), clearTimeout(t), reject(new Error('Sound capture failed. ' + err.trim().split(/\r?\n/).pop()))));
  });
}

class Recording extends EventEmitter {
  constructor({ ffmpeg }) {
    super();
    this.ffmpeg = ffmpeg;
    this.proc = null;
    this.started = 0;
  }

  get active() {
    return !!this.proc;
  }

  async start(plan, file) {
    if (this.proc) throw new Error('Already recording');
    this.plan = plan;
    this.file = file; // final .mp4 / .mkv
    this.tmp = file.replace(/\.\w+$/, '') + '.recording.mkv';
    this.h = plan.audio.sources.length ? await spawnHelper(plan, `rec${Date.now() % 100000}`, (l) => this.emit('levels', l)) : null;
    const { args, titles } = ffmpegArgs(plan, this.h ? this.h.pipes : [], null, this.tmp);
    this.titles = titles;
    const proc = spawn(this.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = proc;
    try {
      require('os').setPriority(proc.pid, require('os').constants.priority.PRIORITY_ABOVE_NORMAL);
    } catch {}
    this.log = '';
    proc.stderr.on('data', (d) => (this.log = (this.log + d).slice(-6000)));
    this.exited = new Promise((r) => proc.on('exit', (code) => r(code)));
    proc.on('exit', () => {
      if (this.proc === proc && !this.stopping) this.emit('died', this.log.trim().split(/\r?\n/).filter((l) => !/^frame=/.test(l)).pop() || 'The recorder stopped');
    });
    this.started = Date.now();
  }

  /** stop, then turn the crash-safe MKV into the final file. Resolves { file, seconds } */
  async stop() {
    const proc = this.proc;
    if (!proc) throw new Error('Not recording');
    this.stopping = true;
    try {
      proc.stdin.write('q');
    } catch {}
    const code = await Promise.race([this.exited, new Promise((r) => setTimeout(() => r('timeout'), 10000))]);
    if (code === 'timeout') proc.kill();
    if (this.h) {
      try {
        this.h.helper.stdin.end('quit\n');
      } catch {}
    }
    this.proc = null;
    this.stopping = false;
    const seconds = (Date.now() - this.started) / 1000;
    if (!fs.existsSync(this.tmp) || fs.statSync(this.tmp).size < 1024) throw new Error('Nothing was recorded');
    if (/\.mkv$/i.test(this.file)) {
      fs.renameSync(this.tmp, this.file);
      return { file: this.file, seconds };
    }
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', this.tmp, '-map', '0', '-c', 'copy'];
    this.titles.forEach((t, i) => args.push(`-metadata:s:a:${i}`, `title=${t}`, `-metadata:s:a:${i}`, `handler_name=${t}`));
    args.push('-movflags', '+faststart', ...(this.plan.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []), '-y', this.file);
    await new Promise((resolve, reject) => execFile(this.ffmpeg, args, { windowsHide: true, timeout: 600000 }, (e, _o, err) => (e ? reject(new Error(String(err || e.message).trim().split(/\r?\n/).pop())) : resolve())));
    fs.rm(this.tmp, { force: true }, () => {});
    return { file: this.file, seconds };
  }
}

module.exports = { Recording, Replay, probeEncoders, helperJSON, ENCODERS, HELPER, ffmpegArgs };
