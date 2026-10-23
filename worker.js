// Runs Whisper off the main thread so the UI stays responsive.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';

let asr;
self.onmessage = async ({ data: { audio, language } }) => {
  try {
    asr ??= await pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
      progress_callback: p => p.status === 'progress' && self.postMessage({ type: 'progress', file: p.file, progress: p.progress }),
    });
    self.postMessage({ type: 'status', text: 'Transcribing…' });
    const out = await asr(audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5, language, task: 'transcribe' });
    self.postMessage({ type: 'done', chunks: out.chunks });
  } catch (e) {
    self.postMessage({ type: 'error', message: e.message });
  }
};
