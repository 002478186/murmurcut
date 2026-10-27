import { toWords, groupWords, editLine, cutRanges, skipCut, toSrt, planBroll, toSegments, pickKeyword, topicOf, isAbstract, cleanQuery, dropCommon, domainOf, alignScript, replaceText, escapeRe, toOutput, toSource, splitClip, clipTime } from './captions.js';
import { PRESETS, drawCaption, drawBroll, drawCover, drawBlurred, drawSpeaker, drawAvatar } from './render.js';
import { cutAudio, levelAudio, resample, envelope, placeDub, bedMusic, toWav } from './audio.js';
import { AVATARS, W3D, H3D, prepare3d, render3d } from './avatar3d.js';
import { parseCommand, CHAT_EXAMPLES } from './chat.js';

const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('canvas'), ctx = canvas.getContext('2d');
const newWorker = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const worker = newWorker();
const phone = /iPhone|iPod/.test(navigator.userAgent);
const PX = 60; // timeline pixels per second
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const SPLIT = 0.45; // share of the frame the b-roll takes on a split screen; the speaker gets the rest
const MUXER = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/+esm';
const MP4BOX = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/+esm';
const RNNOISE = 'https://cdn.jsdelivr.net/npm/@shiguredo/rnnoise-wasm@2025.1.5/dist/rnnoise.js';
const FPS = 30, RATE = 48000;

let zooms = []; // manual zooms: { start, end, amount }
let heard = []; // Whisper's words as heard, kept so "Use my script" can be re-applied after edits
let green = false, file, topic = null, topicInfo = null, genericPool = null, lines = [], brolls = [], cuts = [], preset = 'spotlight', exporting = false, audioDest;

// A message ending in "…" means work is under way: the preview shows it with a spinner until a final message replaces it.
const status = text => {
  const was = !$('working').hidden, now = text.endsWith('…');
  $('status').textContent = $('workingText').textContent = text;
  $('working').hidden = !now;
  if (was && !now) {
    $('status').classList.add('done');
    setTimeout(() => $('status').classList.remove('done'), 5000);
  }
};
const busy = on => { try { on ? sessionStorage.setItem('busy', '1') : sessionStorage.removeItem('busy'); } catch {} };
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const words = () => lines.flatMap(l => l.words);
const settings = () => ({ size: +$('size').value, pos: +$('pos').value, upper: $('upper').checked });
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const seek = t => (video.currentTime = Math.max(0, Math.min(t, video.duration || 0)));

// Canvas text does not trigger webfont loading, so ask for every face up front.
const fontsReady = Promise.all(['400 20px Anton', '700 20px "Bricolage Grotesque"', '800 20px "Bricolage Grotesque"', 'italic 400 20px "Instrument Serif"', '700 20px "Noto Sans Devanagari"']
  .map(f => document.fonts.load(f).catch(() => {})));

function download(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const baseName = () => file.name.replace(/\.[^.]+$/, '');
// Everything that needs captions first.
const enableEditing = on => ['export', 'exportGreen', 'srt', 'addBroll', 'researchAll', 'replaceBtn', 'applyScript', 'makeDub'].forEach(id => ($(id).disabled = !on));

// --- tabs ---
const tabs = [...document.querySelectorAll('[role="tab"]')];
function showTab(name) {
  tabs.forEach(t => {
    const on = t.id === `t-${name}`;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  });
}
tabs.forEach(t => (t.onclick = () => showTab(t.id.slice(2))));
$('t-captions').closest('[role="tablist"]').addEventListener('keydown', e => {
  const i = tabs.indexOf(document.activeElement);
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (i < 0 || !step) return;
  e.preventDefault();
  const next = tabs[(i + step + tabs.length) % tabs.length];
  showTab(next.id.slice(2));
  next.focus();
});

// --- import ---
function load(f) {
  if (exporting) return status('Wait for the export to finish first.');
  if (!/^(video|audio)\//.test(f?.type) && !/\.(mov|mp4|m4v|webm|wav|mp3|m4a)$/i.test(f?.name)) return status('That file is not a video. Choose an MP4, MOV or WebM file.');
  file = f;
  lines = [];
  brolls = [];
  cuts = [];
  renderAll();
  enableEditing(false);
  heard = [];
  zooms = [];
  dubTrack = avatarEnv = null;
  setTrack('dub', null);
  $('dubLang').value = '';
  undoStack.length = 0;
  lastState = null;
  $('undo').disabled = true;
  $('fileName').textContent = f.name;
  $('fileName').hidden = false;
  status(`Opening ${f.name}…`);
  video.src = URL.createObjectURL(f);
  video.load(); // iPhone Safari waits for this before reading the video
}
$('file').onchange = e => load(e.target.files[0]);
const drop = $('drop');
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); load(e.dataTransfer.files[0]); };

video.onloadedmetadata = () => {
  sizeCanvas();
  canvas.hidden = $('changeVideo').hidden = false;
  drop.hidden = true;
  for (const id of ['transcribe', 'play', 'addClip', 'addZoom', 'chatInput', 'chatSend']) $(id).disabled = false;
  chatHints.forEach(b => (b.disabled = false));
  lastState = snapshot();
  renderTimeline();
  seek(0); // decodes the first frame so the preview is not black
  status('Choose the spoken language, then generate captions.');
};
video.onerror = () => status("This browser can't play that video. Try an MP4 (H.264) or WebM.");

// --- language and model ---
function syncLang() {
  const foreign = $('lang').value !== 'english';
  $('capLang').disabled = !foreign;
  if (!foreign) $('capLang').value = 'spoken';
  const english = foreign && $('capLang').value === 'english';
  // Whisper small loops on Hindi transcription but translates it well; base gives romanised Hinglish.
  $('model').value = english ? 'Xenova/whisper-small' : 'Xenova/whisper-base';
  $('langHint').textContent = !foreign ? ''
    : english ? 'Captions are translated to English. B-roll is picked from what you mean, whatever language you speak.'
    : 'Hindi usually comes out romanised, as Hinglish in Latin letters. For the cleanest captions, choose English.';
}
$('lang').onchange = $('capLang').onchange = syncLang;
syncLang();
try { if (sessionStorage.getItem('busy')) { busy(false); status('Your phone ran out of memory making captions, so the page restarted. Try a shorter clip, or film in 1080p instead of 4K.'); } } catch {}

// --- transcribe ---
$('transcribe').onclick = async () => {
  $('transcribe').disabled = true;
  busy(true);
  // The iPhone app captions with Apple's on-device speech recognition instead (ios/Sources/Captions.swift); it can't translate.
  if (window.murmurcutApp && !($('lang').value !== 'english' && $('capLang').value === 'english')) {
    status('Making captions with Apple speech recognition. The first time, it downloads the language…');
    $('progress').hidden = false;
    $('progress').removeAttribute('value');
    const ext = file.name.split('.').pop() || 'mov';
    const d = await fetch(`native/transcribe?lang=${$('lang').value}&ext=${encodeURIComponent(ext)}`, { method: 'POST', body: file })
      .then(r => r.json()).catch(e => ({ type: 'error', message: e.message }));
    if (d.type === 'done') return worker.onmessage({ data: d });
    status(`Apple captions didn't work (${d.message}), so using the built-in model…`);
    await new Promise(r => setTimeout(r, 2500));
  }
  status('Reading the audio…');
  let audio;
  try {
    [audio] = await decodeAudio(16000); // Whisper expects 16 kHz mono
  } catch (e) {
    $('transcribe').disabled = false;
    busy(false);
    return status(`Couldn't read the audio track of this video (${e.message || e.name}).`);
  }
  status('Downloading the speech model. This only happens the first time…');
  $('progress').hidden = false;
  $('progress').removeAttribute('value');
  const language = $('lang').value;
  const msg = { language, model: $('model').value, translate: language !== 'english' && $('capLang').value === 'english' };
  if (phone) return worker.onmessage({ data: await transcribeInPieces(audio, msg) });
  worker.postMessage({ audio, ...msg }, [audio.buffer]);
};

// iPhone: each 30 s piece runs in a fresh worker that is then closed, so memory stays at one piece's worth
// however long the video is (Safari reloads the page once a tab passes its memory limit).
// shortcut: a word spoken across a piece boundary can be cut in two; fine for captions you can edit.
async function transcribeInPieces(audio, msg) {
  const P = 16000 * 30, n = Math.ceil(audio.length / P);
  const out = { type: 'done', chunks: [], segments: msg.translate || msg.language === 'english' ? null : [] };
  for (let k = 0; k < n; k++) {
    const piece = audio.slice(k * P, (k + 1) * P), w = newWorker(), at = t => (t == null ? t : t + k * 30);
    const d = await new Promise(res => {
      w.onmessage = ({ data }) => (data.type === 'progress' ? ($('progress').value = data.progress / 100) : ['done', 'error'].includes(data.type) && res(data));
      w.onerror = e => res({ type: 'error', message: e.message || 'The AI worker stopped.' });
      w.postMessage({ audio: piece, ...msg }, [piece.buffer]);
      status(`Making captions on your phone, part ${k + 1} of ${n}. Keep this screen open…`);
    });
    w.terminate();
    if (d.type === 'error') return d;
    out.chunks.push(...d.chunks.map(c => ({ ...c, timestamp: c.timestamp.map(at) })));
    out.segments?.push(...d.segments.map(s => ({ ...s, start: at(s.start), end: at(s.end) })));
  }
  return out;
}

