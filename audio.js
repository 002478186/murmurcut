// Pure audio maths for the export: no DOM or Web Audio, so test.mjs can run it in Node.

// Drop the cut ranges (seconds) from each channel. A short fade at every join stops the click a hard cut makes.
export function cutAudio(channels, cuts, rate, fadeMs = 8) {
  const keep = [];
  let from = 0;
  for (const [a, b] of cuts) {
    if (a > from) keep.push([from, a]);
    from = Math.max(from, b);
  }
  const len = channels[0].length;
  if (from * rate < len) keep.push([from, len / rate]);
  const spans = keep.map(([a, b]) => [Math.round(a * rate), Math.min(len, Math.round(b * rate))]).filter(([a, b]) => b > a);
  const total = spans.reduce((s, [a, b]) => s + b - a, 0);
  const fade = Math.round((fadeMs / 1000) * rate);
  return channels.map(ch => {
    const out = new Float32Array(total);
    let o = 0;
    for (const [a, b] of spans) {
      out.set(ch.subarray(a, b), o);
      const n = Math.min(fade, (b - a) >> 1);
      for (let i = 0; i < n; i++) {
        const g = i / n;
        if (o > 0) out[o + i] *= g; // fade in after a join
        if (b < len) out[o + (b - a) - 1 - i] *= g; // fade out before a join
      }
      o += b - a;
    }
    return out;
  });
}

// Linear resampling: plenty for speech and background music.
export function resample(pcm, from, to) {
  if (from === to) return pcm;
  const out = new Float32Array(Math.round((pcm.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const x = (i * from) / to, j = Math.floor(x), f = x - j;
    out[i] = (pcm[j] ?? 0) * (1 - f) + (pcm[j + 1] ?? pcm[j] ?? 0) * f;
  }
  return out;
}

// Loudness per video frame, 0..1, to drive a talking avatar.
export function envelope(pcm, rate, fps = 30) {
  const win = Math.round(rate / fps), out = new Float32Array(Math.ceil(pcm.length / win));
  let max = 1e-6;
  for (let k = 0; k < out.length; k++) {
    let s = 0;
    for (let i = k * win; i < Math.min(pcm.length, (k + 1) * win); i++) s += pcm[i] * pcm[i];
    out[k] = Math.sqrt(s / win);
    max = Math.max(max, out[k]);
  }
  return out.map(v => v / max);
}

// Lay each dubbed line at its start. A line too long for its slot (up to the next line) is sped up to maxSpeed,
// then cut, so lines never talk over each other. clips: [{ start, end, pcm }] at `rate`; returns `seconds` of audio.
export function placeDub(clips, rate, seconds, maxSpeed = 1.4) {
  const out = new Float32Array(Math.round(seconds * rate));
  clips.forEach((c, i) => {
    const slot = Math.max(0.2, (clips[i + 1]?.start ?? seconds) - c.start);
    const speed = Math.min(maxSpeed, Math.max(1, c.pcm.length / rate / slot));
    const pcm = resample(c.pcm, rate * speed, rate).subarray(0, Math.round(slot * rate));
    const at = Math.round(c.start * rate);
    out.set(pcm.subarray(0, Math.max(0, out.length - at)), at);
  });
  return out;
}

// Background music: looped to `length` samples, faded out over the last 2 s, and dipped under the voice
// (sidechain ducking on 50 ms windows) so speech stays clear.
export function bedMusic(music, voice, rate, volume = 0.3, under = 0.35) {
  const out = new Float32Array(voice.length);
  const win = Math.round(rate * 0.05), fade = Math.min(out.length, rate * 2);
  let g = volume;
  for (let i = 0; i < out.length; i += win) {
    let s = 0;
    for (let j = i; j < Math.min(out.length, i + win); j++) s += voice[j] * voice[j];
    const want = Math.sqrt(s / win) > 0.02 ? volume * under : volume;
    g += (want - g) * (want < g ? 0.6 : 0.15); // duck fast, recover slowly
    for (let j = i; j < Math.min(out.length, i + win); j++) out[j] = music[j % music.length] * g * Math.min(1, (out.length - j) / fade);
  }
  return out;
}

// 16-bit mono WAV, so a generated soundtrack can play in an <audio> element.
export function toWav(pcm, rate) {
  const b = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); b.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVEfmt '); b.setUint32(16, 16, true);
  b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, rate, true); b.setUint32(28, rate * 2, true);
  b.setUint16(32, 2, true); b.setUint16(34, 16, true); str(36, 'data'); b.setUint32(40, pcm.length * 2, true);
  pcm.forEach((v, i) => b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true));
  return b.buffer;
}

// Bring speech to a steady loudness: measure the louder half of 50 ms windows (so pauses don't count),
// gain it to targetDb RMS, and keep peaks under peakDb. Works in place; returns the gain applied.
export function levelAudio(channels, rate, targetDb = -16, peakDb = -1) {
  const win = Math.max(1, Math.round(rate * 0.05));
  const rms = [];
  for (let i = 0; i + win <= channels[0].length; i += win) {
    let s = 0;
    for (const ch of channels) for (let j = i; j < i + win; j++) s += ch[j] * ch[j];
    rms.push(Math.sqrt(s / (win * channels.length)));
  }
  rms.sort((a, b) => b - a);
  const loud = rms.slice(0, Math.max(1, rms.length >> 1));
  const level = Math.sqrt(loud.reduce((s, x) => s + x * x, 0) / loud.length);
  if (!level) return 1;
  let peak = 0;
  for (const ch of channels) for (const v of ch) peak = Math.max(peak, Math.abs(v));
  const gain = Math.min(10 ** (targetDb / 20) / level, 10 ** (peakDb / 20) / peak);
  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= gain;
  return gain;
}
