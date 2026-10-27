// End-to-end run of murmurcut on a talking clip plus a screen recording: transcribe, use the real script, drop the
// photo b-roll, add the recording as a clip split to match each step, cut pauses, export offline.
// Usage: node e2e.mjs <face video> <screen video> <script.txt> <outDir>
// Splits: "t:clipFrom-clipTo,..." in the SPLITS env var, e.g. "0:0-2.4,5.5:0.4-2.4"
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [face, screen, scriptFile, outDir] = process.argv.slice(2);
const pieces = (process.env.SPLITS ?? '').split(',').filter(Boolean).map(p => {
  const [t, r] = p.split(':');
  const [a, b] = r.split('-').map(Number);
  return { t: +t, from: a, to: b };
});
const shots = path.join(outDir, 'shots');
fs.mkdirSync(shots, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0;
const errors = [];

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1440,960', '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = (await browser.pages())[0];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => m.type() === 'error' && errors.push(`console: ${m.text()}`));
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.resolve(outDir) });
const status = () => page.$eval('#status', e => e.textContent.trim());
const shot = name => page.screenshot({ path: path.join(shots, `${String(++n).padStart(2, '0')}-${name}.png`) });
async function waitStatus(re, minutes) {
  const end = Date.now() + minutes * 60e3;
  let last = '';
  while (Date.now() < end) {
    const s = await status();
    if (s !== last) console.log('  status:', (last = s));
    if (re.test(s)) return s;
    if (/failed|can't|couldn't|not a video/i.test(s)) throw new Error(s);
    await sleep(1500);
  }
  throw new Error(`timed out waiting for ${re}; last: ${last}`);
}
const setValue = (handle, v) => handle.evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('change')); }, String(v));

await page.goto('http://localhost:8765/', { waitUntil: 'networkidle0' });
await (await page.$('#file')).uploadFile(path.resolve(face));
await waitStatus(/generate captions/i, 2);
await page.select('#lang', 'hindi');
await page.select('#capLang', 'english');
await page.select('#model', 'Xenova/whisper-small');
console.log('transcribing…');
await page.click('#transcribe');
await waitStatus(/ready\. Play it, then export/i, 30);
await shot('transcribed');

// 1. the real script
await page.$eval('#fixWords', d => (d.open = true));
await page.$eval('#script', (e, v) => (e.value = v), fs.readFileSync(scriptFile, 'utf8'));
await page.click('#applyScript');
await waitStatus(/Captions now use your script/i, 1);
await shot('script');

// 2. no photo b-roll: the screen recording is the visual
await page.click('#t-broll');
for (;;) {
  const del = await page.$$('#brolls li:not(.clip) .actions button:nth-child(3)');
  if (!del.length) break;
  await del[0].click();
}

// 3. the screen recording, split to match each step
await (await page.$('#clipFile')).uploadFile(path.resolve(screen));
await waitStatus(/^Added /, 1);
// split everything first (each split cuts the last piece), then give each piece its part of the recording
for (const p of pieces.filter(p => p.t > 0)) {
  await page.$eval('#video', (v, t) => (v.currentTime = t), p.t);
  await sleep(300);
  await (await (await page.$$('#brolls li.clip')).at(-1).$('.actions button')).click();
}
for (const [k, p] of pieces.entries()) {
  // every change re-renders the list, so look the inputs up again each time
  const nums = () => page.$$(`#brolls li.clip:nth-of-type(${k + 1}) input[type=number]`);
  await setValue((await nums())[2], p.from);
  await setValue((await nums())[3], p.to);
}
const plan = await page.$$eval('#brolls li.clip', lis => lis.map(li => [...li.querySelectorAll('input[type=number]')].map(i => i.value).join(' ')));
console.log('clip pieces (shows from, until, clip from, clip to):\n  ' + plan.join('\n  '));
await page.$eval('#video', v => (v.currentTime = 9));
await sleep(800);
await shot('split');

// 4. cut long pauses; sound settings stay on their defaults (noise reduction and levelling on)
await page.click('#t-cuts');
if (!(await page.$eval('#silences', e => e.checked))) await page.click('#silences');
await shot('cuts');

console.log('exporting…');
const before = new Set(fs.readdirSync(outDir));
const t0 = Date.now();
await page.click('#export');
await waitStatus(/Export finished/i, 40);
let out;
for (let end = Date.now() + 60e3; Date.now() < end && !out; await sleep(1000))
  out = fs.readdirSync(outDir).find(f => !before.has(f) && /murmurcut\.mp4$/.test(f));
if (!out) throw new Error('export did not download');
console.log(`saved ${path.join(outDir, out)} after ${Math.round((Date.now() - t0) / 1000)} s`);
await shot('exported');
console.log(errors.length ? `PAGE ERRORS:\n  ${errors.join('\n  ')}` : 'no page errors');
await browser.close();
