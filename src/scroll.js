'use strict';
// Scrolling capture: scroll the area with the mouse wheel, grab it after every step and stitch the
// frames into one tall image. Each step finds how far the content moved by matching pixel rows,
// keeps fixed bars (sticky headers and footers) out of the repeat, and stops at the end of the page.

const MAX_ROWS = 16000;
const MAX_STEPS = 80;

// one 32-bit hash per pixel row; skips the right edge so a moving scrollbar doesn't break matches
function rowHashes(frame) {
  const { w, h, data } = frame;
  const out = new Uint32Array(h);
  const x0 = Math.min(2, w - 1), x1 = Math.max(x0 + 1, w - 22);
  for (let y = 0; y < h; y++) {
    let hsh = 2166136261;
    const base = y * w * 4;
    for (let x = x0; x < x1; x += 2) {
      const i = base + x * 4;
      hsh = Math.imul(hsh ^ data[i], 16777619);
      hsh = Math.imul(hsh ^ data[i + 1], 16777619);
      hsh = Math.imul(hsh ^ data[i + 2], 16777619);
    }
    out[y] = hsh >>> 0;
  }
  return out;
}

const rowOf = (frame, y) => frame.data.subarray(y * frame.w * 4, (y + 1) * frame.w * 4);

// rows of plain background repeat everywhere, so they can't prove a bar is fixed
function hasDetail(hashes, from, to) {
  const seen = new Set();
  for (let i = from; i < to; i++) {
    seen.add(hashes[i]);
    if (seen.size >= 4) return true;
  }
  return false;
}

// Fixed bars at the top and bottom (sticky headers, footers): rows that did not change between frames.
function fixedBars(prevH, curH) {
  const H = curH.length;
  let top = 0;
  while (top < H && curH[top] === prevH[top]) top++;
  if (top >= H - 2) return null; // nothing moved
  let bot = 0;
  while (bot < H - top - 2 && curH[H - 1 - bot] === prevH[H - 1 - bot]) bot++;
  if (!hasDetail(curH, H - bot, H)) bot = 0;
  return { top, bot };
}

// How far did the content move between two frames? Returns the band that moves and the shift.
// bars: fixed header/footer heights decided on the first step and kept for the whole capture.
// Only distinctive rows count as evidence: plain background rows look the same everywhere and would
// make any shift look plausible.
function matchShift(prevH, curH, bars) {
  const H = curH.length;
  const now = fixedBars(prevH, curH);
  if (!now) return { still: true };
  const top = bars ? Math.min(bars.top, now.top) : now.top;
  let bot = bars ? bars.bot : now.bot;
  // a footer that stopped matching was never fixed
  for (let i = 0; i < bot; i++) if (curH[H - 1 - i] !== prevH[H - 1 - i]) { bot = 0; break; }
  const bandTop = top, bandEnd = H - bot, bandH = bandEnd - bandTop;

  // how often each row appears in the previous frame's band
  const freq = new Map();
  for (let r = bandTop; r < bandEnd; r++) freq.set(prevH[r], (freq.get(prevH[r]) || 0) + 1);
  const informative = (h) => (freq.get(h) || 0) <= 2;

  const scoreAt = (s) => {
    let m = 0, n = 0;
    for (let r = bandTop; r < bandEnd - s; r++) {
      const p = prevH[r + s];
      if (!informative(p)) continue;
      n++;
      if (curH[r] === p) m++;
    }
    return n >= 6 ? m / n : 0;
  };
  // barely anything changed (a caret or the cursor): the page has stopped
  if (scoreAt(0) >= 0.9) return { still: true };
  let best = 0, bestScore = 0;
  for (let s = 1; s <= bandH - 8; s++) {
    const score = scoreAt(s);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = s;
    }
  }
  return { still: false, bandTop, bandEnd, shift: best, score: bestScore, bars: { top, bot } };
}

/**
 * grab(): { w, h, data } RGBA of the area, scroll(): one scroll step, stopped(): true to finish early,
 * onStep(n, rows): progress. Resolves { w, h, data (RGBA), steps, reason }.
 */
async function scrollCapture({ grab, scroll, stopped, onStep, settle = 330 }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const first = grab();
  const W = first.w;
  let prev = first, prevH = rowHashes(first);
  let rows = null; // stitched rows, fixed footer excluded
  let footer = [];
  let steps = 0, still = 0, reason = 'end';
  let bars = null;
  for (let i = 0; i < MAX_STEPS; i++) {
    if (stopped()) { reason = 'stopped'; break; }
    scroll();
    await sleep(settle);
    const cur = grab();
    const curH = rowHashes(cur);
    const m = matchShift(prevH, curH, bars);
    if (process.env.GLIMPSE_SCROLL_DEBUG) console.log('[scroll]', i, JSON.stringify({ ...m, rows: rows ? rows.length : 0 }));
    if (m.still) {
      // nothing moved: end of the page (try once more for slow pages)
      if (++still >= 2) { reason = 'end'; break; }
      continue;
    }
    still = 0;
    if (m.score < 0.6 || m.shift < 1) { reason = 'lost'; break; }
    if (!bars) bars = m.bars;
    if (!rows) {
      rows = [];
      for (let y = 0; y < m.bandEnd; y++) rows.push(rowOf(first, y));
    }
    for (let y = m.bandEnd - m.shift; y < m.bandEnd; y++) rows.push(rowOf(cur, y));
    footer = [];
    for (let y = m.bandEnd; y < cur.h; y++) footer.push(rowOf(cur, y));
    prev = cur;
    prevH = curH;
    steps++;
    if (onStep) onStep(steps, rows.length + footer.length);
    if (rows.length >= MAX_ROWS) { reason = 'max'; break; }
  }
  if (!rows) return { w: W, h: first.h, data: first.data, steps: 0, reason };
  const all = rows.concat(footer);
  const data = Buffer.alloc(W * all.length * 4);
  all.forEach((r, y) => data.set(r, y * W * 4));
  return { w: W, h: all.length, data, steps, reason };
}

module.exports = { scrollCapture, rowHashes, matchShift };
