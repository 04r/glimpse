'use strict';
// Scrolling capture: scroll the area, grab it once the page has stopped moving, and stitch the frames
// into one tall image.
//
// How it stays reliable on real apps:
// - every frame is reduced to a small grey "signature" per pixel row (averaged blocks), and rows are
//   compared with a tolerance, so anti-aliasing, hover highlights or a blinking caret don't break a match
// - after each scroll it waits until two grabs in a row are the same (smooth scrolling has finished)
// - the step size adapts: it aims to move about half the area per step, and if a step jumped too far
//   to match, it scrolls back and retries with a smaller step
// - fixed bars (sticky headers and footers) are found once and kept out of the repeat
// - if the wheel doesn't move the content at all, it switches to manual mode: the user scrolls and
//   every new position is stitched in as it settles

const MAX_ROWS = 30000;
const MAX_STEPS = 160;
const COLS = 96; // samples per row
const ROW_TOL = 6; // mean grey difference (0-255) below which two rows count as the same
const SAME_TOL = 2.5; // stricter: "this row did not change at all"

/** grey signature: COLS averaged samples per row, plus each row's detail (spread of values) */
function signature(frame) {
  const { w, h, data } = frame;
  const x0 = Math.min(2, w - 1), x1 = Math.max(x0 + COLS, w - 24); // skip the right edge (scrollbars)
  const span = (x1 - x0) / COLS;
  const sig = new Float32Array(h * COLS);
  const detail = new Float32Array(h);
  const mean = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const base = y * w * 4;
    let sum = 0, sum2 = 0;
    for (let c = 0; c < COLS; c++) {
      const a = Math.floor(x0 + c * span), b = Math.max(a + 1, Math.floor(x0 + (c + 1) * span));
      let s = 0, n = 0;
      for (let x = a; x < b && x < w; x += b - a > 8 ? 2 : 1) {
        const i = base + x * 4;
        s += data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
        n++;
      }
      const v = n ? s / n : 0;
      sig[y * COLS + c] = v;
      sum += v;
      sum2 += v * v;
    }
    mean[y] = sum / COLS;
    detail[y] = Math.sqrt(Math.max(0, sum2 / COLS - mean[y] * mean[y]));
  }
  return { h, sig, detail, mean };
}

function rowDiff(A, ya, B, yb) {
  const a = ya * COLS, b = yb * COLS;
  let d = 0;
  for (let c = 0; c < COLS; c++) d += Math.abs(A.sig[a + c] - B.sig[b + c]);
  return d / COLS;
}

// biggest single-block difference: rows that differ in just a few letters ("Item 7" vs "Item 8")
// have a small average difference but a big one where the letters differ
function rowMax(A, ya, B, yb) {
  const a = ya * COLS, b = yb * COLS;
  let m = 0;
  for (let c = 0; c < COLS; c++) {
    const d = Math.abs(A.sig[a + c] - B.sig[b + c]);
    if (d > m) m = d;
  }
  return m;
}
const ROW_MAX = 30; // block difference that means "different content", not just smoothing
const sameRow = (A, ya, B, yb) => rowDiff(A, ya, B, yb) < SAME_TOL && rowMax(A, ya, B, yb) < ROW_MAX * 0.6;

// for sticky bars: the row stayed put apart from a small part (a spinner, a badge, a blinking caret)
function barRow(A, ya, B, yb) {
  const a = ya * COLS, b = yb * COLS;
  let changed = 0;
  for (let c = 0; c < COLS; c++) if (Math.abs(A.sig[a + c] - B.sig[b + c]) > 12) changed++;
  return changed <= COLS * 0.12;
}

/** share of rows that look the same in both frames (1 = identical) */
function sameness(A, B) {
  // only rows with something on them count; empty background matches anywhere
  const h = Math.min(A.h, B.h);
  let same = 0, n = 0;
  for (let y = 0; y < h; y++) {
    if (A.detail[y] <= 3 && B.detail[y] <= 3 && Math.abs(A.mean[y] - B.mean[y]) < SAME_TOL) continue;
    n++;
    if (sameRow(A, y, B, y)) same++;
  }
  return n ? same / n : 1;
}

const rowOf = (frame, y) => frame.data.subarray(y * frame.w * 4, (y + 1) * frame.w * 4);

/** rows at the top / bottom that stayed put while the rest moved: sticky headers and footers */
function fixedBars(P, C) {
  const H = C.h;
  let same = 0;
  while (same < H && sameRow(P, same, C, same)) same++;
  if (same >= H - 8) return null; // nothing moved
  // bars may hold a small moving part, but are never most of the area
  let top = 0;
  while (top < H * 0.4 && barRow(P, top, C, top)) top++;
  let bot = 0;
  while (bot < H * 0.3 && bot < H - top - 8 && barRow(P, H - 1 - bot, C, H - 1 - bot)) bot++;
  // plain background rows look the same everywhere, so they can't prove a bar is fixed
  const detailed = (from, to) => {
    let n = 0;
    for (let y = from; y < to; y++) if (C.detail[y] > 6) n++;
    return n >= 3;
  };
  if (!detailed(0, top)) top = Math.min(top, 0);
  if (!detailed(H - bot, H)) bot = 0;
  return { top, bot };
}