// The video's sound as one or two channels at `rate` Hz.
async function decodeAudio(rate) {
  const ac = new AudioContext({ sampleRate: rate });
  try {
    const b = await ac.decodeAudioData(await file.arrayBuffer());
    return Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, i) => b.getChannelData(i));
  } catch (e) {
    // iPhone Safari's decodeAudioData refuses many iPhone videos, so pull the AAC track out and decode it with WebCodecs.
    if (!self.AudioDecoder) throw e;
    const { pcm, from } = await demuxAac(await file.arrayBuffer());
    return pcm.map(c => resample(c, from, rate));
  } finally {
    ac.close();
  }
}

// shortcut: holds the whole file in memory like decodeAudioData does; stream it in slices if long 4K clips crash.
async function demuxAac(data) {
  const { default: MP4Box } = await import(MP4BOX);
  const mp4 = MP4Box.createFile(), samples = [];
  let track;
  mp4.onError = e => { throw new Error(e); };
  mp4.onReady = info => (track = info.audioTracks.find(t => t.codec.startsWith('mp4a')));
  mp4.onSamples = (id, user, s) => samples.push(...s);
  data.fileStart = 0;
  mp4.appendBuffer(data);
  mp4.flush();
  if (!track) throw new Error('no AAC sound track found');
  mp4.setExtractionOptions(track.id);
  mp4.start(); // all the data is already in, so every sample arrives before this returns
  const n = Math.min(2, track.audio.channel_count), parts = [[], []];
  const dec = new AudioDecoder({
    output: a => {
      for (let c = 0; c < n; c++) {
        const p = new Float32Array(a.numberOfFrames);
        a.copyTo(p, { planeIndex: c, format: 'f32-planar' });
        parts[c].push(p);
      }
      a.close();
    },
    error: () => {}, // flush() rejects with the same error
  });
  const { sample_rate: hz, channel_count: chs } = track.audio;
  // mp4box can't read iPhone .MOV sound settings (QuickTime v1), but iPhones record AAC-LC, whose 2-byte config we can write
  const esds = mp4.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0].esds, f = AAC_RATES.indexOf(hz);
  dec.configure({
    codec: esds ? track.codec : 'mp4a.40.2', sampleRate: hz, numberOfChannels: chs,
    description: esds ? esds.esd.descs[0].descs[0].data : new Uint8Array([(2 << 3) | (f >> 1), ((f & 1) << 7) | (chs << 3)]),
  });
  for (const s of samples) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: (s.cts * 1e6) / s.timescale, data: s.data }));
  await dec.flush();
  dec.close();
  const join = ps => { const out = new Float32Array(ps.reduce((k, p) => k + p.length, 0)); let o = 0; for (const p of ps) out.set(p, (o += p.length) - p.length); return out; };
  return { pcm: parts.slice(0, n).map(join), from: hz };
}
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// Ranking and search-writing requests share the worker with transcription; replies are matched by id.
const pending = new Map();
let askId = 0;
const askWorker = msg => new Promise((resolve, reject) => {
  const id = ++askId;
  pending.set(id, d => (d.error ? reject(new Error(d.error)) : resolve(d)));
  worker.postMessage({ ...msg, id });
});
const rankTexts = (queries, texts) => askWorker({ type: 'rank', queries, texts }).then(d => d.scores);

worker.onerror = e => {
  const error = e.message || 'The AI worker stopped. Reload the page and try again.';
  pending.forEach(reply => reply({ error }));
  pending.clear();
  worker.onmessage({ data: { type: 'error', message: error } });
};
worker.onmessage = ({ data }) => {
  if (['ranked', 'suggested', 'dubbed', 'spoken'].includes(data.type)) { pending.get(data.id)?.(data); pending.delete(data.id); return; }
  if (data.type === 'progress') { $('progress').value = data.progress / 100; return; }
  if (data.type === 'status') { $('progress').removeAttribute('value'); return status(data.text); }
  $('progress').hidden = true;
  $('transcribe').disabled = false;
  busy(false);
  if (data.type === 'error') return status(`Transcription failed: ${data.message}`);
  const ws = toWords(data.chunks);
  heard = ws.map(w => ({ ...w }));
  lines = groupWords(ws);
  topic = topicOf(ws);
  brolls = [...brolls.filter(b => b.clip), ...planBroll(data.segments ?? toSegments(ws)).map(b => ({ ...b, planned: b.mode, auto: true, options: [], pick: 0 }))].sort((x, y) => x.start - y.start);
  topicInfo = genericPool = null;
  updateCuts();
  renderAll();
  undoStack.length = 0;
  lastState = snapshot();
  $('undo').disabled = true;
  enableEditing(lines.length > 0);
  if (!lines.length) return status('No speech found in this video.');
  status(`${lines.length} caption lines and ${brolls.length} b-roll moments. Finding photos…`);
  searchAll();
};

// --- transcript ---
let lineEls = [];
function renderTranscript() {
  lineEls = lines.map(l => {
    const input = el('input', { value: l.words.map(w => w.text).join(' ') });
    input.setAttribute('aria-label', `Caption at ${fmt(l.start)}`);
    input.onchange = () => { editLine(l, input.value); updateCuts(); renderAll(); };
    const chips = el('div', { className: 'chips' }, ...l.words.map(w => {
      const c = el('button', { type: 'button', className: 'chip' + (w.cut ? ' cut' : ''), textContent: w.text, title: 'Click to cut this word from the video' });
      c.setAttribute('aria-pressed', w.cut);
      c.onclick = () => { w.cut = !w.cut; c.classList.toggle('cut', w.cut); c.setAttribute('aria-pressed', w.cut); updateCuts(); renderTimeline(); commit(); };
      return c;
    }));
    const t = el('button', { className: 't', type: 'button', textContent: fmt(l.start), onclick: () => seek(l.start) });
    t.setAttribute('aria-label', `Jump to ${fmt(l.start)}`);
    return el('li', {}, t, input, chips);
  });
  $('lines').replaceChildren(...lineEls);
}

// --- fixing the words ---
// Whisper mishears names and slang. Replace a word everywhere, or swap in the script that was actually read.
$('replaceBtn').onclick = () => {
  const n = replaceText(lines, $('find').value, $('repl').value);
  if (n) { updateCuts(); renderAll(); commit(); }
  status(n ? `Replaced ${n} time${n > 1 ? 's' : ''}.` : `"${$('find').value.trim()}" isn't in the captions.`);
};
$('applyScript').onclick = () => {
  const aligned = alignScript($('script').value, heard);
  if (!aligned.length) return status('Paste the script you read first, one caption line per line.');
  lines = groupWords(aligned, { maxWords: 6, maxGap: 9 }); // the script's own line breaks decide the lines
  updateCuts();
  renderAll();
  commit();
  status(`Captions now use your script: ${lines.length} lines, timed to your voice.`);
};

// --- second videos ---
// A screen recording or any other clip, laid over the timeline as b-roll. It covers the playhead to the end;
// split it at the playhead to line each part up with what you are saying.
$('addClip').onclick = () => $('clipFile').click();
$('clipFile').onchange = async e => {
  for (const f of e.target.files) await addClip(f).catch(err => status(err.message));
  e.target.value = '';
};
async function addClip(f) {
  if (!f.type.startsWith('video/')) throw new Error(`${f.name} is not a video.`);
  const el = Object.assign(document.createElement('video'), { muted: true, playsInline: true, preload: 'auto', src: URL.createObjectURL(f) });
  await new Promise((res, rej) => {
    el.onloadeddata = res;
    el.onerror = () => rej(new Error(`This browser can't play ${f.name}. Try an MP4 (H.264) or WebM.`));
  });
  const start = Math.min(video.currentTime, Math.max(0, video.duration - 1));
  const b = { start, end: Math.min(video.duration, start + el.duration), mode: 'full', clip: { el, from: 0, to: el.duration, name: f.name }, query: '', label: f.name, options: [], pick: 0 };
  brolls = [...brolls, b].sort((x, y) => x.start - y.start);
  if ($('layout').value === 'full') { $('layout').value = 'split'; onLayout(); }
  renderBrolls();
  renderTimeline();
  commit();
  showTab('broll');
  status(`Added ${f.name} on top of a split screen. Move the playhead and press Split to match each part to what you say.`);
}

// --- b-roll ---
function loadImg(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = 'anonymous'; // keeps the canvas exportable
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('That photo failed to load.'));
    i.src = src;
  });
}

