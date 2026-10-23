import { toWords, groupWords, editLine, cutRanges, skipCut, toSrt, planBroll, toSegments, pickKeyword, topicOf, isAbstract } from './captions.js';
import { PRESETS, drawCaption, drawBroll, drawCover } from './render.js';

const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('canvas'), ctx = canvas.getContext('2d');
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const PX = 60; // timeline pixels per second
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let file, topic = null, topicInfo = null, genericPool = null, lines = [], brolls = [], cuts = [], preset = 'spotlight', exporting = false, audioDest, nextId = 1;

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
  $('export').disabled = $('srt').disabled = $('addBroll').disabled = true;
  $('fileName').textContent = f.name;
  video.src = URL.createObjectURL(f);
}
$('file').onchange = e => load(e.target.files[0]);
const drop = $('drop');
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); load(e.dataTransfer.files[0]); };

video.onloadedmetadata = () => {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.hidden = $('changeVideo').hidden = false;
  drop.hidden = true;
  $('transcribe').disabled = $('play').disabled = false;
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

// Photo ranking requests share the worker with transcription; replies are matched by id.
const pending = new Map();
let rankId = 0;
const rankTexts = (queries, texts) => new Promise((resolve, reject) => {
  const id = ++rankId;
  pending.set(id, d => (d.error ? reject(new Error(d.error)) : resolve(d.scores)));
  worker.postMessage({ type: 'rank', id, queries, texts });
});

worker.onmessage = ({ data }) => {
  if (data.type === 'ranked') { pending.get(data.id)?.(data); pending.delete(data.id); return; }
  if (data.type === 'progress') { $('progress').value = data.progress / 100; return; }
  if (data.type === 'status') { $('progress').removeAttribute('value'); return status(data.text); }
  $('progress').hidden = true;
  $('transcribe').disabled = false;
  if (data.type === 'error') return status(`Transcription failed: ${data.message}`);
  const ws = toWords(data.chunks);
  lines = groupWords(ws);
  topic = topicOf(ws);
  brolls = planBroll(data.segments ?? toSegments(ws)).map(b => ({ ...b, planned: b.mode, id: nextId++, options: [], pick: 0 }));
  topicInfo = genericPool = null;
  updateCuts();
  renderAll();
  $('export').disabled = $('srt').disabled = $('addBroll').disabled = !lines.length;
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
  topicInfo = { about: p ? `${p.title}: ${desc}` : topic, domain: desc.replace(/\b\d{4}s?\b/g, '').trim().split(/\s+/).slice(-2).join(' ') };
  if (topicInfo.domain) genericPool = openversePhotos(topicInfo.domain).then(r => r.map(o => ({ ...o, generic: true })), () => []);
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MIN_FIT = 0.3; // below this nothing found fits what was said, so a text card beats a wrong photo

async function search(b) {
  b.note = 'Searching…';
  renderBrolls();
  await loadTopic();
  const q = b.query;
  const exact = wikiPages(q);
  const results = await Promise.allSettled([exact.then(toPhotos), topic && !q.includes(topic) && wikiPhotos(`${q} ${topic}`), openversePhotos(q), genericPool].filter(Boolean));
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

async function searchAll() {
  for (const b of brolls) if (b.query) await search(b); // one at a time, to stay inside the anonymous rate limits
  const found = brolls.filter(b => b.img && b.mode !== 'text').length;
  status(`${lines.length} caption lines, ${found} b-roll photos and ${brolls.length - found} text cards ready. Play it, then export.`);
}

const MODE_LABEL = { full: 'Full screen', card: 'Photo card', blur: 'Blurred behind', text: 'Text card' };
let brollEls = [];
function renderBrolls() {
  brollEls = brolls.map(b => {
    const thumb = el('img', { className: 'thumb', alt: b.img && b.mode !== 'text' ? `Photo for ${b.query}` : '' });
    if (b.img && b.mode !== 'text') thumb.src = b.img.src;
    const mode = el('select', {}, ...Object.entries(MODE_LABEL).map(([v, t]) => el('option', { value: v, textContent: t, selected: v === b.mode })));
    mode.setAttribute('aria-label', 'How the photo appears');
    mode.onchange = () => { b.mode = mode.value; renderBrolls(); renderTimeline(); };
    const q = el('input', { type: 'text', value: b.query, placeholder: 'What should the photo show?' });
    q.setAttribute('aria-label', 'Photo search');
    q.onchange = () => { b.query = b.label = q.value.trim(); if (b.query) search(b); };
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
  $('trackBroll').replaceChildren(...brolls.map(b => block(b.start, b.end, b.mode === 'text' ? `${b.label || b.query} (text)` : b.img ? b.query : `${b.query || 'b-roll'} (no photo)`, () => { seek(b.start); showTab('broll'); })));
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

// --- preview loop ---
let lastLine = -1, lastBroll = -1;
function drawFrame(t) {
  const W = canvas.width, H = canvas.height;
  const li = lines.findLastIndex(l => t >= l.start && t < l.end + 0.3);
  // Punch-in: every third line jumps 12% closer, the way editors cut talking heads.
  const z = $('zoom').checked && li % 3 === 1 ? 1 + 0.12 * Math.min(1, (t - lines[li].start) / 0.12) : 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  drawCover(ctx, video, video.videoWidth, video.videoHeight, 0, 0, W, H, z);
  for (const b of brolls) drawBroll(ctx, W, H, b, t, video);
  if (li >= 0) drawCaption(ctx, W, H, lines[li], t, PRESETS[preset], { ...settings(), index: li });
  return li;
}

// shortcut: rAF pauses in background tabs, so export needs the tab visible; a WebCodecs + muxer pipeline would lift that.
function frame(now) {
  if (video.readyState >= 2) {
    if (!video.paused) {
      const to = skipCut(video.currentTime, cuts);
      if (to !== video.currentTime) video.currentTime = Math.min(to, video.duration);
    }
    const t = video.currentTime;
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
$('srt').onclick = () => download(new Blob([toSrt(lines)], { type: 'text/plain' }), baseName() + '.srt');

$('export').onclick = async () => {
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
  const lock = on => { exporting = on; for (const id of ['export', 'play', 'transcribe', 'srt']) $(id).disabled = on; };
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    lock(false);
    download(new Blob(chunks, { type }), `${baseName()}-murmurcut.${type.includes('mp4') ? 'mp4' : 'webm'}`);
    status('Export finished. Check your downloads.');
  };
  lock(true);
  video.pause();
  seek(skipCut(0, cuts));
  await new Promise(r => video.addEventListener('seeked', r, { once: true }));
  video.addEventListener('ended', () => rec.stop(), { once: true });
  rec.start(1000);
  status('Exporting in real time. Keep this tab open and visible.');
  await video.play();
};
