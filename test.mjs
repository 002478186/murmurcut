import assert from 'node:assert/strict';
import { toWords, groupWords, editLine, cutRanges, skipCut, toSrt, pickKeyword, planBroll, toSegments, emphasisIndex, topicOf, isAbstract, cleanQuery, dropCommon, domainOf, alignScript, replaceText, toOutput, toSource, splitClip, clipTime } from './captions.js';

const words = toWords([
  { text: ' Hello', timestamp: [0, 0.4] },
  { text: ' there.', timestamp: [0.4, 0.8] },
  { text: ' Um', timestamp: [0.9, 1.1] },
  { text: ' so', timestamp: [1.1, 1.3] },
  { text: ' today', timestamp: [3.0, 3.4] },
  { text: ' we', timestamp: [3.4, null] },
]);
assert.equal(words[5].end, 3.4 + 0.3);

const lines = groupWords(words);
assert.deepEqual(lines.map(l => l.words.map(w => w.text).join(' ')), ['Hello there.', 'Um so', 'today we']);

editLine(lines[0], 'Hi there.');
assert.equal(lines[0].words[0].text, 'Hi');
assert.equal(lines[0].words[0].end, 0.4);
editLine(lines[0], 'Hi over there');
assert.equal(lines[0].words.length, 3);
assert.ok(Math.abs(lines[0].words[2].end - 0.8) < 1e-9);

const cuts = cutRanges(words, { fillers: true, silence: 1 });
assert.deepEqual(cuts, [[0.9, 1.1], [1.45, 2.85]]);
assert.equal(skipCut(1.0, cuts), 1.1);
assert.equal(skipCut(2.0, cuts), 2.85);
assert.equal(skipCut(0.5, cuts), 0.5);

words[0].cut = true;
const srt = toSrt(groupWords(words));
assert.match(srt, /^1\n00:00:00,000 --> 00:00:00,800\nthere\.\n/);

assert.equal(pickKeyword('So the Mumbai mission has gone dark'), 'Mumbai');
assert.equal(pickKeyword('the PS5 has 120Hz support'), 'PS5');
assert.equal(pickKeyword('Metacritic gave it 84'), 'Metacritic');
assert.equal(pickKeyword('we played Black Ops all night'), 'Black Ops');
assert.equal(pickKeyword('yeah so it is really good'), null);

const plan = planBroll([
  { start: 0, end: 2, text: 'Hey guys welcome back' },
  { start: 2, end: 5, text: 'The Mumbai mission is wild' },
  { start: 5, end: 8, text: 'and the PS5 version runs well' },
  { start: 10, end: 11, text: 'price is 6000 rupees in India' },
  { start: 12, end: 12.5, text: 'DMZ' },
], { minGap: 2 });
const r1 = n => Math.round(n * 10) / 10;
// PS5 outscores Mumbai, which sits too close to it; DMZ is too short to show.
assert.deepEqual(plan.map(p => [r1(p.start), r1(p.end), p.query, p.mode]), [[5.7, 8, 'PS5', 'full'], [10.2, 11, 'India', 'card']]);
// With word timings the visual lands on the keyword itself.
const segs = toSegments(toWords([{ text: ' we', timestamp: [2, 2.4] }, { text: ' bought', timestamp: [2.4, 3] }, { text: ' a', timestamp: [3, 3.1] }, { text: ' PS5', timestamp: [3.1, 3.6] }, { text: ' today', timestamp: [3.6, 6] }]));
assert.equal(r1(planBroll(segs)[0].start), 2.8);

assert.equal(emphasisIndex(toWords([{ text: ' the', timestamp: [0, 1] }, { text: ' Mumbai', timestamp: [1, 2] }, { text: ' mission', timestamp: [2, 3] }])), 1);
assert.equal(emphasisIndex(toWords([{ text: ' so', timestamp: [0, 1] }, { text: ' really', timestamp: [1, 2] }])), 1);
assert.equal(toSegments(words.filter(w => !w.cut)).length, 3);