async function usePick(b) {
  // Some hosts fail; walk forward until one loads.
  for (let tries = 0; tries < Math.min(4, b.options.length); tries++) {
    const o = b.options[b.pick];
    try {
      b.img = await loadImg(o.src);
      b.credit = o.credit;
      b.note = '';
      if (o.track) fetch(o.track).catch(() => {}); // Unsplash's API terms ask apps to report each photo they use
      return;
    } catch {
      b.pick = (b.pick + 1) % b.options.length;
    }
  }
  b.img = null;
  b.note = 'None of the photos found would load. Try another search.';
}

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    if (r.status === 429) throw new Error('Too many searches. Wait a minute, then search again.');
    if (r.status < 500 || attempt) throw new Error(`The photo search failed (${r.status}).`);
    await new Promise(res => setTimeout(res, 1500)); // one retry for server hiccups
  }
}

// Wikipedia knows named things (PS5, Mumbai); only free images come back by default.
async function wikiPages(q, limit = 5) {
  const d = await getJson(`https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrlimit=${limit}&prop=pageimages|description&piprop=thumbnail|name&pithumbsize=960&gsrsearch=${encodeURIComponent(q)}`);
  return Object.values(d.query?.pages ?? {}).sort((a, c) => a.index - c.index);
}
const toPhotos = pages => pages.filter(p => p.thumbnail).map(p => ({
  src: p.thumbnail.source,
  about: `${p.title}: ${p.description ?? ''}`,
  credit: `"${p.title}" photo via Wikimedia Commons: https://commons.wikimedia.org/wiki/File:${encodeURIComponent(p.pageimage)}`,
}));
const wikiPhotos = async q => toPhotos(await wikiPages(q));

// Openverse covers everyday things with Creative Commons photos.
async function openversePhotos(q) {
  const d = await getJson(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=10&license_type=commercial,modification&mature=false`);
  return d.results.map(o => ({
    src: o.thumbnail,
    about: `${o.title ?? ''} ${(o.tags ?? []).slice(0, 8).map(t => t.name).join(' ')}`,
    credit: `"${o.title || 'Untitled'}" by ${o.creator || 'unknown'}, ${o.license.toUpperCase()} ${o.license_version ?? ''}, via Openverse: ${o.foreign_landing_url}`,
  }));
}

// What the topic is ("Call of Duty: Modern Warfare 4: 2026 video game") and its domain ("video game"),
// so an ambiguous word like DMZ is read in the video's world, not the dictionary's.
async function loadTopic() {
  if (topicInfo || !topic) return;
  const p = (await wikiPages(topic, 1).catch(() => []))[0];
  const desc = p?.description ?? '';
  topicInfo = { about: p ? `${p.title}: ${desc}` : topic, domain: domainOf(desc) };
  if (topicInfo.domain) genericPool = openversePhotos(topicInfo.domain).then(r => r.map(o => ({ ...o, generic: true })), () => []);
}

const MIN_FIT = 0.3; // below this nothing found fits what was said, so a text card beats a wrong photo

// Optional libraries, unlocked by the user's own free keys.
const keys = () => ({ pexels: $('pexelsKey').value.trim(), unsplash: $('unsplashKey').value.trim() });
async function pexelsPhotos(q, key) {
  const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=10`, { headers: { Authorization: key } });
  if (!r.ok) throw new Error(r.status === 401 ? 'The Pexels key was not accepted. Check it in More photo sources.' : `Pexels search failed (${r.status}).`);
  return (await r.json()).photos.map(p => ({ src: p.src.large, about: p.alt || q, credit: `Photo by ${p.photographer} on Pexels: ${p.url}` }));
}
async function unsplashPhotos(q, key) {
  const auth = `client_id=${encodeURIComponent(key)}`;
  const r = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=10&${auth}`);
  if (!r.ok) throw new Error(r.status === 401 ? 'The Unsplash key was not accepted. Check it in More photo sources.' : `Unsplash search failed (${r.status}).`);
  return (await r.json()).results.map(p => ({
    src: p.urls.regular,
    about: p.alt_description || p.description || q,
    credit: `Photo by ${p.user.name} on Unsplash: ${p.links.html}?utm_source=murmurcut&utm_medium=referral`,
    track: `${p.links.download_location}&${auth}`,
  }));
}

async function search(b) {
  const run = (b.run = (b.run ?? 0) + 1); // a newer search for this row wins
  b.note = 'Searching…';
  renderRow(b);
  await loadTopic();
  const q = b.query;
  // The AI search describes the scene ("skyline mumbai"); the keyword names the thing ("Mumbai"). Both feed the same ranking.
  const ai = b.ai && b.ai !== q.toLowerCase() ? b.ai : null;
  const k = keys();
  const exact = wikiPages(q);
  const results = await Promise.allSettled([
    exact.then(toPhotos),
    topic && !q.includes(topic) && wikiPhotos(`${q} ${topic}`),
    openversePhotos(q),
    ai && openversePhotos(ai),
    k.pexels && pexelsPhotos(ai || q, k.pexels),
    k.unsplash && unsplashPhotos(ai || q, k.unsplash),
    genericPool,
  ].filter(Boolean));
  if (b.run !== run) return;
  const seen = new Set();
  let pool = results.flatMap(r => (r.status === 'fulfilled' ? r.value : [])).filter(o => o.src && !seen.has(o.src) && seen.add(o.src));
  const context = b.context || q;
  try {
    // Score each photo against the sentence, and against the sentence with the keyword hidden plus the topic.
    // The second view is what tells "DMZ, the game mode" apart from "DMZ, the border".
    const masked = `${context.replace(new RegExp(escapeRe(q), 'gi'), 'it')} (${topicInfo?.about ?? ''})`;
    const [plain, hidden] = await rankTexts([context, masked], [...pool.map(o => o.about), topicInfo?.domain || '']);
    const onTopic = topicInfo?.domain && plain.at(-1) > MIN_FIT; // generic topic photos only for sentences about the topic
    pool = pool.map((o, i) => ({ ...o, fit: (plain[i] + hidden[i]) / 2 })).filter(o => onTopic || !o.generic).sort((x, y) => y.fit - x.fit);
  } catch (e) {
    console.warn('Photo ranking unavailable, keeping search order:', e.message);
    pool = pool.filter(o => !o.generic);
  }
  const top = (await exact.catch(() => []))[0];
  const abstract = top && top.title.toLowerCase().includes(q.toLowerCase()) && isAbstract(top.description);
  if (b.run !== run) return;
  b.options = pool;
  b.pick = 0;
  const fits = pool.length && (pool[0].fit ?? 1) >= MIN_FIT;
  if (pool.length) await usePick(b);
  else b.img = null;
  if (b.run !== run) return;
  if (fits && b.img && !abstract) {
    if (b.mode === 'text') b.mode = b.planned ?? 'full';
  } else if (b.auto && !abstract && !/^\p{Lu}|\d/u.test(q) && !results.some(r => r.status === 'rejected')) {
    // A plain word with no fitting photo: better no b-roll here than a text card saying "background".
    brolls = brolls.filter(x => x !== b);
    renderBrolls();
  } else {
    b.mode = 'text';
    const err = results.find(r => r.status === 'rejected')?.reason?.message;
    b.note = abstract ? `${top.title} is ${/^[aeiou]/i.test(top.description) ? 'an' : 'a'} ${top.description[0].toLowerCase() + top.description.slice(1)}, which a photo can't really show, so this is a text card. Pick a photo layout to use the closest photo anyway.`
      : err === 'Failed to fetch' ? 'The photo search is unreachable, so this shows as a text card.'
      : pool.length ? 'No photo fitted what you said, so this shows as a text card. Pick a photo layout to use the closest one anyway.'
      : `No free photos for "${q}", so this shows as a text card. Try another word, or upload your own.`;
  }
  renderRow(b);
  renderTimeline();
}

// The language model reads each b-roll sentence and writes a search for what it shows.
async function writeSearches() {
  status('AI is reading what you said to write photo searches. The first time downloads its model, so this takes a while…');
  $('progress').hidden = false;
  $('progress').removeAttribute('value');
  try {
    await loadTopic();
    const { queries } = await askWorker({ type: 'suggest', domain: topicInfo?.domain || 'general', sentences: brolls.map(b => b.context || b.query) });
    const clean = dropCommon(queries.map(q => cleanQuery(q, topic ?? '')));
    brolls.forEach((b, i) => (b.ai = clean[i] || null));
  } catch (e) {
    status(`AI search is unavailable (${e.message}), so keywords are used instead.`);
  }
  $('progress').hidden = true;
}

async function searchAll() {
  if ($('aiSearch').checked && brolls.some(b => !b.ai && b.context)) await writeSearches();
  for (const b of brolls) if (b.query) await search(b); // one at a time, to stay inside the anonymous rate limits
  const found = brolls.filter(b => b.img && b.mode !== 'text').length;
  const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  status(`${n(lines.length, 'caption line')}, ${n(found, 'b-roll photo')} and ${n(brolls.length - found, 'text card')} ready. Play it, then export.`);
}

