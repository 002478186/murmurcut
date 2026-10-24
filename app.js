import { toWords, groupWords, editLine, cutRanges, skipCut, toSrt, planBroll, toSegments, pickKeyword, topicOf, isAbstract, cleanQuery, dropCommon, domainOf, alignScript, replaceText, toOutput, toSource, splitClip, clipTime } from './captions.js';
import { PRESETS, drawCaption, drawBroll, drawCover, drawSpeaker } from './render.js';
import { cutAudio, levelAudio } from './audio.js';

const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('canvas'), ctx = canvas.getContext('2d');
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const PX = 60; // timeline pixels per second
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const SPLIT = 0.45; // share of the frame the b-roll takes on a split screen; the speaker gets the rest
const MUXER = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/+esm';
const RNNOISE = 'https://cdn.jsdelivr.net/npm/@shiguredo/rnnoise-wasm@2025.1.5/dist/rnnoise.js';
const FPS = 30, RATE = 48000;

let heard = []; // Whisper's words as heard, kept so "Use my script" can be re-applied after edits
let green = false, file, topic = null, topicInfo = null, genericPool = null, lines = [], brolls = [], cuts = [], preset = 'spotlight', exporting = false, audioDest, nextId = 1;

const status = text => ($('status').textContent = text);
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
const enableEditing = on => ['export', 'exportGreen', 'srt', 'addBroll', 'researchAll', 'replaceBtn', 'applyScript'].forEach(id => ($(id).disabled = !on));

// --- tabs ---
const tabs = [...document.querySelectorAll('[role="tab"]')];
function showTab(name) {
  tabs.forEach(t => {
    const on = t.id === `t-${name}`;
    t.setAttribute('aria-selected', on);
    $(t.getAttribute('aria-controls')).hidden = !on;
  });
}
tabs.forEach(t => (t.onclick = () => showTab(t.id.slice(2))));

// --- import ---
function load(f) {
  if (!f?.type.startsWith('video/')) return status('That file is not a video. Choose an MP4, MOV or WebM file.');
  file = f;
  lines = [];
  brolls = [];
  cuts = [];
  renderAll();
  enableEditing(false);
  heard = [];
  $('fileName').textContent = f.name;
  video.src = URL.createObjectURL(f);
}
$('file').onchange = e => load(e.target.files[0]);
const drop = $('drop');
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); load(e.dataTransfer.files[0]); };