assert.equal(topicOf(toWords('Modern Warfare 4 Man, look at this, Mumbai Mission'.split(' ').map((text, i) => ({ text, timestamp: [i, i + 1] })))), 'Modern Warfare 4');

assert.equal(pickKeyword('Modern Warfare 4 Man, look at this'), 'Modern Warfare 4');
const meta = planBroll([{ start: 3, end: 6, text: 'After review, Metacritic gave 84, campaign' }])[0];
assert.deepEqual([meta.query, meta.label, meta.context], ['Metacritic', 'Metacritic 84', 'After review, Metacritic gave 84, campaign']);

assert.ok(isAbstract('American review aggregator website'));
assert.ok(!isAbstract('Home video game console by Sony'));
assert.ok(!isAbstract('Capital of Maharashtra, India'));

assert.equal(cleanQuery('"DMZ mode multiplayer speed games weekend-game DMZ"'), 'dmz mode multiplayer speed');
assert.equal(cleanQuery('modern warfare skyline mumbai\n\nNote: -', 'Modern Warfare 4'), 'skyline mumbai');
assert.equal(cleanQuery(undefined), '');
assert.deepEqual(dropCommon(['skyline task skyland', 'currency task cost', 'task cost india canada', 'game mode']), ['skyline skyland', 'currency cost', 'cost india canada', 'game mode']);

// The real opening of the test clip: the topic is the game, not the later translation slip.
const opening = 'Modern Warfare 4 Man, look at this, Mumbai Mission, gone dark, fans have done this building spot. Professional confirm is not there, but Skyline is for sure Mumbai.';
assert.equal(topicOf(toWords(opening.split(' ').map((text, i) => ({ text, timestamp: [i, i + 1] })))), 'Modern Warfare 4');
assert.equal(domainOf('2026 video game'), 'video game');
assert.equal(domainOf('Capital of Maharashtra, India'), 'Capital');
assert.equal(domainOf('Person who is paid to undertake a specialized set of tasks'), 'Person');
assert.equal(domainOf(undefined), '');

// Paste-your-script: the real script's words take the misheard transcript's timing, script lines become caption lines.
{
  const heard = toWords(['Copy', 'Piss', 'Burn', 'and', 'Cloud', 'Code', 'in', 'WhatsApp'].map((text, i) => ({ text, timestamp: [i * 0.5, i * 0.5 + 0.4] })));
  const aligned = alignScript('Copy paste band karo.\nClaude ko WhatsApp do.', heard);
  assert.deepEqual(aligned.map(w => w.text), ['Copy', 'paste', 'band', 'karo.', 'Claude', 'ko', 'WhatsApp', 'do.']);
  assert.equal(aligned[0].start, 0);
  assert.ok(Math.abs(aligned.at(-1).end - 3.9) < 1e-9);
  assert.ok(aligned.every((w, i) => i === 0 || w.start >= aligned[i - 1].start));
  assert.deepEqual(groupWords(aligned, { maxWords: 6 }).map(l => l.words.length), [4, 4]); // the line break wins over maxWords
  // A shorter script spreads over the same span instead of bunching at the start.
  const short = alignScript('one two', heard);
  assert.equal(short[1].start, 2);
  assert.deepEqual(alignScript('', heard), []);
  // Pauses survive: no script word may stretch across a silence Whisper heard, or "remove pauses" finds nothing.
  const paused = toWords(['a', 'b', 'c', 'd'].map((text, i) => ({ text, timestamp: i < 2 ? [i, i + 1] : [i + 3, i + 4] })));
  const spread = alignScript('one two three four five', paused);
  const gaps = spread.slice(1).map((w, i) => w.start - spread[i].end);
  assert.ok(Math.max(...gaps) >= 2.9, `the 3 s pause is kept (largest gap ${Math.max(...gaps)})`);
  assert.equal(cutRanges(spread, { silence: 1 }).length, 1);
  assert.deepEqual(alignScript('x', []), []);
}