const MODE_LABEL = { full: 'Full screen', card: 'Photo card', blur: 'Blurred behind', text: 'Text card' };
let brollEls = [];
// A second-video moment: when it shows, which part of the clip plays, and a split at the playhead.
function clipRow(b) {
  const num = (label, value, set) => {
    const i = el('input', { type: 'number', step: '0.1', min: '0', value: value.toFixed(1) });
    i.onchange = () => { set(+i.value); renderBrolls(); renderTimeline(); };
    return el('label', {}, label, i);
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mode = el('select', {}, ...['full', 'card', 'blur'].map(v => el('option', { value: v, textContent: MODE_LABEL[v], selected: v === b.mode })));
  mode.setAttribute('aria-label', 'How the clip appears');
  mode.onchange = () => { b.mode = mode.value; renderBrolls(); };
  const split = el('button', { type: 'button', className: 'btn ghost', textContent: 'Split at playhead' });
  split.onclick = () => {
    const parts = splitClip(b, video.currentTime);
    if (parts.length < 2) return status('Move the playhead inside this clip, at least 0.1 s from either end, then split.');
    brolls.splice(brolls.indexOf(b), 1, ...parts);
    renderBrolls();
    renderTimeline();
    commit();
  };
  const del = el('button', { type: 'button', className: 'btn ghost', textContent: 'Remove' });
  del.onclick = () => { brolls = brolls.filter(x => x !== b); renderBrolls(); renderTimeline(); commit(); };
  const when = el('button', { type: 'button', className: 't', textContent: `${fmt(b.start)} – ${fmt(b.end)}`, onclick: () => seek(b.start) });
  const max = b.clip.el.duration;
  return el('li', { className: 'clip' },
    el('div', { className: 'thumb clipthumb', textContent: '▶' }),
    el('div', { className: 'stack' },
      el('div', { className: 'meta' }, when, mode),
      el('p', { className: 'hint', textContent: b.clip.name }),
      el('div', { className: 'field-row' },
        num('Shows from (s)', b.start, v => (b.start = clamp(v, 0, b.end - 0.2))),
        num('until (s)', b.end, v => (b.end = clamp(v, b.start + 0.2, video.duration)))),
      el('div', { className: 'field-row' },
        num('Clip from (s)', b.clip.from, v => (b.clip.from = clamp(v, 0, max))),
        num('to (s)', b.clip.to, v => (b.clip.to = clamp(v, 0, max)))),
      el('div', { className: 'actions' }, split, del)));
}

function brollRow(b) {
    if (b.clip) return clipRow(b);
    const thumb = el('img', { className: 'thumb', alt: b.img && b.mode !== 'text' ? `Photo for ${b.query}` : '' });
    if (b.img && b.mode !== 'text') thumb.src = b.img.src;
    const mode = el('select', {}, ...Object.entries(MODE_LABEL).map(([v, t]) => el('option', { value: v, textContent: t, selected: v === b.mode })));
    mode.setAttribute('aria-label', 'How the photo appears');
    mode.onchange = () => { b.mode = mode.value; renderBrolls(); renderTimeline(); };
    const q = el('input', { type: 'text', value: b.query, placeholder: 'What should the photo show?' });
    q.setAttribute('aria-label', 'Photo search');
    q.onchange = () => { b.query = b.label = q.value.trim(); b.ai = null; if (b.query) search(b); }; // a typed search is the user's intent
    const swap = el('button', { type: 'button', className: 'btn ghost', textContent: 'Swap photo', disabled: b.options.length < 2 });
    swap.onclick = async () => { b.pick = (b.pick + 1) % b.options.length; await usePick(b); renderBrolls(); };
    const up = el('input', { type: 'file', accept: 'image/*', hidden: true });
    up.onchange = async () => {
      if (!up.files[0]) return;
      b.img = await loadImg(URL.createObjectURL(up.files[0]));
      b.credit = '';
      b.note = 'Using your photo.';
      if (b.mode === 'text') b.mode = b.planned ?? 'full';
      renderBrolls();
      renderTimeline();
      commit();
    };
    const upBtn = el('button', { type: 'button', className: 'btn ghost', textContent: 'Upload', onclick: () => up.click() });
    const del = el('button', { type: 'button', className: 'btn ghost', textContent: 'Remove' });
    del.onclick = () => { brolls = brolls.filter(x => x !== b); renderBrolls(); renderTimeline(); commit(); };
    const when = el('button', { type: 'button', className: 't', textContent: `${fmt(b.start)} – ${fmt(b.end)}`, onclick: () => seek(b.start) });
    const body = el('div', { className: 'stack' },
      el('div', { className: 'meta' }, when, mode),
      q,
      ...(b.ai ? [el('p', { className: 'hint ai', textContent: `AI also searched for "${b.ai}"` })] : []),
      ...(b.note ? [el('p', { className: 'hint', textContent: b.note })] : []),
      el('div', { className: 'actions' }, swap, upBtn, del, up));
    return el('li', {}, thumb, body);
}
const creditsText = () => [...brolls.filter(b => b.mode !== 'text').map(b => b.credit), music?.credit].filter(Boolean).join('\n');
function renderBrolls() {
  brollEls = brolls.map(brollRow);
  $('brolls').replaceChildren(...brollEls);
  if (!brolls.length && lines.length) $('brolls').append(el('li', { className: 'hint', textContent: 'No b-roll yet. Move the playhead and add one.' }));
  $('credits').value = creditsText();
}
// Background searches redraw only their own row, so a search being typed in another row survives.
function renderRow(b) {
  const i = brolls.indexOf(b);
  if (i < 0 || !brollEls[i]?.isConnected) return renderBrolls();
  brollEls[i].replaceWith((brollEls[i] = brollRow(b)));
  $('credits').value = creditsText();
}

// A photo moment at `at`, searched for `query` or, without one, the keyword of what is being said there.
function addPhoto(at, dur = 2.5, query = '') {
  const t = Math.min(at, Math.max(0, video.duration - 0.5));
  const line = lines.find(l => t >= l.start && t < l.end) ?? lines.find(l => l.start >= t);
  const context = line?.words.map(w => w.text).join(' ');
  query ||= (context && pickKeyword(context)) || '';
  const b = { start: t, end: Math.min(t + dur, video.duration), query, label: query, context, mode: 'full', planned: 'full', options: [], pick: 0 };
  brolls = [...brolls, b].sort((x, y) => x.start - y.start);
  if (query) search(b);
  return b;
}
$('addBroll').onclick = () => {
  addPhoto(video.currentTime);
  renderBrolls();
  renderTimeline();
  commit();
};

$('researchAll').onclick = () => searchAll();

// Per-browser preferences. Storage can be blocked (private windows), which just means nothing is remembered.
for (const id of ['aiSearch', 'pexelsKey', 'unsplashKey']) {
  const e = $(id);
  try {
    const v = localStorage.getItem(`murmurcut.${id}`);
    if (v !== null) e.type === 'checkbox' ? (e.checked = v === '1') : (e.value = v);
  } catch {}
  e.addEventListener('change', () => {
    try { localStorage.setItem(`murmurcut.${id}`, e.type === 'checkbox' ? (e.checked ? '1' : '0') : e.value.trim()); } catch {}
  });
}
// The search-writing model is too big for a phone: the iPhone app's log showed iOS killing the page while it loaded.
if (phone) {
  $('aiSearch').checked = false;
  $('aiSearch').disabled = true;
  $('aiSearch').closest('label').nextElementSibling.textContent = 'Not on iPhone: the AI model is too big for a phone, so photo searches use keywords from what you said. Use a computer for AI searches.';
}

// --- timeline ---
function block(start, end, text, onclick, cls = 'block') {
  const b = el('button', { type: 'button', className: cls, textContent: text, title: text, onclick });
  b.style.left = `${start * PX}px`;
  b.style.width = `${Math.max(4, (end - start) * PX - 2)}px`;
  return b;
}
function renderTimeline() {
  $('tracks').style.width = `${(video.duration || 0) * PX}px`;
  $('trackCaps').replaceChildren(
    ...lines.map(l => block(l.start, l.end, l.words.map(w => w.text).join(' '), () => { seek(l.start); showTab('captions'); })),
    ...cuts.map(([a, b]) => { const z = el('div', { className: 'cutzone' }); z.style.left = `${a * PX}px`; z.style.width = `${(b - a) * PX}px`; return z; }));
  $('trackZoom').replaceChildren(...zooms.map(z => block(z.start, z.end, `${z.amount.toFixed(2)}×`, () => { seek(z.start); showTab('zoom'); })));
  $('trackBroll').replaceChildren(...brolls.map(b => block(b.start, b.end, b.clip ? `▶ ${b.clip.name}` : b.mode === 'text' ? `${b.label || b.query} (text)` : b.img ? b.query : `${b.query || 'b-roll'} (no photo)`, () => { seek(b.start); showTab('broll'); })));
}
$('tracks').onclick = e => {
  if (e.target.closest('.block')) return;
  seek((e.clientX - $('tracks').getBoundingClientRect().left) / PX);
};

function renderAll() {
  renderTranscript();
  renderBrolls();
  renderZooms();
  renderTimeline();
}

// --- smart cuts ---
function updateCuts() {
  cuts = cutRanges(words(), { fillers: $('fillers').checked, silence: $('silences').checked ? +$('silence').value : 0, duration: video.duration });
}
$('fillers').onchange = $('silences').onchange = () => { updateCuts(); renderTimeline(); };
$('silence').oninput = () => { $('silOut').textContent = $('silence').value; updateCuts(); renderTimeline(); };

// --- style gallery ---
const SAMPLE = { start: 0, end: 2.4, words: ['This', 'game', 'is', 'insane'].map((text, i) => ({ text, start: i * 0.6, end: i * 0.6 + 0.6, cut: false })) };
const galleries = Object.entries(PRESETS).map(([key, p]) => {
  const c = el('canvas', { width: 150, height: 200 });
  const b = el('button', { type: 'button', className: 'preset' }, c, el('span', { textContent: p.name }));
  b.setAttribute('aria-pressed', key === preset);
  b.setAttribute('aria-label', `${p.name} caption style`);
  b.onclick = () => { setPreset(key); commit(); };
  $('presets').append(b);
  return { c, p };
});
function drawGallery(now) {
  const t = reduceMotion ? 1.3 : (now / 1000) % 2.8;
  for (const { c, p } of galleries) {
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 0, 200);
    bg.addColorStop(0, '#191a1b');
    bg.addColorStop(1, '#010102');
    g.fillStyle = bg;
    g.fillRect(0, 0, 150, 200);
    drawCaption(g, 150, 200, SAMPLE, t, p, { size: 9, pos: 62, upper: true, index: 0 });
  }
}