/**
 * How far did the content move between P (before) and C (after)? Positive = scrolled down.
 * Only rows with visible detail count as evidence. Returns { shift, score } or null.
 */
function findShift(P, C, bandTop, bandEnd, expect) {
  const bandH = bandEnd - bandTop;
  const minOverlap = Math.max(12, Math.round(bandH * 0.08));
  const useful = [];
  for (let r = bandTop; r < bandEnd; r++) if (P.detail[r] > 4) useful.push(r);
  if (useful.length < 6) return null;

  // coarse pass on row means and detail: cheap, finds the candidates
  const cands = [];
  for (let s = 1; s <= bandH - minOverlap; s++) {
    let err = 0, n = 0;
    for (let r = bandTop; r < bandEnd - s; r++) {
      const p = r + s;
      if (P.detail[p] <= 4) continue;
      err += Math.abs(C.mean[r] - P.mean[p]) + Math.abs(C.detail[r] - P.detail[p]);
      n++;
    }
    if (n >= 6) cands.push({ s, e: err / n });
  }
  cands.sort((a, b) => a.e - b.e);
  // the best coarse guesses, each with its close neighbours (smoothing makes a few pixels off look
  // almost right), plus the step we expect from earlier steps
  const tryS = new Set();
  const add = (s) => s >= 1 && s <= bandH - minOverlap && tryS.add(s);
  for (const c of cands.slice(0, 14)) for (let k = -3; k <= 3; k++) add(c.s + k);
  if (expect) for (let k = -3; k <= 3; k++) add(expect + k);

  // full check: share of detailed rows that match within tolerance, and how close they are
  const results = [];
  for (const s of tryS) {
    let m = 0, n = 0, err = 0;
    for (let r = bandTop; r < bandEnd - s; r++) {
      const p = r + s;
      if (P.detail[p] <= 4) continue;
      const d = rowDiff(C, r, P, p);
      n++;
      err += d;
      if (d < ROW_TOL && rowMax(C, r, P, p) < ROW_MAX) m++;
    }
    if (n >= 6) results.push({ shift: s, score: m / n, err: err / n, n });
  }
  if (!results.length) return null;
  // among the best-scoring shifts, the exact one has the smallest pixel error; a tie goes to the
  // step we expected
  const topScore = Math.max(...results.map((r) => r.score));
  const close = results.filter((r) => r.score >= topScore - 0.04);
  close.sort((a, b) => a.err - b.err || (expect ? Math.abs(a.shift - expect) - Math.abs(b.shift - expect) : 0));
  return close[0];
}

/**
 * grab(): { w, h, data } RGBA of the area. scroll(notches): wheel down that many notches
 * (negative = up). stopped(): true to finish. onStep(n, rows), onManual(): progress hooks.
 * Resolves { w, h, data (RGBA), steps, reason, manual }.
 */