// Find and replace: whole words, any case, timings kept when the word count matches.
{
  const ls = groupWords(toWords(['Log', 'in', 'to', 'Capsule.', 'Capsule.com', 'capsule'].map((text, i) => ({ text, timestamp: [i, i + 1] }))), { maxWords: 9 });
  assert.equal(replaceText(ls, 'capsule', 'Kapso'), 3); // "Capsule.com" becomes "Kapso.com" too
  assert.equal(ls.flatMap(l => l.words.map(w => w.text)).join(' '), 'Log in to Kapso. Kapso.com Kapso');
  assert.equal(ls[0].words[3].start, 3);
  assert.equal(replaceText(ls, '  ', 'x'), 0);
  assert.equal(replaceText(ls, 'C++', 'x'), 0); // regex characters are literal
}

// Cut-aware times: the SRT and the export use the cut video's clock.
{
  const cs = [[1, 2], [3, 3.5]];
  assert.equal(toOutput(0.5, cs), 0.5);
  assert.equal(toOutput(1.5, cs), 1);
  assert.equal(toOutput(2.5, cs), 1.5);
  assert.equal(toOutput(4, cs), 2.5);
  for (const t of [0, 0.5, 2, 2.9, 3.5, 4, 7]) assert.ok(Math.abs(toSource(toOutput(t, cs), cs) - t) < 1e-9, `round trip ${t}`);
  assert.match(toSrt([{ start: 2.5, end: 4, words: [{ text: 'hi', cut: false }] }], cs), /00:00:01,500 --> 00:00:02,500/);
}

// Second-video clips: splitting keeps the footage continuous; clip time follows the timeline.
{
  const item = { start: 0, end: 30, clip: { from: 0, to: 10 } };
  const [a, b] = splitClip(item, 15);
  assert.deepEqual([a.end, a.clip.to, b.start, b.clip.from, b.clip.to], [15, 5, 15, 5, 10]);
  assert.equal(splitClip(item, 0.05).length, 1);
  assert.equal(clipTime(item, 3), 1);
  assert.equal(clipTime(item, 99), 10);
}

// Export audio: cuts remove exactly their samples and fade the joins; levelling hits the target without clipping.
{
  const { cutAudio, levelAudio } = await import('./audio.js');
  const rate = 1000;
  const ch = new Float32Array(3000).fill(0.5);
  const [out] = cutAudio([ch], [[1, 2]], rate);
  assert.equal(out.length, 2000);
  assert.equal(out[500], 0.5);
  assert.ok(out[999] < 0.1 && out[1000] < 0.1, 'the join is faded');
  assert.equal(out[0], 0.5, 'the very start is not faded');
  assert.equal(cutAudio([ch], [], rate)[0].length, 3000);
  assert.equal(cutAudio([ch], [[2.5, 9]], rate)[0].length, 2500, 'a cut past the end is clamped');
  const quiet = [Float32Array.from({ length: 4000 }, (_, i) => (i < 2000 ? 0.01 * Math.sin(i) : 0))];
  levelAudio(quiet, rate, -16, -1);
  assert.ok(Math.max(...quiet[0].map(Math.abs)) <= 10 ** (-1 / 20) + 1e-6, 'peaks stay under -1 dBFS');
  assert.ok(Math.max(...quiet[0].map(Math.abs)) > 0.1, 'quiet speech is lifted');
  assert.equal(levelAudio([new Float32Array(100)], rate), 1, 'silence is left alone');
}

// Dead air before the first word and after the last is cut too.
const late = toWords([{ text: ' hi', timestamp: [3, 3.5] }, { text: ' there', timestamp: [3.5, 4] }]);
assert.deepEqual(cutRanges(late, { silence: 0.8, duration: 9 }), [[0, 2.85], [4.15, 9]]);
assert.deepEqual(cutRanges(late, { silence: 0.8 }), [[0, 2.85]]); // no duration: the end is left alone
assert.equal(emphasisIndex(toWords([{ text: ' the', timestamp: [0, 1] }, { text: " PS5's", timestamp: [1, 2] }, { text: ' controller', timestamp: [2, 3] }])), 1);

console.log('ok');
