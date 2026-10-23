// Pure caption logic: no DOM, so test.mjs can run it in Node.

export const FILLERS = /^(u+m+|u+h+|erm+|hmm+|a+h+|mm+)$/i;

// Whisper chunks -> [{text, start, end, cut}]
export function toWords(chunks) {
  return chunks
    .map(c => ({ text: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 0.3, cut: false }))
    .filter(w => w.text);
}

// Break on word count, a pause, or sentence end.
export function groupWords(words, { maxWords = 4, maxGap = 0.6 } = {}) {
  const lines = [];
  let cur = null;
  for (const w of words) {
    if (!cur || cur.words.length >= maxWords || w.start - cur.end > maxGap || /[.?!]$/.test(cur.words.at(-1).text)) {
      cur = { start: w.start, end: w.end, words: [] };
      lines.push(cur);
    }
    cur.words.push(w);
    cur.end = w.end;
  }
  return lines;
}

// Keep timings if the word count matches, otherwise spread the new words evenly over the line.
export function editLine(line, text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === line.words.length) {
    line.words.forEach((w, i) => (w.text = tokens[i]));
    return line;
  }
  const step = (line.end - line.start) / Math.max(tokens.length, 1);
  line.words = tokens.map((t, i) => ({ text: t, start: line.start + i * step, end: line.start + (i + 1) * step, cut: false }));
  return line;
}

// Ranges of the timeline to skip: words marked cut, fillers, long silences. Sorted and merged.
export function cutRanges(words, { fillers = false, silence = 0 } = {}) {
  const pad = 0.15;
  const r = [];
  words.forEach((w, i) => {
    if (w.cut || (fillers && FILLERS.test(w.text.replace(/[^\p{L}]/gu, '')))) r.push([w.start, w.end]);
    const next = words[i + 1];
    if (silence > 0 && next && next.start - w.end > silence) r.push([w.end + pad, next.start - pad]);
  });
  r.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of r) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

export function skipCut(t, cuts) {
  const c = cuts.find(([a, b]) => t >= a && t < b);
  return c ? c[1] : t;
}

const ts = s => {
  const ms = Math.round(s * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

// shortcut: SRT keeps original timings, so cuts are not reflected; fine for the uncut video.
export function toSrt(lines) {
  return lines
    .map(l => ({ ...l, words: l.words.filter(w => !w.cut) }))
    .filter(l => l.words.length)
    .map((l, i) => `${i + 1}\n${ts(l.start)} --> ${ts(l.end)}\n${l.words.map(w => w.text).join(' ')}\n`)
    .join('\n');
}
