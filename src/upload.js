'use strict';
const fs = require('fs');
const path = require('path');

// Anonymous hosts, no API key needed.
// catbox.moe keeps files permanently (max 200 MB); litterbox deletes them after the chosen time (max 1 GB).
const HOSTS = {
  catbox: { url: 'https://catbox.moe/user/api.php' },
  'litterbox-1h': { url: 'https://litterbox.catbox.moe/resources/internals/api.php', time: '1h' },
  'litterbox-12h': { url: 'https://litterbox.catbox.moe/resources/internals/api.php', time: '12h' },
  'litterbox-24h': { url: 'https://litterbox.catbox.moe/resources/internals/api.php', time: '24h' },
  'litterbox-72h': { url: 'https://litterbox.catbox.moe/resources/internals/api.php', time: '72h' },
};

async function upload(filePath, hostKey = 'catbox') {
  const host = HOSTS[hostKey] || HOSTS.catbox;
  const data = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  if (host.time) form.append('time', host.time);
  form.append('fileToUpload', new Blob([data]), path.basename(filePath).replace(/\s+/g, '_'));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(host.url, { method: 'POST', body: form, signal: controller.signal });
    const text = (await res.text()).trim();
    if (!res.ok || !/^https?:\/\//i.test(text)) {
      throw new Error(text ? text.slice(0, 200) : `Upload failed (HTTP ${res.status})`);
    }
    return text;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Upload timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { upload, HOSTS };
