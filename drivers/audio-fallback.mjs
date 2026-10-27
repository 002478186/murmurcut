// Forces the WebCodecs fallback (decodeAudioData rejects), then checks the 16 kHz audio sent to Whisper.
// Usage: node repro2.mjs <url> <video>
import puppeteer from 'puppeteer-core';
const [url, vid] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
const p = await b.newPage();
p.on('pageerror', e => console.log('pageerror:', e.message));
await p.evaluateOnNewDocument(() => {
  AudioContext.prototype.decodeAudioData = () => Promise.reject(new DOMException('forced', 'EncodingError'));
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, t) { if (m?.audio) window.__len = m.audio.length; return post.call(this, m, t); };
});
await p.goto(url, { waitUntil: 'networkidle0' });
await (await p.$('#file')).uploadFile(vid);
await p.waitForFunction(() => /generate captions/i.test(document.querySelector('#status').textContent), { timeout: 60000 });
const dur = await p.$eval('video', v => v.duration);
await p.click('#transcribe');
await p.waitForFunction(() => window.__len || /couldn't/i.test(document.querySelector('#status').textContent), { timeout: 120000 });
console.log('status:', await p.$eval('#status', e => e.textContent));
const len = await p.evaluate(() => window.__len);
console.log('video', dur.toFixed(2), 's; audio', (len / 16000).toFixed(2), 's');
await b.close();
