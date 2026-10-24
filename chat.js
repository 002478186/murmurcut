// "Chat to edit": turns a typed instruction into edit actions. Plain pattern matching, so it is instant,
// works offline and never guesses wildly; anything it doesn't recognise gets a list of things to try.

// "0:12", "1:05", "12s", "12 sec", "12 seconds", or "here"/"now" (the playhead).
function timeIn(text, now) {
  const s = text.replace(/\bfor\s+\d+(?:\.\d+)?\s*(?:s|sec|secs|second|seconds)?\b/, ''); // "for 2s" is a length, not a time
  const clock = s.match(/\b(\d+):(\d{1,2}(?:\.\d+)?)\b/);
  if (clock) return +clock[1] * 60 + +clock[2];
  const secs = s.match(/\b(?:at|from)\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)?\b/) ?? s.match(/\b(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/);
  if (secs) return +secs[1];
  if (/\b(here|now|this point|the playhead)\b/.test(s)) return now;
  return null;
}
const durIn = s => +(s.match(/\bfor\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)?\b/)?.[1] ?? 0) || null;
const on = s => !/\b(off|no|stop|don'?t|disable|keep)\b/.test(s);

const RATIOS = [
  [/\b9\s*[:x/]\s*16\b|\bvertical\b|\breels?\b|\bshorts\b|\btiktok\b|\bstory\b/, '9:16'],
  [/\b4\s*[:x/]\s*5\b|\bportrait\b|\binstagram post\b/, '4:5'],
  [/\b1\s*[:x/]\s*1\b|\bsquare\b/, '1:1'],
  [/\b16\s*[:x/]\s*9\b|\blandscape\b|\bwide(screen)?\b|\byoutube\b|\bhorizontal\b/, '16:9'],
  [/\boriginal\b/, 'original'],
];

function parseClause(raw, ctx) {
  const s = raw.toLowerCase().trim();
  if (!s) return null;
  if (/^(undo|go back|revert)\b/.test(s)) return { type: 'undo' };
  if (/^(export|render|download)( the)?( video)?$/.test(s)) return { type: 'export' };

  // replace X with Y  (keeps the user's casing for the replacement)
  const rep = raw.match(/\b(?:replace|change|swap)\s+["']?(.+?)["']?\s+(?:with|to|for)\s+["']?(.+?)["']?\s*$/i);
  if (rep && !/\bstyle\b|\bcaptions?\b\s+(to|with)\s+\w+$/i.test(raw.trim().slice(0, rep.index + 8))) return { type: 'replace', from: rep[1], to: rep[2] };

  const preset = Object.entries(ctx.presets).find(([key, name]) => new RegExp(`\\b(${key}|${name.toLowerCase()})\\b`).test(s));
  if (preset && /\b(style|look|captions?|font|use|make|switch|try|change)\b/.test(s)) return { type: 'style', preset: preset[0] };

  if (/\b(fillers?|ums?|uhs?|umms?)\b/.test(s)) return { type: 'fillers', on: on(s) && !/\bkeep\b/.test(s) };
  if (/\b(pauses?|silences?|silent|dead air|gaps?)\b/.test(s)) {
    const sec = +(s.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b/)?.[1] ?? 0) || null;
    return { type: 'silences', on: on(s) && !/\bkeep\b/.test(s), sec };
  }

  for (const [re, value] of RATIOS) if (re.test(s) && /\b(make|resize|ratio|format|crop|turn|aspect|scale|for|to|size)\b|^\S+$/.test(s)) return { type: 'ratio', value };
  if (/\b(fit|letterbox|show (the )?whole)\b/.test(s)) return { type: 'fit', value: 'fit' };
  if (/\b(fill|crop to fill)\b/.test(s)) return { type: 'fit', value: 'fill' };

  if (/\bsplit[- ]?screen\b|\bsplit layout\b/.test(s)) return { type: 'layout', value: on(s) ? 'split' : 'full' };
  if (/\bfull[- ]?screen\b/.test(s) && /\b(layout|make|use|switch|go)\b/.test(s)) return { type: 'layout', value: 'full' };

  if (/\bzooms?\b|\bpunch(?:[- ]?in)?\b/.test(s)) {
    if (/\b(remove|delete|clear|no)\b.*\bzooms?\b/.test(s)) return { type: 'clearZooms' };
    if (/\bauto\b|\bevery\b/.test(s)) return { type: 'autoZoom', on: on(s) };
    const at = timeIn(s, ctx.now);
    return { type: 'zoom', at: at ?? ctx.now, dur: durIn(s) ?? 1.5, amount: /\b(big|strong|more|hard)\b/.test(s) ? 1.35 : 1.2 };
  }

  if (/\b(b-?roll|photo|image|picture|pic)\b/.test(s)) {
    if (/\b(remove|delete|clear|no)\b/.test(s) && /\b(all|every)\b/.test(s)) return { type: 'clearBroll' };
    const q = raw.match(/\b(?:of|showing|with)\s+(?:an?\s+|the\s+)?(.+?)(?:\s+(?:at|here|now|for)\b.*)?$/i)?.[1]?.trim();
    return { type: 'broll', at: timeIn(s, ctx.now) ?? ctx.now, dur: durIn(s) ?? 2.5, query: q ?? '' };
  }

  if (/\b(caps|capital|upper ?case|all caps)\b/.test(s)) return { type: 'upper', on: on(s) && !/\blower/.test(s) };
  if (/\blower ?case\b/.test(s)) return { type: 'upper', on: false };
  if (/\b(bigger|larger|increase|grow)\b/.test(s)) return { type: 'size', delta: /\b(much|lot|way)\b/.test(s) ? 2 : 1 };
  if (/\b(smaller|tinier|decrease|shrink)\b/.test(s)) return { type: 'size', delta: /\b(much|lot|way)\b/.test(s) ? -2 : -1 };
  if (/\b(top|upper part)\b/.test(s)) return { type: 'pos', value: 18 };
  if (/\b(middle|center|centre)\b/.test(s)) return { type: 'pos', value: 50 };
  if (/\bbottom\b/.test(s)) return { type: 'pos', value: 80 };
  if (/\b(higher|up)\b/.test(s) && /\bcaptions?|text|move\b/.test(s)) return { type: 'pos', delta: -8 };
  if (/\b(lower|down)\b/.test(s) && /\bcaptions?|text|move\b/.test(s)) return { type: 'pos', delta: 8 };

  if (/\b(noise|denoise|background sound|hum|hiss)\b/.test(s)) return { type: 'denoise', on: on(s) };
  if (/\b(loudness|volume|level|louder)\b/.test(s)) return { type: 'level', on: on(s) };
  return null;
}

// ctx: { presets: { key: displayName }, now: playhead seconds }. Several instructions can be joined with
// "and", "then", commas or semicolons. Returns the actions it understood and the parts it didn't.
export function parseCommand(text, ctx) {
  const parts = text.split(/\s*(?:;|,|\bthen\b|\band then\b|\band\b(?!\s+\d))\s*/i).filter(p => p.trim());
  const actions = [], unknown = [];
  for (const p of parts) {
    const a = parseClause(p, ctx);
    a ? actions.push(a) : unknown.push(p.trim());
  }
  return { actions, unknown };
}

export const CHAT_EXAMPLES = ['remove the ums', 'zoom in at 0:12', 'style beast', 'make it square', 'captions bigger', 'add a photo of mumbai here', 'replace capsule with Kapso', 'undo'];