video.onloadedmetadata = () => {
  // Phone clips are often 576 wide; render at least 1080 wide so captions and exports stay sharp on Reels.
  const k = Math.max(1, 1080 / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * k);
  canvas.height = Math.round(video.videoHeight * k);
  canvas.hidden = $('changeVideo').hidden = false;
  drop.hidden = true;
  $('transcribe').disabled = $('play').disabled = $('addClip').disabled = false;
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

// --- transcribe ---
$('transcribe').onclick = async () => {
  $('transcribe').disabled = true;
  status('Reading the audio…');
  const ac = new AudioContext({ sampleRate: 16000 }); // Whisper expects 16 kHz mono
  let buf;
  try {
    buf = await ac.decodeAudioData(await file.arrayBuffer());
  } catch {
    $('transcribe').disabled = false;
    return status("Couldn't read the audio track of this video.");
  } finally {
    ac.close();
  }
  const audio = buf.getChannelData(0);
  status('Downloading the speech model. This only happens the first time.');
  $('progress').hidden = false;
  $('progress').removeAttribute('value');
  const language = $('lang').value;
  worker.postMessage({ audio, language, model: $('model').value, translate: language !== 'english' && $('capLang').value === 'english' }, [audio.buffer]);
};

// Ranking and search-writing requests share the worker with transcription; replies are matched by id.
const pending = new Map();
let askId = 0;
const askWorker = msg => new Promise((resolve, reject) => {
  const id = ++askId;
  pending.set(id, d => (d.error ? reject(new Error(d.error)) : resolve(d)));
  worker.postMessage({ ...msg, id });
});
const rankTexts = (queries, texts) => askWorker({ type: 'rank', queries, texts }).then(d => d.scores);

worker.onmessage = ({ data }) => {
  if (data.type === 'ranked' || data.type === 'suggested') { pending.get(data.id)?.(data); pending.delete(data.id); return; }
  if (data.type === 'progress') { $('progress').value = data.progress / 100; return; }
  if (data.type === 'status') { $('progress').removeAttribute('value'); return status(data.text); }
  $('progress').hidden = true;
  $('transcribe').disabled = false;
  if (data.type === 'error') return status(`Transcription failed: ${data.message}`);
  const ws = toWords(data.chunks);
  heard = ws.map(w => ({ ...w }));
  lines = groupWords(ws);
  topic = topicOf(ws);
  brolls = planBroll(data.segments ?? toSegments(ws)).map(b => ({ ...b, planned: b.mode, id: nextId++, options: [], pick: 0 }));
  topicInfo = genericPool = null;
  updateCuts();
  renderAll();
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
      c.onclick = () => { w.cut = !w.cut; c.classList.toggle('cut', w.cut); c.setAttribute('aria-pressed', w.cut); updateCuts(); renderTimeline(); };
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
  if (n) { updateCuts(); renderAll(); }
  status(n ? `Replaced ${n} time${n > 1 ? 's' : ''}.` : `"${$('find').value.trim()}" isn't in the captions.`);
};
$('applyScript').onclick = () => {
  const aligned = alignScript($('script').value, heard);
  if (!aligned.length) return status('Paste the script you read first, one caption line per line.');
  lines = groupWords(aligned, { maxWords: 6, maxGap: 9 }); // the script's own line breaks decide the lines
  updateCuts();
  renderAll();
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
  const b = { id: nextId++, start, end: video.duration, mode: 'full', clip: { el, from: 0, to: el.duration, name: f.name }, query: '', label: f.name, options: [], pick: 0 };
  brolls = [...brolls, b].sort((x, y) => x.start - y.start);
  if ($('layout').value === 'full') { $('layout').value = 'split'; onLayout(); }
  renderBrolls();
  renderTimeline();
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
  const d = await getJson(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=10&license_type=commercial&mature=false`);
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

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  b.note = 'Searching…';
  renderBrolls();
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
  b.options = pool;
  b.pick = 0;
  const fits = pool.length && (pool[0].fit ?? 1) >= MIN_FIT;
  if (pool.length) await usePick(b);
  else b.img = null;
  if (fits && b.img && !abstract) {
    if (b.mode === 'text') b.mode = b.planned ?? 'full';
  } else {
    b.mode = 'text';
    const err = results.find(r => r.status === 'rejected')?.reason?.message;
    b.note = abstract ? `${top.title} is ${/^[aeiou]/i.test(top.description) ? 'an' : 'a'} ${top.description[0].toLowerCase() + top.description.slice(1)}, which a photo can't really show, so this is a text card. Pick a photo layout to use the closest photo anyway.`
      : err === 'Failed to fetch' ? 'The photo search is unreachable, so this shows as a text card.'
      : pool.length ? 'No photo fitted what you said, so this shows as a text card. Pick a photo layout to use the closest one anyway.'
      : `No free photos for "${q}", so this shows as a text card. Try another word, or upload your own.`;
  }
  renderBrolls();
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
  status(`${lines.length} caption lines, ${found} b-roll photos and ${brolls.length - found} text cards ready. Play it, then export.`);
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
    parts[1].id = nextId++;
    brolls.splice(brolls.indexOf(b), 1, ...parts);
    renderBrolls();
    renderTimeline();
  };
  const del = el('button', { type: 'button', className: 'btn ghost', textContent: 'Remove' });
  del.onclick = () => { brolls = brolls.filter(x => x !== b); renderBrolls(); renderTimeline(); };
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

function renderBrolls() {
  brollEls = brolls.map(b => {
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
      renderBrolls();
    };
    const upBtn = el('button', { type: 'button', className: 'btn ghost', textContent: 'Upload', onclick: () => up.click() });
    const del = el('button', { type: 'button', className: 'btn ghost', textContent: 'Remove' });
    del.onclick = () => { brolls = brolls.filter(x => x !== b); renderBrolls(); renderTimeline(); };
    const when = el('button', { type: 'button', className: 't', textContent: `${fmt(b.start)} – ${fmt(b.end)}`, onclick: () => seek(b.start) });
    const body = el('div', { className: 'stack' },
      el('div', { className: 'meta' }, when, mode),
      q,
      ...(b.ai ? [el('p', { className: 'hint ai', textContent: `AI also searched for "${b.ai}"` })] : []),
      ...(b.note ? [el('p', { className: 'hint', textContent: b.note })] : []),
      el('div', { className: 'actions' }, swap, upBtn, del, up));
    return el('li', {}, thumb, body);
  });
  $('brolls').replaceChildren(...brollEls);
  if (!brolls.length && lines.length) $('brolls').append(el('li', { className: 'hint', textContent: 'No b-roll yet. Move the playhead and add one.' }));
  $('credits').value = brolls.filter(b => b.mode !== 'text').map(b => b.credit).filter(Boolean).join('\n');
}

