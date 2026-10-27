// Render murmurcut captions (its overlay.html) to a transparent video for ffmpeg to lay over an edit.
// Usage: node overlay.mjs <pieces.json> <duration s> <out.mov> [preset=spotlight] [fps=30]
// pieces.json: [{script, words: [{text, start, end}]}] on the final timeline. Identical frames are written once.
import puppeteer from 'puppeteer-core';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [piecesPath, duration, out, preset = 'spotlight', fps = '30'] = process.argv.slice(2);
const ROOT = path.resolve(import.meta.dirname, '..'), PORT = 8766;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmcap-'));

const server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage();
  for (let i = 0; ; i++) {  // the server takes a moment to start
    try { await page.goto(`http://127.0.0.1:${PORT}/overlay.html`, { waitUntil: 'networkidle0' }); break; } catch (e) { if (i > 20) throw e; await new Promise(r => setTimeout(r, 300)); }
  }
  await page.waitForFunction(() => window.mm);
  const n = await page.evaluate(o => window.mm.setup(o), { pieces: JSON.parse(fs.readFileSync(piecesPath, 'utf8')), preset });
  console.log(`${n} caption lines`);

  const blank = path.join(dir, 'blank.png');
  fs.writeFileSync(blank, Buffer.from(await page.evaluate(() => {
    const c = document.getElementById('c');
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }).then(u => u.split(',')[1]), 'base64'));

  const total = Math.round(+duration * +fps), runs = [];
  let prev = null, files = 0;
  for (let f = 0; f < total; f++) {
    const url = await page.evaluate(t => window.mm.frame(t), f / +fps);
    if (url === prev) { runs.at(-1).frames++; continue; }
    prev = url;
    let file = blank;
    if (url) fs.writeFileSync((file = path.join(dir, `${String(++files).padStart(5, '0')}.png`)), Buffer.from(url.split(',')[1], 'base64'));
    runs.push({ file, frames: 1 });
  }
  const list = path.join(dir, 'list.txt');
  // concat demuxer ignores the last duration, so the last file is listed twice
  fs.writeFileSync(list, runs.map(r => `file '${r.file.replace(/\\/g, '/')}'\nduration ${r.frames / +fps}\n`).join('') + `file '${runs.at(-1).file.replace(/\\/g, '/')}'\n`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-r', fps, '-t', duration,
    '-c:v', 'qtrle', '-pix_fmt', 'argb', out]);
  console.log(`wrote ${out} (${files} distinct frames)`);
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
