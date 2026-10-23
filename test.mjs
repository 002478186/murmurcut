import assert from 'node:assert/strict';
import { toWords, groupWords, editLine, cutRanges, skipCut, toSrt } from './captions.js';

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

console.log('ok');
