// Small stroke icons (24px grid), shared by the UI pages.
(function () {
  const s = (body) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  window.ICONS = {
    pen: s('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    line: s('<path d="M5 19 19 5"/>'),
    arrow: s('<path d="M5 19 19 5"/><path d="M9 5h10v10"/>'),
    rect: s('<rect x="4" y="5" width="16" height="14" rx="1.5"/>'),
    ellipse: s('<ellipse cx="12" cy="12" rx="9" ry="7"/>'),
    marker: s('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
    text: s('<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>'),
    blur: '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="3.9" y="3.9" width="16.2" height="16.2" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><g fill="currentColor"><rect x="7" y="7" width="3.4" height="3.4"/><rect x="13.6" y="7" width="3.4" height="3.4"/><rect x="10.3" y="10.3" width="3.4" height="3.4"/><rect x="7" y="13.6" width="3.4" height="3.4"/><rect x="13.6" y="13.6" width="3.4" height="3.4"/></g></svg>',
    step: s('<circle cx="12" cy="12" r="9"/><path d="M10.5 9 12.5 7.5V16.5"/>'),
    undo: s('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    redo: s('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
    upload: s('<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M20 16.6A4.5 4.5 0 0 0 17.5 8h-.3"/><path d="M4 16.3A5 5 0 0 1 7 8"/><path d="M8 20h8"/>'),
    share: s('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4"/><path d="m15.4 6.5-6.8 4"/>'),
    search: s('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
    print: s('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>'),
    copy: s('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>'),
    save: s('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
    close: s('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    video: s('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/>'),
    gif: '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="1.5" y="5" width="21" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><text x="12" y="15.6" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="8.5" font-weight="800" fill="currentColor">GIF</text></svg>',
    record: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="7" fill="currentColor"/></svg>',
    pause: s('<path d="M9 5v14"/><path d="M15 5v14"/>'),
    play: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M7 4.5v15l12.5-7.5Z" fill="currentColor"/></svg>',
    stop: '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/></svg>',
    folder: s('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
    link: s('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L12 5.6"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>'),
    scanText: s('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8h8"/><path d="M7 12h10"/><path d="M7 16h6"/>'),
    sparkles: s('<path d="M11 3.5l1.7 5 5 1.8-5 1.7-1.7 5-1.8-5-5-1.7 5-1.8Z"/><path d="M19 3v4"/><path d="M21 5h-4"/><path d="M18 17v3"/><path d="M19.5 18.5h-3"/>'),
    scroll: s('<rect x="5" y="2" width="14" height="20" rx="2.5"/><path d="M12 7v8"/><path d="m8.5 11.5 3.5 3.5 3.5-3.5"/>'),
    trash: s('<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>'),
    external: s('<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>'),
    gear: s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'),
  };
})();
