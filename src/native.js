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
    GetForegroundWindow: user32.func('void* __stdcall GetForegroundWindow()'),
    GetWindowTextW: user32.func('int32_t __stdcall GetWindowTextW(void* hWnd, _Out_ uint16_t* buf, int32_t max)'),
  };
  const kernel32 = koffi.load('kernel32.dll');
  const PE = koffi.struct('GLIMPSE_PROCESSENTRY32W', {
    dwSize: 'uint32_t', cntUsage: 'uint32_t', th32ProcessID: 'uint32_t', th32DefaultHeapID: 'uintptr_t',
    th32ModuleID: 'uint32_t', cntThreads: 'uint32_t', th32ParentProcessID: 'uint32_t', pcPriClassBase: 'int32_t',
    dwFlags: 'uint32_t', szExeFile: koffi.array('char16_t', 260, 'String'),
  });
  Object.assign(api, {
    PE,
    OpenProcess: kernel32.func('void* __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(void* h)'),
    QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void* h, uint32_t flags, _Out_ uint16_t* buf, _Inout_ uint32_t* size)'),
    CreateToolhelp32Snapshot: kernel32.func('void* __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)'),
    Process32FirstW: kernel32.func('bool __stdcall Process32FirstW(void* snap, _Inout_ GLIMPSE_PROCESSENTRY32W* e)'),
    Process32NextW: kernel32.func('bool __stdcall Process32NextW(void* snap, _Inout_ GLIMPSE_PROCESSENTRY32W* e)'),
  });
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

const u16 = (buf, n) => Buffer.from(buf.buffer, buf.byteOffset, n * 2).toString('utf16le');

const baseName = (p) => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);

function exePath(pid) {
  if (!api || !pid) return '';
  const h = api.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
  if (!h) return '';
  try {
    const buf = new Uint16Array(1024);
    const size = [1024];
    return api.QueryFullProcessImageNameW(h, 0, buf, size) ? u16(buf, size[0]) : '';
  } finally {
    api.CloseHandle(h);
  }
}

function windowTitle(h) {
  const buf = new Uint16Array(512);
  const n = api.GetWindowTextW(h, buf, 512);
  return n > 0 ? u16(buf, n) : '';
}

/** the app in front: { exe: 'VALORANT-Win64-Shipping.exe', path, title, pid, rect } (physical pixels) */
function foregroundApp() {
  if (!api) return null;
  const h = api.GetForegroundWindow();
  if (!h) return null;
  const pid = [0];
  api.GetWindowThreadProcessId(h, pid);
  const path = exePath(pid[0]);
  const r = {};
  const ok = api.DwmRect(h, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) === 0 || api.GetWindowRect(h, r);
  return {
    pid: pid[0], path, exe: baseName(path), title: windowTitle(h),
    rect: ok ? { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } : null,
  };
}

/** running processes: [{ pid, parent, exe }] */
function processes() {
  if (!api) return [];
  const snap = api.CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
  if (!snap) return [];
  const out = [];
  try {
    const e = { dwSize: koffi_sizeof() };
    let ok = api.Process32FirstW(snap, e);
    while (ok) {
      out.push({ pid: e.th32ProcessID, parent: e.th32ParentProcessID, exe: e.szExeFile });
      ok = api.Process32NextW(snap, e);
    }
  } finally {
    api.CloseHandle(snap);
  }
  return out;
}
function koffi_sizeof() {
  return require('koffi').sizeof(api.PE);
}

/** visible app windows with a title, front to back: [{ pid, exe, title, rect }] */
function appWindows() {
  if (!api) return [];
  const out = [];
  const pid = [0];
  let h = api.GetTopWindow(null);
  for (let n = 0; h && n < 2000; n++, h = api.GetWindow(h, GW_HWNDNEXT)) {
    if (!api.IsWindowVisible(h)) continue;
    const ex = api.GetWindowLongW(h, GWL_EXSTYLE);
    if (ex & (WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT)) continue;
    if (!api.GetWindowTextLengthW(h)) continue;
    const cloaked = [0];
    if (api.DwmInt(h, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0]) continue;
    api.GetWindowThreadProcessId(h, pid);
    if (pid[0] === process.pid) continue;
    const r = {};
    if (api.DwmRect(h, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) !== 0 && !api.GetWindowRect(h, r)) continue;
    const path = exePath(pid[0]);
    out.push({ pid: pid[0], exe: baseName(path), path, title: windowTitle(h), minimized: api.IsIconic(h),
      rect: { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } });
  }
  return out;
}

module.exports = { available: !!api, windowRects, cursorPos, setCursorPos, wheel, foregroundApp, processes, appWindows, exePath };
