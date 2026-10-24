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
    const prev = cur?.words.at(-1);
    if (!cur || cur.words.length >= maxWords || w.start - cur.end > maxGap || /[.?!]$/.test(prev.text) || prev.br) {
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

// Swap Whisper's words for the script that was actually read, keeping Whisper's timing. Script word i takes the
// slot at the same relative position in the transcript, so a translated or misheard transcript still times it well.
// A line break in the script ends a caption line (`br`).
export function alignScript(script, words) {
  const rows = script.split('\n').map(r => r.trim().split(/\s+/).filter(Boolean)).filter(r => r.length);
  const toks = rows.flatMap(r => r.map((text, i) => ({ text, br: i === r.length - 1 })));
  if (!toks.length || !words.length) return [];
  const n = words.length;
  const at = x => {
    const k = Math.min(Math.floor(x), n - 1);
    return words[k].start + (words[k].end - words[k].start) * Math.min(1, x - k);
  };
  // Silences Whisper heard. A script word that straddles one moves to the side it mostly sits on,
  // so the pause stays empty and "remove pauses" can still find it.
  const gaps = words.slice(1).map((w, k) => [words[k].end, w.start]).filter(([a, b]) => b - a > 0.3);
  return toks.map(({ text, br }, i) => {
    let start = at((i / toks.length) * n), end = at(((i + 1) / toks.length) * n);
    for (const [a, b] of gaps) {
      if (start < a && end > b) {
        if (a - start >= end - b) end = a;
        else start = b;
      }
    }
    return { text, br, start, end: Math.max(start + 0.05, end), cut: false };
  });
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Replace a misheard word or phrase in every caption line ("Capsule" -> "Kapso"). Whole words only, any case.
// Returns how many were replaced.
export function replaceText(lines, find, repl) {
  if (!find.trim()) return 0;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(find.trim())}(?![\\p{L}\\p{N}])`, 'giu');
  let n = 0;
  for (const l of lines) {
    const text = l.words.map(w => w.text).join(' ');
    const next = text.replace(re, () => (n++, repl.trim()));
    if (next !== text) editLine(l, next);
  }
  return n;
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

// Source time -> time in the cut video, and back. Cuts are sorted and merged, as cutRanges returns them.
export function toOutput(t, cuts) {
  let removed = 0;
  for (const [a, b] of cuts) {
    if (t <= a) break;
    removed += Math.min(t, b) - a;
  }
  return t - removed;
}
export function toSource(o, cuts) {
  let t = o;
  for (const [a, b] of cuts) {
    if (t < a) break;
    t += b - a;
  }
  return t;
}

// A second video laid over a stretch of the timeline, its own time running from clip.from to clip.to.
// Splitting at t keeps both halves' footage continuous, so a screen recording can be matched to each step.
export function splitClip(item, t) {
  if (t <= item.start + 0.1 || t >= item.end - 0.1) return [item];
  const at = clipTime(item, t);
  return [
    { ...item, end: t, clip: { ...item.clip, to: at } },
    { ...item, start: t, clip: { ...item.clip, from: at } },
  ];
}
// Where in the clip to be at timeline time t, clamped to its range.
export const clipTime = (item, t) =>
  item.clip.from + Math.min(1, Math.max(0, (t - item.start) / (item.end - item.start))) * (item.clip.to - item.clip.from);

const STOP = new Set(('a an the and or but so if then than that this these those there here it its it\'s is are was were be been being am ' +
  'i me my we our you your he she him her they them their what which who whom when where why how all any both each few more most ' +
  'other some such no not only own same too very can will just should now also really actually like thing things stuff get got ' +
  'do does did done doing have has had having to of in on at by for with about from up down out over into after before again ' +
  'one two lot lots way much many even still well yeah okay ok guys hey welcome back today let let\'s going gonna want know think ' +
  'say said see look make made come came give take good great new old because while during per mean means kind sort around ' +
  'after somewhere tell thank thanks comment man little').split(' '));

// Scores words by how picturable they are: names, acronyms (PS5, DMZ) and long nouns beat filler.
// Returns { word, score, idx, num } for the best one in the whitespace-split text, or null.
// `num` is a number said right next to it ("Metacritic gave 84"), for text cards.
function scoreKeyword(text) {
  const toks = text.split(/\s+/).map(t => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  const ok = t => t && !STOP.has(t.toLowerCase());
  const isProper = t => ok(t) && /^\p{Lu}/u.test(t);
  let best = null;
  toks.forEach((t, i) => {
    if (!ok(t) || (t.length < 3 && !/\d/.test(t)) || /^\d+$/.test(t)) return;
    let word = t, score = Math.min(t.length, 10);
    if (/^\p{Lu}[\p{Lu}\d]+$/u.test(t)) score += 8;
    else if (isProper(t)) score += 6;
    if (/\d/.test(t) && /\p{L}/u.test(t)) score += 6;
    let j = i;
    if (isProper(t) && isProper(toks[i + 1] ?? '')) [word, score, j] = [`${t} ${toks[i + 1]}`, score + 3, i + 1];
    // Keep a sequel number with its name: "Modern Warfare 4" is a game, "Modern Warfare" is a military term.
    if (j > i && /^\d{1,4}$/.test(toks[j + 1] ?? '')) [word, j] = [`${word} ${toks[j + 1]}`, j + 1];
    if (!best || score > best.score) best = { word, score, idx: i, end: j };
  });
  if (best) best.num = toks.slice(Math.max(0, best.idx - 2), best.end + 4).find((t, k) => /^\d+$/.test(t) && !best.word.includes(t));
  return best;
}

// The word or proper-noun phrase most worth illustrating; null if nothing is.
export const pickKeyword = text => scoreKeyword(text)?.word ?? null;

// What the whole video is about, judged from its first sentence or so: creators name the topic up front,
// and a wider window lets a later word ("Professional") outscore the real topic.
export const topicOf = words => pickKeyword(words.slice(0, 15).map(w => w.text).join(' '));

// The kind of thing a Wikipedia short description names: "2026 video game" -> "video game",
// "American review aggregation website" -> "aggregation website", "Capital of Maharashtra, India" -> "Capital".
export const domainOf = description =>
  (description ?? '').split(/,| of | by | in | who | that /)[0].replace(/\b\d{4}s?\b/g, '').trim().split(/\s+/).slice(-2).join(' ');

// Websites, companies, scores: things a photo can't honestly show, so their name (and number) works better as text.
const ABSTRACT = /\b(website|web site|company|corporation|organi[sz]ation|aggregator|platform|service|software|app|application|brand|magazine|publisher|award|index|rating|search engine|social network)\b/i;
export const isAbstract = description => ABSTRACT.test(description ?? '');

// Tidies a language model's search: first line, no punctuation or repeats, no topic words (they drown out the scene), 4 words max.
export function cleanQuery(text, topic = '') {
  const skip = new Set(topic.toLowerCase().split(/\s+/));
  const seen = new Set();
  return (text ?? '').split('\n')[0].toLowerCase().replace(/[^\p{L}\p{N}$\s-]/gu, ' ').split(/\s+/)
    .filter(w => w && !skip.has(w) && !seen.has(w) && seen.add(w)).slice(0, 4).join(' ');
}

// A word a small model repeats in most of a video's searches is a tic, not content ("skyline task", "cost task").
export function dropCommon(queries) {
  const count = new Map();
  for (const q of queries) for (const w of new Set(q.split(' ').filter(Boolean))) count.set(w, (count.get(w) ?? 0) + 1);
  const limit = Math.max(2, queries.length / 2);
  return queries.map(q => q.split(' ').filter(w => (count.get(w) ?? 0) <= limit).join(' '));
}

export const BROLL_MODES = ['full', 'card', 'blur'];

// One visual per sentence that has something to show. The strongest keywords win when two would sit too close,
// so the speaker stays on screen between them. A segment with `words` places the visual on the keyword itself;
// otherwise its time is estimated from where the keyword sits in the sentence.
export function planBroll(segments, { minGap = 2.5, dur = 2.5, start = 1.5 } = {}) {
  const cands = [];
  for (const s of segments) {
    const k = scoreKeyword(s.text);
    if (!k) continue;
    const n = s.text.split(/\s+/).length;
    const at = s.words?.[k.idx]?.start ?? s.start + ((s.end - s.start) * k.idx) / n;
    const from = Math.max(s.start, Math.min(at - 0.3, s.end - 0.8));
    const end = Math.min(s.end, from + dur);
    const label = k.num ? `${k.word} ${k.num}` : k.word;
    if (from >= start && end - from >= 0.75) cands.push({ start: from, end, query: k.word, label, context: s.text, score: k.score });
  }
  const picked = [];
  for (const c of cands.sort((a, b) => b.score - a.score))
    if (picked.every(p => c.start >= p.end + minGap || c.end + minGap <= p.start)) picked.push(c);
  return picked
    .sort((a, b) => a.start - b.start)
    .map(({ score, ...c }, i) => ({ ...c, mode: BROLL_MODES[i % BROLL_MODES.length] }));
}

// Sentence-sized segments from word timings.
export const toSegments = words =>
  groupWords(words, { maxWords: 14, maxGap: 1 }).map(l => ({ start: l.start, end: l.end, words: l.words, text: l.words.map(w => w.text).join(' ') }));

// Index of the word to emphasise in a line: the keyword if present, else the longest word.
export function emphasisIndex(words) {
  const k = pickKeyword(words.map(w => w.text).join(' '))?.split(' ')[0];
  const clean = t => t.replace(/[^\p{L}\p{N}]/gu, '');
  const i = k ? words.findIndex(w => clean(w.text) === k) : -1;
  if (i >= 0) return i;
  return words.reduce((b, w, j) => (clean(w.text).length > clean(words[b].text).length ? j : b), 0);
}

const ts = s => {
  const ms = Math.round(s * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

// Timings follow the cut video when cuts are given, so the file matches the export.
export function toSrt(lines, cuts = []) {
  return lines
    .map(l => ({ ...l, words: l.words.filter(w => !w.cut) }))
    .filter(l => l.words.length)
    .map((l, i) => `${i + 1}\n${ts(toOutput(l.start, cuts))} --> ${ts(toOutput(l.end, cuts))}\n${l.words.map(w => w.text).join(' ')}\n`)
    .join('\n');
}
