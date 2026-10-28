// Check the phone preview shows the <video> itself under the canvas (app.js useLive), and that a zoom scales it.
// Usage: node live-check.mjs <url> <portrait video> <outDir>
import puppeteer, { KnownDevices } from 'puppeteer-core';
import path from 'node:path';

const [url, video, outDir] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.emulate(KnownDevices['iPhone 15 Pro']);
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto(url);
await (await page.$('#file')).uploadFile(video);
await page.waitForFunction(() => !document.getElementById('canvas').hidden && document.getElementById('video').readyState >= 2);
await page.evaluate(() => document.getElementById('video').play());
await new Promise(r => setTimeout(r, 1500));
const box = sel => page.$eval(sel, e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); });
const info = await page.evaluate(() => ({ live: !document.getElementById('live').classList.contains('source'), canvas: [canvas.width, canvas.height] }));
console.log('live', info.live, 'canvas px', info.canvas, 'video box', await box('#live'), 'viewport', await box('.viewport'));
await page.screenshot({ path: path.join(outDir, 'live.png') });
await page.evaluate(() => { document.querySelector('input[name="ratio"][value="1:1"]').click(); });
await new Promise(r => setTimeout(r, 500));
console.log('1:1 live', await page.evaluate(() => !document.getElementById('live').classList.contains('source')));
await page.screenshot({ path: path.join(outDir, 'square.png') });
await browser.close();
