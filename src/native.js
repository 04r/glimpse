'use strict';
// Small Win32 helpers through koffi: the visible windows (for snapping a selection to a window),
// and cursor + mouse-wheel input (for scrolling capture).
let api = null;
try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const dwm = koffi.load('dwmapi.dll');
  const RECT = koffi.struct('GLIMPSE_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
  const POINT = koffi.struct('GLIMPSE_POINT', { x: 'int32_t', y: 'int32_t' });
  api = {
    GetTopWindow: user32.func('void* __stdcall GetTopWindow(void* hWnd)'),
    GetWindow: user32.func('void* __stdcall GetWindow(void* hWnd, uint32_t uCmd)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void* hWnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(void* hWnd)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(void* hWnd, _Out_ GLIMPSE_RECT* rect)'),
    GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void* hWnd, _Out_ uint32_t* pid)'),
    GetWindowLongW: user32.func('int32_t __stdcall GetWindowLongW(void* hWnd, int32_t index)'),
    GetWindowTextLengthW: user32.func('int32_t __stdcall GetWindowTextLengthW(void* hWnd)'),
    DwmRect: dwm.func('long __stdcall DwmGetWindowAttribute(void* hwnd, uint32_t attr, _Out_ GLIMPSE_RECT* value, uint32_t size)'),
    DwmInt: dwm.func('long __stdcall DwmGetWindowAttribute(void* hwnd, uint32_t attr, _Out_ int32_t* value, uint32_t size)'),
    SetCursorPos: user32.func('bool __stdcall SetCursorPos(int32_t x, int32_t y)'),
    GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ GLIMPSE_POINT* p)'),
    mouse_event: user32.func('void __stdcall mouse_event(uint32_t flags, uint32_t dx, uint32_t dy, int32_t data, uintptr_t extra)'),
  };
} catch {}

const GW_HWNDNEXT = 2, GWL_EXSTYLE = -20, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;

// Visible top-level windows, front to back, as screen rects in physical pixels (shadows excluded).
// Our own windows are skipped.
function windowRects() {
  if (!api) return [];
  const out = [];
  const pid = [0];
  let h = api.GetTopWindow(null);
  for (let n = 0; h && n < 2000; n++, h = api.GetWindow(h, GW_HWNDNEXT)) {
    if (!api.IsWindowVisible(h) || api.IsIconic(h)) continue;
    api.GetWindowThreadProcessId(h, pid);
    if (pid[0] === process.pid) continue;
    const ex = api.GetWindowLongW(h, GWL_EXSTYLE);
    if (ex & WS_EX_TRANSPARENT) continue;
    // floating helpers without a title (tooltips, shadows, drag images) are noise
    if ((ex & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) && api.GetWindowTextLengthW(h) === 0) continue;
    const cloaked = [0];
    if (api.DwmInt(h, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0]) continue;
    const r = {};
    if (api.DwmRect(h, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) !== 0 && !api.GetWindowRect(h, r)) continue;
    const w = r.right - r.left, hh = r.bottom - r.top;
    if (w < 40 || hh < 30) continue;
    out.push({ x: r.left, y: r.top, width: w, height: hh });
  }
  return out;
}

function cursorPos() {
  if (!api) return null;
  const p = {};
  return api.GetCursorPos(p) ? p : null;
}
function setCursorPos(x, y) {
  if (api) api.SetCursorPos(Math.round(x), Math.round(y));
}
// one wheel "notch" is 120; negative scrolls down
function wheel(amount) {
  if (api) api.mouse_event(0x0800 /* MOUSEEVENTF_WHEEL */, 0, 0, amount, 0);
}

module.exports = { available: !!api, windowRects, cursorPos, setCursorPos, wheel };
