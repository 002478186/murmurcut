import { toWords, groupWords, editLine, cutRanges, skipCut, toSrt } from './captions.js';

const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('canvas'), ctx = canvas.getContext('2d');
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

const PRESETS = {
  pop: { name: 'Pop', font: '900 {s}px "Arial Black", Impact, sans-serif', fill: '#fff', stroke: '#000', active: '#ffd400', grow: 1.15 },
  karaoke: { name: 'Karaoke', font: '800 {s}px system-ui, sans-serif', fill: '#fff', stroke: '#000', box: '#16a34a' },
  minimal: { name: 'Minimal', font: '600 {s}px system-ui, sans-serif', fill: '#fff', bar: 'rgba(0,0,0,0.6)' },
  neon: { name: 'Neon', font: '800 {s}px "Trebuchet MS", sans-serif', fill: '#a5f3fc', glow: '#22d3ee', active: '#f472b6' },
};

let file, lines = [], cuts = [], preset = 'pop', exporting = false, audioDest;

const status = text => ($('status').textContent = text);
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const words = () => lines.flatMap(l => l.words);

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// --- import ---
function load(f) {
  if (!f?.type.startsWith('video/')) return status('Please choose a video file.');
  file = f;
  lines = [];
  renderTranscript();
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
  $('seek').max = video.duration;
  canvas.hidden = $('controls').hidden = false;
  drop.hidden = true;
  $('transcribe').disabled = false;
  status(`Loaded ${file.name}. Next: generate captions.`);
};
video.onerror = () => status("This browser can't play that video. Try an MP4 (H.264) or WebM.");

// --- transcribe ---
$('transcribe').onclick = async () => {
  $('transcribe').disabled = true;
  status('Decoding audio…');
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
  status('Loading speech model (first run downloads ~150 MB, then it is cached)…');
  $('progress').hidden = false;
  $('progress').removeAttribute('value');
  worker.postMessage({ audio, language: $('lang').value }, [audio.buffer]);
};

worker.onmessage = ({ data }) => {
  if (data.type === 'progress') { $('progress').value = data.progress / 100; return; }
  if (data.type === 'status') { $('progress').removeAttribute('value'); return status(data.text); }
  $('progress').hidden = true;
  $('transcribe').disabled = false;
  if (data.type === 'error') return status(`Transcription failed: ${data.message}`);
  lines = groupWords(toWords(data.chunks));
  renderTranscript();
  updateCuts();
  $('export').disabled = $('srt').disabled = !lines.length;
  status(lines.length ? `${lines.length} caption lines. Pick a style, then export.` : 'No speech found in this video.');
};

// --- transcript ---
function renderTranscript() {
  if (!lines.length) return $('lines').replaceChildren(Object.assign(document.createElement('li'), { className: 'hint', textContent: 'Captions will appear here.' }));
  $('lines').replaceChildren(...lines.map(l => {
    const li = document.createElement('li');
    const t = Object.assign(document.createElement('button'), { className: 't', type: 'button', textContent: fmt(l.start), onclick: () => (video.currentTime = l.start) });
    t.setAttribute('aria-label', `Jump to ${fmt(l.start)}`);
    const input = Object.assign(document.createElement('input'), { value: l.words.map(w => w.text).join(' ') });
    input.setAttribute('aria-label', `Caption at ${fmt(l.start)}`);
    input.onchange = () => { editLine(l, input.value); renderTranscript(); updateCuts(); };
    const chips = Object.assign(document.createElement('div'), { className: 'chips' });
    chips.append(...l.words.map(w => {
      const c = Object.assign(document.createElement('button'), { type: 'button', className: 'chip' + (w.cut ? ' cut' : ''), textContent: w.text });
      c.setAttribute('aria-pressed', w.cut);
      c.title = 'Click to cut this word from the video';
      c.onclick = () => { w.cut = !w.cut; c.classList.toggle('cut', w.cut); c.setAttribute('aria-pressed', w.cut); updateCuts(); };
      return c;
    }));
    li.append(t, input, chips);
    return li;
  }));
}

// --- smart cuts ---
function updateCuts() {
  cuts = cutRanges(words(), { fillers: $('fillers').checked, silence: $('silences').checked ? +$('silence').value : 0 });
}
$('fillers').onchange = $('silences').onchange = updateCuts;
$('silence').oninput = () => { $('silOut').textContent = $('silence').value; updateCuts(); };