async function scrollCapture({ grab, scroll, stopped, onStep, onManual, notches: startNotches = 3, debug }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = debug || (process.env.GLIMPSE_SCROLL_DEBUG ? (...a) => console.log('[scroll]', ...a) : () => {});

  // wait for the content to stop moving: two grabs in a row that match
  const settle = async (minWait = 110, maxWait = 1100) => {
    await sleep(minWait);
    let a = grab(), as = signature(a);
    const t0 = Date.now();
    while (Date.now() - t0 < maxWait) {
      await sleep(70);
      const b = grab(), bs = signature(b);
      if (sameness(as, bs) >= 0.9) return { f: b, s: bs };
      a = b;
      as = bs;
    }
    return { f: a, s: as };
  };

  const first = grab();
  const W = first.w;
  let prev = first, prevS = signature(first);
  let rows = null; // stitched rows (fixed footer excluded)
  let footer = [];
  let steps = 0, still = 0, reason = 'end', manual = false;
  let bars = null;
  let notches = startNotches;
  let perNotch = 0; // learned pixels per wheel notch

  // stitch C onto the result, given the shift inside the moving band
  const stitch = (cur, curS, band, shift) => {
    if (!rows) {
      rows = [];
      for (let y = 0; y < band.end; y++) rows.push(rowOf(first, y));
    }
    for (let y = band.end - shift; y < band.end; y++) rows.push(rowOf(cur, y));
    footer = [];
    for (let y = band.end; y < cur.h; y++) footer.push(rowOf(cur, y));
    prev = cur;
    prevS = curS;
    steps++;
    if (onStep) onStep(steps, rows.length + footer.length);
  };

  // look at a new frame: 'still' | 'ok' | 'lost' | 'up', plus the match when it is 'ok'
  const analyze = (curS) => {
    if (sameness(prevS, curS) >= 0.9) return { kind: 'still' };
    const fb = fixedBars(prevS, curS);
    if (!fb) return { kind: 'still' };
    const top = bars ? Math.min(bars.top, fb.top) : fb.top;
    const bot = bars ? Math.min(bars.bot, fb.bot) : fb.bot;
    const band = { top, end: curS.h - bot };
    const expect = perNotch && !manual ? Math.round(perNotch * notches) : 0;
    const m = findShift(prevS, curS, band.top, band.end, expect);
    log(JSON.stringify({ step: steps, notches, bars: { top, bot }, m, rows: rows ? rows.length : 0 }));
    if (!m || m.score < 0.72) {
      // moved up instead? (manual mode: the user scrolled back)
      const up = findShift(curS, prevS, band.top, band.end, 0);
      if (up && up.score >= 0.8) return { kind: 'up' };
      return { kind: 'lost' };
    }
    return { kind: 'ok', band, m, bars: { top, bot } };
  };

  const commit = (cur, curS, a) => {
    if (!bars) bars = a.bars;
    stitch(cur, curS, a.band, a.m.shift);
    if (!manual) {
      const pn = a.m.shift / notches;
      perNotch = perNotch ? perNotch * 0.5 + pn * 0.5 : pn;
      // aim for about half the moving band per step
      const bandH = a.band.end - a.band.top;
      notches = Math.max(1, Math.min(12, Math.round((bandH * 0.5) / Math.max(1, perNotch))));
    }
  };

  // a weak or failed match is often one bad grab (a repaint, a popup): look again before trusting it
  const look = async (cur, curS) => {
    let a = analyze(curS);
    const firstS = curS;
    for (let k = 0; k < 3 && (a.kind === 'lost' || a.kind === 'up' || (a.kind === 'ok' && a.m.score < 0.9)); k++) {
      await sleep(150 + k * 100);
      const g = grab(), gs = signature(g);
      if (sameness(firstS, gs) >= 0.93) break; // same picture again: looking more won't help
      const b = analyze(gs);
      if (b.kind === 'ok' && (a.kind !== 'ok' || b.m.score > a.m.score)) { a = b; cur = g; curS = gs; }
    }
    return { a, cur, curS };
  };

  // ---------- automatic: wheel the content ----------
  let tries = 0;
  for (let i = 0; i < MAX_STEPS; i++) {
    if (stopped()) { reason = 'stopped'; break; }
    scroll(notches);
    const t0 = Date.now();
    const st = await settle();
    log('settle ms', Date.now() - t0);
    const { a, cur, curS } = await look(st.f, st.s);
    if (a.kind === 'still') {
      if (steps === 0) {
        // nothing has ever moved: maybe the wheel is ignored here, try once more then go manual
        if (++tries >= 2) { manual = true; break; }
        continue;
      }
      if (++still >= 2) { reason = 'end'; break; }
      continue;
    }
    still = 0;
    if (a.kind === 'ok') {
      commit(cur, curS, a);
      if (rows.length >= MAX_ROWS) { reason = 'max'; break; }
      continue;
    }
    // jumped too far to find the overlap: go back and take smaller steps
    if (notches > 1) {
      scroll(-notches);
      const back = await settle();
      notches = Math.max(1, Math.floor(notches / 2));
      perNotch = 0;
      if (sameness(prevS, back.s) < 0.9) {
        // couldn't return exactly; carry on from wherever we are if it matches
        const again = await look(back.f, back.s);
        if (again.a.kind !== 'ok') { reason = 'lost'; break; }
        commit(again.cur, again.curS, again.a);
      }
      continue;
    }
    reason = 'lost';
    break;
  }

  // ---------- manual: the user scrolls, we stitch whatever settles ----------
  if (manual && !stopped()) {
    if (onManual) onManual();
    let idle = Date.now();
    let last = prevS;
    while (!stopped()) {
      await sleep(60);
      const cur = grab(), curS = signature(cur);
      if (sameness(last, curS) < 0.95) { last = curS; idle = Date.now(); continue; } // still moving
      if (sameness(prevS, curS) >= 0.9) {
        if (Date.now() - idle > 90000) { reason = 'idle'; break; }
        continue;
      }
      const r = analyze(curS);
      // scrolled up, or too far in one go: keep waiting, a later position may still line up
      if (r.kind !== 'ok') continue;
      commit(cur, curS, r);
      if ((rows ? rows.length : 0) >= MAX_ROWS) { reason = 'max'; break; }
    }
    if (stopped()) reason = 'stopped';
  }

  if (!rows) return { w: W, h: first.h, data: first.data, steps: 0, reason, manual };
  const all = rows.concat(footer);
  const data = Buffer.alloc(W * all.length * 4);
  all.forEach((r, y) => data.set(r, y * W * 4));
  return { w: W, h: all.length, data, steps, reason, manual };
}

module.exports = { scrollCapture, signature, findShift, fixedBars };