// --- layout ---
// Split: b-roll on top, the speaker below. Captions move up to sit just above the speaker.
function onLayout() {
  const split = $('layout').value === 'split';
  if (split && +$('pos').value === 72) $('pos').value = 40;
  if (!split && +$('pos').value === 40) $('pos').value = 72;
}
$('layout').onchange = onLayout;

// --- scale ---
const radio = name => document.querySelector(`input[name="${name}"]:checked`).value;
const setRadio = (name, value) => { const r = document.querySelector(`input[name="${name}"][value="${value}"]`); if (r) r.checked = true; };
const RATIOS = { '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1, '16:9': 16 / 9 };
// Short side 1080 keeps captions and exports sharp on Reels and YouTube; H.264 needs even sizes.
function sizeCanvas() {
  const r = RATIOS[radio('ratio')] ?? (video.videoWidth ? video.videoWidth / video.videoHeight : 9 / 16); // no picture (an avatar's script): 9:16
  const even = n => Math.round(n / 2) * 2;
  [canvas.width, canvas.height] = r <= 1 ? [1080, even(1080 / r)] : [even(1080 * r), 1080];
}
document.querySelectorAll('input[name="ratio"]').forEach(r => (r.onchange = sizeCanvas));

// The speaker in the chosen format: cropped to fill (keeping the chosen part of the frame), or whole over a blurred copy.
function drawFramed(W, H, z) {
  const sw = video.videoWidth, sh = video.videoHeight;
  if (!sw) return; // sound only
  if (radio('fit') === 'fit' && Math.abs(sw / sh - W / H) > 0.01) {
    drawBlurred(ctx, video, sw, sh, 0, 0, W, H, 1.15, 28, 0.55);
    const k = Math.min(W / sw, H / sh) * z;
    ctx.drawImage(video, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k);
  } else drawCover(ctx, video, sw, sh, 0, 0, W, H, z, +$('anchor').value / 100);
}

// --- zoom ---
// Manual zooms ease in and out over a quarter second, like a camera push rather than a cut.
function zoomAt(t) {
  let z = 1;
  for (const m of zooms) if (t >= m.start && t < m.end) z = Math.max(z, 1 + (m.amount - 1) * Math.min(1, (t - m.start) / 0.25, (m.end - t) / 0.25));
  return z;
}
function addZoom(at, dur = 1.5, amount = 1.2) {
  const start = Math.max(0, Math.min(at, video.duration - 0.5));
  zooms = [...zooms, { start, end: Math.min(video.duration, start + dur), amount }].sort((a, b) => a.start - b.start);
}
$('addZoom').onclick = () => { addZoom(video.currentTime); renderZooms(); renderTimeline(); commit(); };
function renderZooms() {
  $('zooms').replaceChildren(...zooms.map(z => {
    const when = el('button', { type: 'button', className: 't', textContent: `${fmt(z.start)} – ${fmt(z.end)}`, onclick: () => seek(z.start) });
    const amount = el('input', { type: 'range', min: '1.05', max: '1.6', step: '0.05', value: z.amount });
    amount.oninput = () => { z.amount = +amount.value; renderTimeline(); };
    const len = el('input', { type: 'number', min: '0.5', max: '10', step: '0.5', value: (z.end - z.start).toFixed(1) });
    len.onchange = () => { z.end = Math.min(video.duration, z.start + Math.max(0.5, +len.value)); renderTimeline(); };
    const del = el('button', { type: 'button', className: 'btn secondary', textContent: 'Remove' });
    del.onclick = () => { zooms = zooms.filter(x => x !== z); renderZooms(); renderTimeline(); commit(); };
    return el('li', {}, el('div', { className: 'stack' },
      el('div', { className: 'meta' }, when, del),
      el('div', { className: 'field-row' }, el('label', {}, 'Strength', amount), el('label', {}, 'Length (s)', len))));
  }));
  if (!zooms.length && video.duration) $('zooms').append(el('li', { className: 'hint', textContent: 'No zooms yet. Move the playhead to a moment and add one.' }));
}

// --- style presets ---
function setPreset(key) {
  preset = key;
  document.querySelectorAll('.preset').forEach(x => x.setAttribute('aria-pressed', x.getAttribute('aria-label') === `${PRESETS[key].name} caption style`));
}

// --- undo ---
// Every edit records the state before it. Photos and clips are kept by reference, so undo is cheap.
const CONTROLS = ['size', 'pos', 'upper', 'zoom', 'fillers', 'silences', 'silence', 'layout', 'anchor', 'denoise', 'level', 'avatarMode', 'musicVol', 'dubKeep'];
const undoStack = [];
let lastState = null;
function snapshot() {
  return {
    lines: lines.map(l => ({ ...l, words: l.words.map(w => ({ ...w })) })),
    brolls: brolls.map(b => ({ ...b, ...(b.clip && { clip: { ...b.clip } }) })),
    zooms: zooms.map(z => ({ ...z })),
    preset, ratio: radio('ratio'), fit: radio('fit'),
    controls: Object.fromEntries(CONTROLS.map(id => [id, $(id).type === 'checkbox' ? $(id).checked : $(id).value])),
  };
}
function commit() {
  if (lastState) { undoStack.push(lastState); if (undoStack.length > 60) undoStack.shift(); }
  lastState = snapshot();
  $('undo').disabled = !undoStack.length;
}
function undo() {
  if (exporting) return;
  const s = undoStack.pop();
  if (!s) return status('Nothing to undo.');
  ({ lines, brolls, zooms } = s);
  setPreset(s.preset);
  setRadio('ratio', s.ratio);
  setRadio('fit', s.fit);
  for (const [id, v] of Object.entries(s.controls)) $(id).type === 'checkbox' ? ($(id).checked = v) : ($(id).value = v);
  $('silOut').textContent = $('silence').value;
  sizeCanvas();
  updateCuts();
  renderAll();
  lastState = snapshot();
  $('undo').disabled = !undoStack.length;
  status('Undone.');
}
$('undo').onclick = undo;
// Sliders, checkboxes, selects and caption edits all end in a change event; one listener records them.
const NOT_EDITS = new Set(['lang', 'capLang', 'model', 'aiSearch', 'pexelsKey', 'unsplashKey', 'file', 'clipFile', 'find', 'repl', 'script', 'chatInput']);
document.querySelector('.panel').addEventListener('change', e => {
  if (!NOT_EDITS.has(e.target.id) && e.target.type !== 'file' && video.duration) commit();
});

// --- chat to edit ---
const PRESET_NAMES = Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, p.name]));
const clampTo = (id, v) => String(Math.min(+$(id).max, Math.max(+$(id).min, v)));
function runAction(a) {
  switch (a.type) {
    case 'style': setPreset(a.preset); return `Captions now use ${PRESETS[a.preset].name}.`;
    case 'size': $('size').value = clampTo('size', +$('size').value + a.delta); return a.delta > 0 ? 'Captions are bigger.' : 'Captions are smaller.';
    case 'pos': $('pos').value = clampTo('pos', a.value ?? +$('pos').value + a.delta); return 'Moved the captions.';
    case 'upper': $('upper').checked = a.on; return a.on ? 'Captions are in capital letters.' : 'Captions are in normal case.';
    case 'fillers': $('fillers').checked = a.on; updateCuts(); return a.on ? 'Filler words are cut.' : 'Filler words are kept.';
    case 'silences':
      $('silences').checked = a.on;
      if (a.sec) { $('silence').value = clampTo('silence', a.sec); $('silOut').textContent = $('silence').value; }
      updateCuts();
      return a.on ? `Pauses longer than ${$('silence').value} s are cut.` : 'Pauses are kept.';
    case 'zoom': addZoom(a.at, a.dur, a.amount); return `Zoom added at ${fmt(Math.min(a.at, video.duration))}.`;
    case 'clearZooms': zooms = []; return 'Removed every zoom.';
    case 'autoZoom': $('zoom').checked = a.on; return a.on ? 'Punch-ins on every third line are on.' : 'Automatic punch-ins are off.';
    case 'broll': {
      const b = addPhoto(a.at, a.dur, a.query);
      return b.query ? `Looking for a photo of "${b.query}" at ${fmt(b.start)}.` : 'Added a b-roll moment. Type what the photo should show in B-roll.';
    }
    case 'clearBroll': brolls = brolls.filter(b => b.clip); return 'Removed the photo b-roll.';
    case 'ratio': setRadio('ratio', a.value); sizeCanvas(); return a.value === 'original' ? 'Back to the original shape.' : `The video is now ${a.value}.`;
    case 'fit': setRadio('fit', a.value); return a.value === 'fit' ? 'The whole frame shows, with blurred edges.' : 'The frame fills and crops.';
    case 'layout': $('layout').value = a.value; onLayout(); return a.value === 'split' ? 'Split screen is on.' : 'Full screen layout is on.';
    case 'replace': { const n = replaceText(lines, a.from, a.to); return n ? `Replaced "${a.from}" ${n} time${n > 1 ? 's' : ''}.` : `"${a.from}" isn't in the captions.`; }
    case 'denoise': $('denoise').checked = a.on; return a.on ? 'Background noise will be reduced.' : 'Noise reduction is off.';
    case 'level': $('level').checked = a.on; return a.on ? 'Loudness will be evened out.' : 'Loudness levelling is off.';
  }
}
function applyChat(text) {
  const { actions, unknown } = parseCommand(text, { presets: PRESET_NAMES, now: video.currentTime });
  if (actions.some(a => a.type === 'undo')) { undo(); return; }
  const done = actions.filter(a => a.type !== 'export').map(runAction);
  if (done.length) { updateCuts(); renderAll(); commit(); }
  const miss = unknown.length ? `I didn't get "${unknown.join('", "')}". Try: ${CHAT_EXAMPLES.slice(0, 4).join(' · ')}.` : '';
  status([...done, miss].filter(Boolean).join(' '));
  if (actions.some(a => a.type === 'export')) $('export').click();
}
$('chat').onsubmit = e => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text || !video.duration) return;
  applyChat(text);
  $('chatInput').value = '';
};
const chatHints = CHAT_EXAMPLES.slice(0, 5).map(x => el('button', { type: 'button', textContent: x, disabled: true, onclick: () => applyChat(x) }));
$('chatHints').append(...chatHints);

