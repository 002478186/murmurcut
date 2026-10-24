// Runs Whisper off the main thread so the UI stays responsive.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';

const asrs = {};
const opts = { chunk_length_s: 30, stride_length_s: 5 };
const progress_callback = p => p.status === 'progress' && self.postMessage({ type: 'progress', file: p.file, progress: p.progress });

// WebGPU is roughly 10x faster than the CPU path; fall back when the browser or GPU lacks it.
// shortcut: iPhones always take the CPU path, since Safari kills a tab that runs out of memory and WebGPU adds to it; revisit when tested on a real iPhone.
const gpu = () => (/iPhone|iPod/.test(navigator.userAgent) ? null : navigator.gpu?.requestAdapter().catch(() => null));
async function load(model) {
  const adapter = await gpu();
  if (adapter) {
    try {
      const encoder_model = adapter.features.has('shader-f16') ? 'fp16' : 'fp32';
      const asr = await pipeline('automatic-speech-recognition', model, { device: 'webgpu', dtype: { encoder_model, decoder_model_merged: 'q4' }, progress_callback });
      return { asr, gpu: true };
    } catch (e) {
      console.warn('WebGPU unavailable, using the CPU:', e.message);
    }
  }
  return { asr: await pipeline('automatic-speech-recognition', model, { progress_callback }), gpu: false };
}

// A 23 MB sentence-meaning model, used to rank b-roll photos by how well they fit what was said.
let embedder;
async function rank({ id, queries, texts }) {
  try {
    embedder ??= await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    const vecs = (await embedder([...queries, ...texts], { pooling: 'mean', normalize: true })).tolist();
    const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
    const q = vecs.slice(0, queries.length);
    // One similarity row per query, against every text.
    self.postMessage({ type: 'ranked', id, scores: q.map(v => vecs.slice(queries.length).map(t => dot(v, t))) });
  } catch (e) {
    self.postMessage({ type: 'ranked', id, error: e.message });
  }
}

// A small language model that reads a sentence and writes the photo search a person would type.
const LLM = 'onnx-community/Qwen2.5-0.5B-Instruct';
let llm;
// Big models don't fit together on a modest laptop: keep only the one about to run.
async function free(keep) {
  if (keep !== 'asr') for (const k of Object.keys(asrs)) { await asrs[k].asr.dispose?.(); delete asrs[k]; }
  if (keep !== 'llm' && llm) { await (await llm).dispose?.(); llm = null; }
  if (keep !== 'kokoro' && kokoro) { await (await kokoro.catch(() => null))?.model?.dispose?.(); kokoro = null; }
  for (const k of Object.keys(dubbers)) if (k !== keep) { await dubbers[k].tr?.dispose?.(); await dubbers[k].tts.dispose?.(); delete dubbers[k]; }
}
async function loadLLM() {
  const adapter = await gpu();
  if (adapter) {
    try {
      return await pipeline('text-generation', LLM, { device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'q4f16' : 'q4', progress_callback });
    } catch (e) {
      console.warn('WebGPU unavailable for the language model, using the CPU:', e.message);
    }
  }
  return pipeline('text-generation', LLM, { dtype: 'q4', progress_callback }); // q8 builds of this model produce gibberish
}

// Worked examples teach the small model the shape of a good answer better than instructions alone.
const SHOTS = [
  ['a smartphone', 'The battery easily lasts two days now.', 'phone battery charging'],
  ['travel', 'We had the best fish curry right next to the beach.', 'fish curry beach'],
  ['a video game', 'Ultimate Team mode is still the most fun online.', 'friends playing football video game'],
];
async function suggest({ id, domain, sentences }) {
  try {
    // Whisper is done by now; free it so both models never sit in memory together.
    await free('llm');
    llm ??= await loadLLM();
    const queries = [];
    for (const s of sentences) {
      const messages = [
        { role: 'system', content: 'You choose stock photos for short videos. Reply with only a photo search of 2 to 4 words: something a camera can photograph that shows the sentence, read in the context of the video topic.' },
        ...SHOTS.flatMap(([t, q, a]) => [{ role: 'user', content: `Video topic: ${t}\nSentence: ${q}` }, { role: 'assistant', content: a }]),
        { role: 'user', content: `Video topic: ${domain}\nSentence: ${s}` },
      ];
      const out = await llm(messages, { max_new_tokens: 10, do_sample: false });
      queries.push(out[0].generated_text.at(-1).content);
    }
    self.postMessage({ type: 'suggested', id, queries });
  } catch (e) {
    self.postMessage({ type: 'suggested', id, error: e.message });
  }
}

