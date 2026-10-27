// murmurcut "captions on green" run: transcribe, write lines.json, wait for fixes.json ({"<line index>": "new text"}),
// apply the fixes, set caption position, export captions on green. No cuts, so timing matches the source clip.
// Usage: node green.mjs <video> <outDir> <captionPos> [spokenLang=hindi] [captionLang=english]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [video, outDir, pos = '38', lang = 'hindi', capLang = 'english'] = process.argv.slice(2);
const shots = path.join(outDir, 'shots');
fs.mkdirSync(shots, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0;

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1440,960', '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = (await browser.pages())[0];
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
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${re}; last: ${last}`);
}

await page.goto('http://localhost:8765/', { waitUntil: 'networkidle0' });
await (await page.$('#file')).uploadFile(path.resolve(video));
await waitStatus(/generate captions/i, 2);
await page.select('#lang', lang);
await page.select('#capLang', capLang);
await page.select('#model', 'Xenova/whisper-small');
console.log('transcribing…');
await page.click('#transcribe');
await waitStatus(/ready\. Play it, then export/i, 30);

// captions list: one <input> per line, in order
const lineTexts = await page.$$eval('#tab-captions input:not([type])', els => els.map(e => e.value));
const lineTimes = await page.$$eval('#tab-captions input:not([type])', els =>
  els.map(e => e.closest('*:has(> input)')?.parentElement?.textContent.match(/\d+:\d\d/)?.[0] ?? ''));
fs.writeFileSync(path.join(outDir, 'lines.json'), JSON.stringify(lineTexts.map((t, i) => ({ i, at: lineTimes[i], t })), null, 1));
console.log(`wrote lines.json (${lineTexts.length} lines); waiting for fixes.json…`);
const fixesPath = path.join(outDir, 'fixes.json');
for (let end = Date.now() + 20 * 60e3; !fs.existsSync(fixesPath); await sleep(2000)) if (Date.now() > end) throw new Error('no fixes.json');
const fixes = JSON.parse(fs.readFileSync(fixesPath, 'utf8'));
const inputs = await page.$$('#tab-captions input:not([type])');
for (const [i, text] of Object.entries(fixes)) {
  await inputs[+i].evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('change')); }, text);
}
console.log('applied', Object.keys(fixes).length, 'fixes');

await page.click('#t-style');
await page.$eval('#pos', (e, v) => { e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); }, pos);
await page.$eval('#zoom', e => { if (e.checked) e.click(); }); // the composite has its own cuts; no punch-in on a green screen
await page.click('#t-captions');
await shot('fixed');

console.log('exporting captions on green…');
const before = new Set(fs.readdirSync(outDir));
await page.click('#exportGreen');
await waitStatus(/Export finished/i, 10);
let out;
for (let end = Date.now() + 60e3; Date.now() < end && !out; await sleep(1000))
  out = fs.readdirSync(outDir).find(f => !before.has(f) && /captions-green\.(mp4|webm)$/.test(f));
if (!out) throw new Error('export did not download');
console.log('saved', path.join(outDir, out));
await browser.close();