// --- extra soundtracks: music and the dub ---
// Each plays in an <audio> element that follows the video's play, pause and seek while previewing.
// The export mixes them properly in renderAudio.
let music = null; // { data: ArrayBuffer, title, credit }
let dubTrack = null; // { pcm, rate } on the source timeline
const tracks = { music: new Audio(), dub: new Audio() };
tracks.music.loop = true;
function follow() {
  for (const [kind, a] of Object.entries(tracks)) {
    if (!a.getAttribute('src')) continue;
    a.volume = kind === 'music' ? Math.min(1, +$('musicVol').value) : 1;
    const t = video.currentTime;
    a.currentTime = kind === 'music' && isFinite(a.duration) ? t % a.duration : t;
    video.paused || exporting ? a.pause() : a.play().catch(() => {});
  }
  video.volume = dubTrack ? ($('dubKeep').checked ? 0.15 : 0) : 1;
}
['play', 'pause', 'seeked'].forEach(ev => video.addEventListener(ev, follow));
$('musicVol').oninput = $('dubKeep').onchange = follow;
function setTrack(kind, src) {
  const a = tracks[kind];
  a.pause();
  if (a.src.startsWith('blob:')) URL.revokeObjectURL(a.src);
  src ? (a.src = src) : a.removeAttribute('src');
  follow();
}

// --- music ---
async function useMusic(m, src) {
  music = m;
  setTrack('music', src);
  $('musicNow').replaceChildren(`Now: ${m.title}. `, el('button', { type: 'button', className: 'btn tertiary', textContent: 'Remove', onclick: () => { music = null; setTrack('music', null); $('musicNow').textContent = 'No music.'; renderBrolls(); } }));
  renderBrolls();
}
$('musicSearch').onsubmit = async e => {
  e.preventDefault();
  const q = $('musicQuery').value.trim();
  if (!q) return;
  $('musicList').replaceChildren(el('li', { className: 'hint', textContent: 'Searching…' }));
  try {
    // commercial + modification: no NC (sponsored videos) and no ND (music under a video is an adaptation)
    const d = await getJson(`https://api.openverse.org/v1/audio/?q=${encodeURIComponent(q)}&category=music&license_type=commercial,modification&page_size=8`);
    $('musicList').replaceChildren(...d.results.map(r => {
      const credit = `"${r.title}" by ${r.creator || 'unknown'}, ${r.license.toUpperCase()} ${r.license_version ?? ''}, via Openverse: ${r.foreign_landing_url}`;
      const use = el('button', { type: 'button', className: 'btn secondary', textContent: 'Use' });
      use.onclick = async () => {
        use.disabled = true;
        try {
          const res = await fetch(r.url); // also proves the host allows the export to read it
          if (!res.ok) throw new Error(res.status);
          await useMusic({ data: await res.arrayBuffer(), title: r.title, credit }, r.url);
        } catch {
          status(`"${r.title}" can't be downloaded from its site. Pick another track.`);
        }
        use.disabled = false;
      };
      const mins = r.duration ? ` · ${fmt(r.duration / 1000)}` : '';
      return el('li', {}, el('div', { className: 'stack' },
        el('div', { className: 'meta' }, el('span', { textContent: `${r.title} — ${r.creator || 'unknown'}${mins}` }), use),
        el('audio', { controls: true, preload: 'none', src: r.url })));
    }));
    if (!d.results.length) $('musicList').replaceChildren(el('li', { className: 'hint', textContent: `No free music for "${q}". Try a mood or genre: lofi, piano, upbeat.` }));
  } catch (err) {
    $('musicList').replaceChildren(el('li', { className: 'hint', textContent: err.message }));
  }
};
$('musicFile').onchange = async e => {
  const f = e.target.files[0];
  if (f) await useMusic({ data: await f.arrayBuffer(), title: f.name, credit: '' }, URL.createObjectURL(f));
  e.target.value = '';
};

// --- dubbing ---
$('makeDub').onclick = async () => {
  const lang = $('dubLang').value;
  if (!lang) return status('Choose a language to dub into first.');
  const said = toSegments(words().filter(w => !w.cut)); // whole sentences translate far better than caption lines
  $('makeDub').disabled = true;
  $('progress').hidden = false;
  status(`Translating and voicing ${said.length} sentences. The first time downloads the language's models…`);
  try {
    const { audios, rate } = await askWorker({ type: 'dub', lang, texts: said.map(s => s.text) });
    dubTrack = { pcm: placeDub(said.map((s, i) => ({ start: s.start, pcm: audios[i] })), rate, video.duration), rate };
    avatarEnv = null; // the avatar now talks with the dub
    setTrack('dub', URL.createObjectURL(new Blob([toWav(dubTrack.pcm, rate)], { type: 'audio/wav' })));
    status('Dub ready. Press play to hear it; the export uses it instead of your voice.');
  } catch (e) {
    status(`Dubbing failed: ${e.message}`);
  }
  $('progress').hidden = true;
  $('makeDub').disabled = false;
};
$('dubLang').onchange = () => {
  if ($('dubLang').value) return;
  dubTrack = null;
  avatarEnv = null;
  setTrack('dub', null);
};