$('addBroll').onclick = () => {
  const t = video.currentTime;
  const line = lines.find(l => t >= l.start && t < l.end) ?? lines.find(l => l.start >= t);
  const b = { id: nextId++, start: t, end: Math.min(t + 2.5, video.duration), query: line ? pickKeyword(line.words.map(w => w.text).join(' ')) ?? '' : '', context: line?.words.map(w => w.text).join(' '), mode: 'full', planned: 'full', options: [], pick: 0 };
  b.label = b.query;
  brolls = [...brolls, b].sort((x, y) => x.start - y.start);
  renderBrolls();
  renderTimeline();
  if (b.query) search(b);
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
  $('trackBroll').replaceChildren(...brolls.map(b => block(b.start, b.end, b.clip ? `▶ ${b.clip.name}` : b.mode === 'text' ? `${b.label || b.query} (text)` : b.img ? b.query : `${b.query || 'b-roll'} (no photo)`, () => { seek(b.start); showTab('broll'); })));
}
$('tracks').onclick = e => {
  if (e.target.closest('.block')) return;
  seek((e.clientX - $('tracks').getBoundingClientRect().left) / PX);
};

function renderAll() {
  renderTranscript();
  renderBrolls();
  renderTimeline();
}

// --- smart cuts ---
function updateCuts() {
  cuts = cutRanges(words(), { fillers: $('fillers').checked, silence: $('silences').checked ? +$('silence').value : 0 });
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
  b.onclick = () => {
    preset = key;
    document.querySelectorAll('.preset').forEach(x => x.setAttribute('aria-pressed', x === b));
  };
  $('presets').append(b);
  return { c, p };
});
function drawGallery(now) {
  const t = reduceMotion ? 1.3 : (now / 1000) % 2.8;
  for (const { c, p } of galleries) {
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 0, 200);
    bg.addColorStop(0, '#3b3247');
    bg.addColorStop(1, '#121016');
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

// --- preview loop ---
let lastLine = -1, lastBroll = -1;
function drawFrame(t) {
  const W = canvas.width, H = canvas.height;
  const li = lines.findLastIndex(l => t >= l.start && t < l.end + 0.3);
  // Punch-in: every third line jumps 12% closer, the way editors cut talking heads.
  const z = $('zoom').checked && li % 3 === 1 ? 1 + 0.12 * Math.min(1, (t - lines[li].start) / 0.12) : 1;
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
    ctx.filter = 'blur(24px) brightness(0.6)';
    drawCover(ctx, video, video.videoWidth, video.videoHeight, 0, 0, W, top, 1.2);
    ctx.filter = 'none';
    for (const b of brolls) drawBroll(ctx, W, top, b, t, video);
    ctx.restore();
  } else if (!green) {
    drawCover(ctx, video, video.videoWidth, video.videoHeight, 0, 0, W, H, z);
    for (const b of brolls) drawBroll(ctx, W, H, b, t, video);
  }
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

function frame(now) {
  // The exporter owns the canvas and every video's position while it renders.
  if (video.readyState >= 2 && !exporting) {
    if (!video.paused) {
      const to = skipCut(video.currentTime, cuts);
      if (to !== video.currentTime) video.currentTime = Math.min(to, video.duration);
    }
    const t = video.currentTime;
    syncClips(t, !video.paused);
    const li = drawFrame(t);
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
video.onplay = () => ($('play').textContent = 'Pause');
video.onpause = () => ($('play').textContent = 'Play');
document.addEventListener('keydown', e => {
  if (e.code !== 'Space' || e.target.closest('input, textarea, select, button') || $('play').disabled) return;
  e.preventDefault();
  $('play').click();
});


// --- export ---
$('srt').onclick = () => download(new Blob([toSrt(lines, cuts)], { type: 'text/plain' }), baseName() + '.srt');
$('export').onclick = () => ('VideoEncoder' in window ? exportOffline(false) : exportRealtime());
$('exportGreen').onclick = () => exportOffline(true);

const EXPORT_LOCKED = ['export', 'exportGreen', 'play', 'transcribe', 'srt', 'addClip'];
const lockButtons = on => EXPORT_LOCKED.forEach(id => ($(id).disabled = on));

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
  const ac = new AudioContext({ sampleRate: RATE });
  let buf;
  try {
    buf = await ac.decodeAudioData(await file.arrayBuffer());
  } finally {
    ac.close();
  }
  let ch = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, i) => buf.getChannelData(i).slice());
  if ($('denoise').checked) {
    status('Reducing background noise…');
    ch = await denoise(ch).catch(e => {
      console.warn('Noise reduction unavailable, exporting the original sound:', e.message);
      return ch;
    });
  }
  ch = cutAudio(ch, cuts, RATE);
  if ($('level').checked) levelAudio(ch, RATE);
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
    const src = ac.createMediaElementSource(video);
    audioDest = ac.createMediaStreamDestination();
    src.connect(audioDest);
    src.connect(ac.destination);
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
  status('Exporting in real time. Keep this tab open and visible.');
  await video.play();
}
