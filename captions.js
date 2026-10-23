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

// What the whole video is about, judged from its opening: creators name the topic up front.
export const topicOf = words => pickKeyword(words.slice(0, 30).map(w => w.text).join(' '));

// Websites, companies, scores: things a photo can't honestly show, so their name (and number) works better as text.
const ABSTRACT = /\b(website|web site|company|corporation|organi[sz]ation|aggregator|platform|service|software|app|application|brand|magazine|publisher|award|index|rating|search engine|social network)\b/i;
export const isAbstract = description => ABSTRACT.test(description ?? '');

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

// shortcut: SRT keeps original timings, so cuts are not reflected; fine for the uncut video.
export function toSrt(lines) {
  return lines
    .map(l => ({ ...l, words: l.words.filter(w => !w.cut) }))
    .filter(l => l.words.length)
    .map((l, i) => `${i + 1}\n${ts(l.start)} --> ${ts(l.end)}\n${l.words.map(w => w.text).join(' ')}\n`)
    .join('\n');
}