// --- avatars ---
// 3D presenters (avatar3d.js). In a corner or full screen they move with the video's voice (or the dub).
// "Make avatar video" gives one its own Kokoro voice reading a script, and that becomes the video.
let avatar = null, avatarEnv = null, envLoading = false;
const avatarOn = mode => avatar && $('avatarMode').value !== 'off' && (!mode || $('avatarMode').value === mode);
// Loudness of whoever is talking (the dub if there is one), worked out once in the background.
function avatarAmp(t) {
  if (!avatarEnv && !envLoading && file) {
    envLoading = true;
    (async () => {
      if (dubTrack) return envelope(dubTrack.pcm, dubTrack.rate);
      return envelope((await decodeAudio(16000))[0], 16000);
    })().then(e => (avatarEnv = e), () => (avatarEnv = new Float32Array(0))).finally(() => (envLoading = false));
  }
  return avatarEnv?.[Math.floor(t * 30)] ?? 0;
}
// One list: the six 3D presenters, then the photo avatars from avatars/index.json (each with its own voice clip
// and the closest Kokoro voice, used to read scripts).
const photoAvatars = fetch('avatars/index.json').then(r => r.json()).catch(() => []);
async function pickAvatar(a) {
  if (a.img) {
    const img = Object.assign(new Image(), { src: a.img });
    try { await img.decode(); } catch { return status(`${a.name}'s picture didn't load.`); }
    avatar = { a, name: a.name, voice: a.kokoro, sample: a.sample, el: img, w: img.naturalWidth, h: img.naturalHeight };
  } else {
    try { await prepare3d(); } catch (e) { return status(`3D avatars need WebGL, which this browser has turned off (${e.message}).`); }
    avatar = { a, name: a.name, voice: a.voice, spec: a, el: render3d(a, 0, 0), w: W3D, h: H3D };
  }
  if ($('avatarMode').value === 'off') $('avatarMode').value = video.duration ? 'corner' : 'full';
  for (const id of ['speak', 'hearVoice']) $(id).disabled = false;
  renderAvatars();
  commit();
}
// 3D thumbnails need three.js, so the list is drawn the first time the Avatar tab opens.
let thumbs = null;
async function renderAvatars() {
  thumbs ??= prepare3d().then(() => AVATARS.map(a => render3d(a, 0.6, 0).toDataURL('image/jpeg', 0.85)), () => []);
  const [pics, photos] = await Promise.all([thumbs, photoAvatars]);
  const card = (a, src, kind) => {
    const b = el('button', { type: 'button', className: 'preset', onclick: () => pickAvatar(a) }, el('img', { src, alt: '', loading: 'lazy' }), el('span', { textContent: a.name }));
    b.setAttribute('aria-pressed', avatar?.a === a);
    b.setAttribute('aria-label', `${a.name}, ${kind}`);
    return b;
  };
  $('avatars').replaceChildren(
    el('h3', { className: 'span', textContent: '3D presenters' }), ...AVATARS.map((a, i) => card(a, pics[i] ?? '', '3D avatar')),
    ...(photos.length ? [el('h3', { className: 'span', textContent: `Photo avatars (${photos.length})` })] : []),
    ...photos.map(a => card(a, a.img, `${a.group} photo avatar`)));
}
$('t-avatar').addEventListener('click', () => renderAvatars(), { once: true });

const speak = (text, voice) => askWorker({ type: 'speak', text, voice });
$('hearVoice').onclick = async () => {
  if (avatar.sample) return new Audio(avatar.sample).play().catch(() => status("Their voice clip didn't play."));
  $('hearVoice').disabled = true;
  status(`${avatar.name} is warming up. The first time downloads the voice model (about 90 MB)…`);
  try {
    const { pcm, rate } = await speak(`Hi, I'm ${avatar.name}. Give me a script and I'll present it.`, avatar.voice);
    new Audio(URL.createObjectURL(new Blob([toWav(pcm, rate)], { type: 'audio/wav' }))).play().catch(() => {});
    status('');
  } catch (e) {
    status(`The voice failed: ${e.message}`);
  }
  $('hearVoice').disabled = false;
};
$('speak').onclick = async () => {
  const text = $('avatarScript').value.trim();
  if (!text) return status('Type what the avatar should say first.');
  $('speak').disabled = true;
  $('progress').hidden = false;
  status(`${avatar.name} is recording your script. This runs on your computer and takes a while for long scripts…`);
  try {
    const { pcm, rate } = await speak(text, avatar.voice);
    // The spoken script becomes the video: full-screen avatar, English captions made straight away.
    video.addEventListener('loadedmetadata', () => $('transcribe').click(), { once: true });
    load(new File([toWav(pcm, rate)], `${avatar.name} presents.wav`, { type: 'audio/wav' }));
    $('avatarMode').value = 'full';
    $('lang').value = 'english';
    syncLang();
  } catch (e) {
    status(`Recording failed: ${e.message}`);
  }
  $('progress').hidden = true;
  $('speak').disabled = false;
};

// --- preview loop ---
let lastLine = -1, lastBroll = -1;
function drawFrame(t) {
  const W = canvas.width, H = canvas.height;
  const li = lines.findLastIndex(l => t >= l.start && t < l.end + 0.3);
  // The avatar is re-rendered every frame so its mouth, eyes and head follow the voice.
  if (avatarOn() && !green && avatar.spec) avatar.el = render3d(avatar.spec, t, avatarAmp(t));
  // Punch-in: every third line jumps 12% closer, the way editors cut talking heads. Manual zooms ease in and out.
  const z = Math.max($('zoom').checked && li % 3 === 1 ? 1 + 0.12 * Math.min(1, (t - lines[li].start) / 0.12) : 1, zoomAt(t));
  // Captions-on-green export: a flat key colour that any editor can remove to layer the captions over another edit.
  ctx.fillStyle = green ? '#00ff00' : '#000';
  ctx.fillRect(0, 0, W, H);
  if (!green && $('layout').value === 'split') {
    const top = Math.round(H * SPLIT);
    drawSpeaker(ctx, video, 0, top, W, H - top);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, top);
    ctx.clip();
    // Between b-roll moments the top shows the speaker blurred, so it is never a black hole.
    drawBlurred(ctx, video, video.videoWidth, video.videoHeight, 0, 0, W, top, 1.2, 24, 0.6);
    for (const b of brolls) drawBroll(ctx, W, top, b, t, video);
    ctx.restore();
  } else if (!green) {
    drawFramed(W, H, z);
    if (avatarOn('full')) drawAvatar(ctx, W, H, avatar.el, avatar.w, avatar.h, avatarAmp(t), t, 'full');
    for (const b of brolls) drawBroll(ctx, W, H, b, t, video);
  }
  if (!green && avatarOn('corner')) drawAvatar(ctx, W, H, avatar.el, avatar.w, avatar.h, avatarAmp(t), t, 'corner');
  if (li >= 0) drawCaption(ctx, W, H, lines[li], t, PRESETS[preset], { ...settings(), index: li });
  return li;
}

// Keep each second video at the right moment while previewing. One clip can sit in several split pieces,
// so work per video element: play it in the piece that is on screen, pause it otherwise.
function syncClips(t, playing) {
  const els = new Map();
  for (const b of brolls) if (b.clip) els.set(b.clip.el, (t >= b.start && t < b.end && b) || els.get(b.clip.el) || null);
  for (const [cel, b] of els) {
    if (!b) { if (!cel.paused) cel.pause(); continue; }
    const want = clipTime(b, t);
    if (playing) {
      cel.playbackRate = Math.min(4, Math.max(0.25, (b.clip.to - b.clip.from) / (b.end - b.start)));
      if (cel.paused) cel.play().catch(() => {});
      if (Math.abs(cel.currentTime - want) > 0.3) cel.currentTime = want;
    } else {
      if (!cel.paused) cel.pause();
      if (Math.abs(cel.currentTime - want) > 0.04) cel.currentTime = want;
    }
  }
}

let drawnAt = 0, perf = { ms: 0, n: 0, at: 0 };
function frame(now) {
  // The exporter owns the canvas and every video's position while it renders. Paused, a few redraws a second are plenty
  // to show edits, and leave the phone free for the work running alongside.
  if (video.readyState >= 2 && !exporting && (!video.paused || now - drawnAt > 200)) {
    drawnAt = now;
    if (!video.paused) {
      const to = skipCut(video.currentTime, cuts);
      if (to !== video.currentTime) video.currentTime = Math.min(to, video.duration);
    }
    const t = video.currentTime;
    syncClips(t, !video.paused);
    const t0 = performance.now(), li = drawFrame(t);
    // The iPhone app logs drawing speed while playing (ios/Sources/DebugLog.swift), to find what slows playback.
    if (window.murmurcutApp && !video.paused) {
      perf.ms += performance.now() - t0;
      perf.n++;
      if (now - perf.at > 5000) {
        const q = video.getVideoPlaybackQuality?.();
        if (perf.at) console.info(`perf: ${(perf.ms / perf.n).toFixed(1)} ms per frame, ${(perf.n / ((now - perf.at) / 1000)).toFixed(0)} fps, dropped ${q?.droppedVideoFrames}/${q?.totalVideoFrames}, layout ${$('layout').value}`);
        perf = { ms: 0, n: 0, at: now };
      }
    }
    $('playhead').style.left = `${t * PX}px`;
    $('time').textContent = `${fmt(t)} / ${fmt(video.duration)}`;
    if (!video.paused) {
      const sc = $('scroller');
      if (t * PX < sc.scrollLeft || t * PX > sc.scrollLeft + sc.clientWidth - 60) sc.scrollLeft = t * PX - 60;
    }
    if (li !== lastLine) { lineEls[lastLine]?.classList.remove('now'); lineEls[li]?.classList.add('now'); lastLine = li; }
    const bi = brolls.findIndex(b => t >= b.start && t < b.end);
    if (bi !== lastBroll) { brollEls[lastBroll]?.classList.remove('now'); brollEls[bi]?.classList.add('now'); lastBroll = bi; }
  }
  if (!$('tab-style').hidden) drawGallery(now);
  requestAnimationFrame(frame);
}
fontsReady.then(() => requestAnimationFrame(frame));