// --- style ---
$('presets').append(...Object.entries(PRESETS).map(([key, p]) => {
  const b = Object.assign(document.createElement('button'), { type: 'button', textContent: p.name });
  b.setAttribute('aria-pressed', key === preset);
  b.onclick = () => {
    preset = key;
    $('presets').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
  };
  return b;
}));

function drawCaption(t) {
  const line = lines.findLast(l => t >= l.start && t < l.end + 0.3);
  const ws = line?.words.filter(w => !w.cut);
  if (!ws?.length) return;
  const p = PRESETS[preset], W = canvas.width, H = canvas.height;
  const s = (+$('size').value * H) / 100;
  ctx.save();
  ctx.font = p.font.replace('{s}', s);
  ctx.textBaseline = 'middle';
  const texts = ws.map(w => ($('upper').checked ? w.text.toUpperCase() : w.text));
  const widths = texts.map(x => ctx.measureText(x).width);
  const gap = ctx.measureText(' ').width;
  const total = widths.reduce((a, b) => a + b, 0) + gap * (ws.length - 1);
  ctx.translate(W / 2, (H * +$('pos').value) / 100);
  ctx.scale(Math.min(1, (W * 0.9) / total), Math.min(1, (W * 0.9) / total));
  if (p.bar) {
    ctx.fillStyle = p.bar;
    ctx.beginPath();
    ctx.roundRect(-total / 2 - s * 0.4, -s * 0.75, total + s * 0.8, s * 1.5, s * 0.25);
    ctx.fill();
  }
  let x = -total / 2;
  ws.forEach((w, i) => {
    const active = t >= w.start && t < w.end, cx = x + widths[i] / 2;
    ctx.save();
    if (active && p.grow) { ctx.translate(cx, 0); ctx.scale(p.grow, p.grow); ctx.translate(-cx, 0); }
    if (active && p.box) {
      ctx.fillStyle = p.box;
      ctx.beginPath();
      ctx.roundRect(x - s * 0.15, -s * 0.65, widths[i] + s * 0.3, s * 1.3, s * 0.2);
      ctx.fill();
    }
    if (p.glow) { ctx.shadowColor = p.glow; ctx.shadowBlur = s * 0.5; }
    if (p.stroke) { ctx.lineWidth = s * 0.18; ctx.lineJoin = 'round'; ctx.strokeStyle = p.stroke; ctx.strokeText(texts[i], x, 0); }
    ctx.fillStyle = active && p.active ? p.active : p.fill;
    ctx.fillText(texts[i], x, 0);
    ctx.restore();
    x += widths[i] + gap;
  });
  ctx.restore();
}

// --- preview loop ---
// shortcut: rAF pauses in background tabs, so export needs the tab visible; a WebCodecs + muxer pipeline would lift that.
function frame() {
  if (video.readyState >= 2) {
    if (!video.paused) {
      const to = skipCut(video.currentTime, cuts);
      if (to !== video.currentTime) video.currentTime = Math.min(to, video.duration);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    drawCaption(video.currentTime);
    $('seek').value = video.currentTime;
    $('time').textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

$('play').onclick = () => (video.paused ? video.play() : video.pause());
video.onplay = () => ($('play').textContent = 'Pause');
video.onpause = () => ($('play').textContent = 'Play');
$('seek').oninput = () => (video.currentTime = +$('seek').value);

// --- export ---
$('srt').onclick = () => download(new Blob([toSrt(lines)], { type: 'text/plain' }), file.name.replace(/\.[^.]+$/, '') + '.srt');

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
  const type = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  if (!type) return status("This browser can't record video. Try Chrome or Edge.");
  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...audioDest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8e6 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    exporting = false;
    $('export').disabled = $('play').disabled = $('seek').disabled = false;
    download(new Blob(chunks, { type }), file.name.replace(/\.[^.]+$/, '') + '-murmurcut.' + (type.includes('mp4') ? 'mp4' : 'webm'));
    status('Export finished.');
  };

  exporting = true;
  $('export').disabled = $('play').disabled = $('seek').disabled = true;
  video.pause();
  video.currentTime = skipCut(0, cuts);
  await new Promise(r => video.addEventListener('seeked', r, { once: true }));
  video.addEventListener('ended', () => rec.stop(), { once: true });
  rec.start(1000);
  status('Exporting in real time. Keep this tab open and visible…');
  await video.play();
};
