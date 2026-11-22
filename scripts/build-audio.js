#!/usr/bin/env node
// Builds src/bin/glimpse-audio.exe from src/native/audio.cs with the .NET Framework C# compiler.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

if (!fs.existsSync(csc)) {
  console.error('csc.exe not found at ' + csc + ' (.NET Framework 4.x is required)');
  process.exit(1);
}

fs.mkdirSync(path.join(root, 'src', 'bin'), { recursive: true });

const args = [
  '/nologo',
  '/target:exe',
  '/platform:x64',
  '/optimize+',
  // csc mis-parses forward slashes inside paths (they look like options), so use native separators
  '/out:' + path.join('src', 'bin', 'glimpse-audio.exe'),
  path.join('src', 'native', 'audio.cs'),
];

try {
  const out = execFileSync(csc, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (out.trim()) process.stdout.write(out);
  console.log('built src/bin/glimpse-audio.exe');
} catch (e) {
  if (e.stdout) process.stdout.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  console.error('glimpse-audio build failed');
  process.exit(typeof e.status === 'number' && e.status !== 0 ? e.status : 1);
}
