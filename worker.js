// Runs Whisper off the main thread so the UI stays responsive.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';

const asrs = {};
const opts = { chunk_length_s: 30, stride_length_s: 5 };
const progress_callback = p => p.status === 'progress' && self.postMessage({ type: 'progress', file: p.file, progress: p.progress });

// WebGPU is roughly 10x faster than the CPU path; fall back when the browser or GPU lacks it.
async function load(model) {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
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

// data: { audio, language, model, translate }
// Replies with word chunks for captions, plus English sentence segments to pick b-roll from when the captions are not English.
self.onmessage = async ({ data: { audio, language, model, translate } }) => {
  try {
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
