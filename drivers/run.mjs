// Drive murmurcut (served at http://localhost:8765) in a visible Chrome window: import a clip, caption it,
// find b-roll, cut fillers and pauses, export. Screenshots of each stage go to <outDir>/shots.
// Usage: node run.mjs <video> <outDir> [spokenLang=hindi] [captionLang=english]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [video, outDir, lang = 'hindi', capLang = 'english'] = process.argv.slice(2);
const shots = path.join(outDir, 'shots');
fs.mkdirSync(shots, { recursive: true });
let n = 0;

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1440,960', '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = (await browser.pages())[0];
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.resolve(outDir), eventsEnabled: true });

const status = () => page.$eval('#status', e => e.textContent.trim());
const shot = async name => page.screenshot({ path: path.join(shots, `${String(++n).padStart(2, '0')}-${name}.png`) });
async function waitStatus(re, minutes) {
  const end = Date.now() + minutes * 60e3;
  let last = '';
  while (Date.now() < end) {
    const s = await status();
    if (s !== last) console.log('  status:', (last = s));
    if (re.test(s)) return s;
    if (/failed|can't|couldn't|not a video/i.test(s)) throw new Error(s);
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for ${re}; last status: ${last}`);
}

await page.goto('http://localhost:8765/', { waitUntil: 'networkidle0' });
await shot('opened');

await (await page.$('#file')).uploadFile(path.resolve(video));
await waitStatus(/generate captions/i, 2);
await page.select('#lang', lang);
await page.select('#capLang', capLang);
await page.select('#model', 'Xenova/whisper-small');
await shot('imported');

console.log('transcribing…');
await page.click('#transcribe');
await waitStatus(/ready\. Play it, then export/i, 30);
await shot('captions');

await page.click('#t-broll');
await shot('broll');
await page.click('#t-cuts');
for (const id of ['#fillers', '#silences']) if (!(await page.$eval(id, e => e.checked))) await page.click(id);
await shot('cuts');
await page.click('#t-captions');
await shot('transcript');

console.log('exporting…');
const before = new Set(fs.readdirSync(outDir));
await page.click('#export');
await waitStatus(/Export finished/i, 10);
await shot('exported');
// wait for the download to land on disk
const end = Date.now() + 60e3;
let out;
while (Date.now() < end && !out) {
  out = fs.readdirSync(outDir).find(f => !before.has(f) && /murmurcut\.(mp4|webm)$/.test(f));
  await new Promise(r => setTimeout(r, 1000));
}
if (!out) throw new Error('export did not download');
console.log('saved', path.join(outDir, out));
await browser.close();