$('play').onclick = () => (video.paused ? video.play() : video.pause());
canvas.onclick = () => $('play').disabled || $('play').click(); // tap the preview to play or pause
video.onplay = () => ($('play').textContent = 'Pause');
video.onpause = () => ($('play').textContent = 'Play');
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !e.target.closest('input, textarea')) { e.preventDefault(); undo(); return; }
  if (e.code !== 'Space' || e.target.closest('input, textarea, select, button') || $('play').disabled) return;
  e.preventDefault();
  $('play').click();
});


// --- export ---
$('srt').onclick = () => download(new Blob([toSrt(lines, cuts)], { type: 'text/plain' }), baseName() + '.srt');
$('export').onclick = () => ('VideoEncoder' in window && 'AudioEncoder' in window ? exportOffline(false) : exportRealtime());
$('exportGreen').onclick = () => exportOffline(true);

const EXPORT_LOCKED = ['export', 'exportGreen', 'play', 'transcribe', 'srt', 'addClip'];
// inert also freezes the panel, chat and timeline, so no edit can reach a half-rendered export.
const lockButtons = on => {
  EXPORT_LOCKED.forEach(id => ($(id).disabled = on));
  for (const e of document.querySelectorAll('.panel, .rail, #chat, .timeline, #changeVideo, #undo')) e.inert = on;
};

// Resolves once el shows the frame at t. Seeking to where it already is fires no event, so skip that case.
function seekTo(el, t) {
  return new Promise(res => {
    if (Math.abs(el.currentTime - t) < 1e-4 && el.readyState >= 2) return res();
    el.addEventListener('seeked', res, { once: true });
    el.currentTime = t;
  });
}

// RNNoise, a small neural network trained to keep speech and drop fans, traffic and hum. It runs on 480-sample
// frames of 48 kHz mono in 16-bit range, so mix to mono (a phone mic is mono anyway) and scale around it.
async function denoise(channels) {
  const { Rnnoise } = await import(RNNOISE);
  const rn = await Rnnoise.load();
  const N = rn.frameSize;
  const mono = channels.length === 1 ? channels[0] : channels[0].map((v, i) => (v + channels[1][i]) / 2);
  const out = new Float32Array(mono.length);
  const st = rn.createDenoiseState();
  const f = new Float32Array(N);
  for (let i = 0; i + N <= mono.length; i += N) {
    for (let j = 0; j < N; j++) f[j] = mono[i + j] * 32768;
    st.processFrame(f);
    for (let j = 0; j < N; j++) out[i + j] = f[j] / 32768;
  }
  st.destroy();
  return [out];
}

// The export's soundtrack: decoded at 48 kHz, cleaned, cut like the video, levelled, as two channels.
async function renderAudio() {
  let ch = await decodeAudio(RATE);
  if (dubTrack) {
    const d = resample(dubTrack.pcm, dubTrack.rate, RATE), keep = $('dubKeep').checked ? 0.15 : 0;
    ch = [ch[0].map((v, i) => v * keep + (d[i] ?? 0))];
  } else if ($('denoise').checked) {
    status('Reducing background noise…');
    ch = await denoise(ch).catch(e => {
      console.warn('Noise reduction unavailable, exporting the original sound:', e.message);
      return ch;
    });
  }
  ch = cutAudio(ch, cuts, RATE);
  if ($('level').checked) levelAudio(ch, RATE);
  if (music) {
    const mc = new AudioContext({ sampleRate: RATE });
    const m = await mc.decodeAudioData(music.data.slice(0)).finally(() => mc.close());
    const bed = bedMusic(m.getChannelData(0), ch[0], RATE, +$('musicVol').value);
    ch = ch.map(c => c.map((v, i) => v + bed[i]));
  }
  return ch.length === 1 ? [ch[0], ch[0]] : ch;
}

async function pickAudioCodec() {
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const config = { codec, sampleRate: RATE, numberOfChannels: 2, bitrate: 160000 };
    if ((await AudioEncoder.isConfigSupported(config).catch(() => ({}))).supported) return { config, mux };
  }
  return null;
}

// Renders frame by frame with WebCodecs instead of recording in real time: every frame is drawn after the video
// (and any second clip) has actually reached it, so nothing drops or drifts on a slow machine, and the tab can be
// in the background. Cuts are applied by mapping each output frame back to its source time.
// captionsOnly: just the captions on green, no sound, to layer over another edit.
async function exportOffline(captionsOnly) {
  if (exporting) return;
  exporting = true;
  lockButtons(true);
  green = captionsOnly;
  video.pause();
  const resume = video.currentTime;
  try {
    const { Muxer, ArrayBufferTarget } = await import(MUXER);
    const W = canvas.width, H = canvas.height;
    const audio = captionsOnly ? null : await renderAudio();
    const acodec = audio && (await pickAudioCodec());
    if (audio && !acodec) throw new Error("this browser can't encode audio");
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width: W, height: H },
      ...(acodec && { audio: { codec: acodec.mux, numberOfChannels: 2, sampleRate: RATE } }),
      fastStart: 'in-memory',
    });
    let failed;
    if (audio) {
      status('Encoding the sound…');
      const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => (failed = e) });
      aenc.configure(acodec.config);
      const len = audio[0].length;
      for (let i = 0; i < len; i += 1024) {
        const n = Math.min(1024, len - i);
        const data = new Float32Array(n * 2);
        data.set(audio[0].subarray(i, i + n), 0);
        data.set(audio[1].subarray(i, i + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / RATE) * 1e6), data });
        aenc.encode(ad);
        ad.close();
      }
      await aenc.flush();
    }
    const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => (failed = e) });
    venc.configure({ codec: 'avc1.640032', width: W, height: H, bitrate: 8e6, framerate: FPS });
    const n = Math.floor(toOutput(video.duration, cuts) * FPS);
    const label = captionsOnly ? 'Rendering captions on green' : 'Rendering video';
    for (let i = 0; i < n && !failed; i++) {
      const t = Math.min(toSource(i / FPS, cuts) + 1e-3, video.duration - 1e-3);
      if (!captionsOnly) {
        await seekTo(video, t);
        await Promise.all(brolls.filter(b => b.clip && t >= b.start && t < b.end).map(b => seekTo(b.clip.el, clipTime(b, t))));
      }
      drawFrame(t);
      const f = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      venc.encode(f, { keyFrame: i % 60 === 0 });
      f.close();
      if (venc.encodeQueueSize > 20) await new Promise(r => venc.addEventListener('dequeue', r, { once: true }));
      if (i % 10 === 0) status(`${label}… ${Math.round((i / n) * 100)}%`);
    }
    if (failed) throw failed;
    await venc.flush();
    muxer.finalize();
    download(new Blob([target.buffer], { type: 'video/mp4' }), `${baseName()}-${captionsOnly ? 'captions-green' : 'murmurcut'}.mp4`);
    status('Export finished. Check your downloads.');
  } catch (e) {
    status(`Export failed: ${e.message}`);
  } finally {
    green = false;
    exporting = false;
    lockButtons(false);
    seek(resume);
  }
}

// Fallback for browsers without WebCodecs: record the canvas while the video plays. It needs the tab visible,
// and a slow machine can drop frames, which is why the offline export is preferred.
async function exportRealtime() {
  if (exporting) return;
  if (!audioDest) {
    // An element can only be routed into Web Audio once, so this graph lives for the page.
    const ac = new AudioContext();
    audioDest = ac.createMediaStreamDestination();
    for (const el of [video, tracks.music, tracks.dub]) {
      const src = ac.createMediaElementSource(el);
      src.connect(audioDest);
      src.connect(ac.destination);
    }
  }
  const type = ['video/mp4;codecs=avc3,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  if (!type) return status("This browser can't record video. Use Chrome or Edge.");
  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...audioDest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8e6 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    lockButtons(false);
    download(new Blob(chunks, { type }), `${baseName()}-murmurcut.${type.includes('mp4') ? 'mp4' : 'webm'}`);
    status('Export finished. Check your downloads.');
  };
  // The live recorder needs the preview loop drawing, so it locks the buttons but leaves `exporting` off.
  lockButtons(true);
  video.pause();
  seek(skipCut(0, cuts));
  await new Promise(r => video.addEventListener('seeked', r, { once: true }));
  video.addEventListener('ended', () => rec.stop(), { once: true });
  rec.start(1000);
  status('Exporting in real time. Keep this tab open and visible…');
  await video.play();
}
