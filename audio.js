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