// Avatar voices: Kokoro (82M parameters, 28 English voices) reading a script, sentence by sentence.
const KOKORO = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';
let kokoro = null;
async function speakText({ id, text, voice }) {
  try {
    await free('kokoro');
    kokoro ??= import(KOKORO).then(({ KokoroTTS }) => KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'wasm', progress_callback }));
    const tts = await kokoro;
    const parts = text.match(/[^.!?\n]+[.!?]*/g)?.map(s => s.trim()).filter(Boolean) ?? [text];
    const chunks = [];
    let rate = 24000;
    for (const [i, s] of parts.entries()) {
      const a = await tts.generate(s, { voice });
      rate = a.sampling_rate;
      chunks.push(a.audio, new Float32Array(Math.round(rate * 0.18))); // a breath between sentences
      self.postMessage({ type: 'progress', progress: ((i + 1) / parts.length) * 100 });
    }
    const pcm = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    chunks.reduce((o, c) => (pcm.set(c, o), o + c.length), 0);
    self.postMessage({ type: 'spoken', id, pcm, rate }, [pcm.buffer]);
  } catch (e) {
    kokoro = null;
    self.postMessage({ type: 'spoken', id, error: e.message });
  }
}

// Dubbing: translate each English sentence (opus-mt), then speak it with Meta's MMS voice for that language.
const dubbers = {};
const DUB_MT = { hin: 'hi', spa: 'es', fra: 'fr', deu: 'de', ara: 'ar' }; // eng is spoken as-is
async function dub({ id, lang, texts }) {
  try {
    await free(lang);
    dubbers[lang] ??= {
      tr: DUB_MT[lang] && (await pipeline('translation', `Xenova/opus-mt-en-${DUB_MT[lang]}`, { progress_callback })),
      tts: await pipeline('text-to-speech', `Xenova/mms-tts-${lang}`, { progress_callback }),
    };
    const { tr, tts } = dubbers[lang];
    const audios = [];
    let rate = 16000;
    for (const [i, t] of texts.entries()) {
      const out = await tts(tr ? (await tr(t))[0].translation_text : t);
      audios.push(out.audio);
      rate = out.sampling_rate;
      self.postMessage({ type: 'progress', progress: ((i + 1) / texts.length) * 100 });
    }
    self.postMessage({ type: 'dubbed', id, audios, rate });
  } catch (e) {
    self.postMessage({ type: 'dubbed', id, error: e.message });
  }
}

// data: { audio, language, model, translate } to transcribe; { type: 'rank' } to score photo descriptions;
// { type: 'suggest' } to write photo searches. Transcription replies with word chunks for captions, plus English
// sentence segments to pick b-roll from when the captions are not English.
self.onmessage = async ({ data }) => {
  if (data.type === 'rank') return rank(data);
  if (data.type === 'suggest') return suggest(data);
  if (data.type === 'dub') return dub(data);
  if (data.type === 'speak') return speakText(data);
  const { audio, language, model, translate } = data;
  try {
    await free('asr'); // e.g. Kokoro, after it spoke an avatar's script
    asrs[model] ??= await load(model);
    const { asr, gpu } = asrs[model];
    const on = gpu ? 'on your GPU' : 'on your CPU, which is slow: a minute of video can take several minutes';
    self.postMessage({ type: 'status', text: `${translate ? 'Translating to English' : 'Transcribing'} ${on}…` });
    const out = await asr(audio, { ...opts, return_timestamps: 'word', language, task: translate ? 'translate' : 'transcribe' });
    let segments = null;
    if (!translate && language !== 'english') {
      self.postMessage({ type: 'status', text: 'Working out what you said, to pick b-roll…' });
      const tr = await asr(audio, { ...opts, return_timestamps: true, language, task: 'translate' });
      segments = tr.chunks.map(c => ({ start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 3, text: c.text.trim() }));
    }
    self.postMessage({ type: 'done', chunks: out.chunks, segments, gpu });
  } catch (e) {
    self.postMessage({ type: 'error', message: e.message });
  }
};
