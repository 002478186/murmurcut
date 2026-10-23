import assert from 'node:assert/strict';
import { toWords, groupWords, editLine, cutRanges, skipCut, toSrt, pickKeyword, planBroll, toSegments, emphasisIndex, topicOf } from './captions.js';

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

assert.equal(topicOf(toWords('Modern Warfare 4 Man, look at this, Mumbai Mission'.split(' ').map((text, i) => ({ text, timestamp: [i, i + 1] })))), 'Modern Warfare');

console.log('ok');
