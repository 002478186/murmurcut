import assert from 'node:assert/strict';
import { resample, envelope, placeDub, bedMusic, toWav } from './audio.js';

assert.equal(resample(new Float32Array(160), 16000, 48000).length, 480);
const env = envelope(Float32Array.from({ length: 1600 }, (_, i) => (i < 800 ? 0 : 0.5)), 16000, 20);
assert.deepEqual([env[0], env[1]], [0, 1]);
// One loud spike doesn't squash normal speech towards a closed mouth.
const spiky = envelope(Float32Array.from({ length: 32000 }, (_, i) => (i < 100 ? 1 : 0.1)), 16000, 20);
assert.equal(spiky[0], 1);
assert.ok(spiky[10] > 0.9);

// A 1 s line in a 0.8 s slot is sped up (1.25x) and still ends before the next line.
const rate = 100, line = n => ({ pcm: new Float32Array(n).fill(1) });
const dub = placeDub([{ start: 0, ...line(100) }, { start: 0.8, ...line(50) }], rate, 2);
assert.equal(dub.length, 200);
assert.equal(dub[79], 1);
assert.equal(dub[85], 1); // second line
assert.equal(dub[140], 0); // silence after it
// Too long even at max speed: cut at the slot.
assert.equal(placeDub([{ start: 0, ...line(300) }, { start: 1, ...line(10) }], rate, 2)[99], 1);

// Music ducks under speech and loops.
const voice = new Float32Array(6000).fill(0); voice.fill(0.5, 0, 1000);
const bed = bedMusic(new Float32Array(300).fill(1), voice, 1000, 0.3, 0.35);
assert.ok(bed[900] < 0.12 && bed[2500] > 0.25, `ducked ${bed[900]} vs open ${bed[2500]}`);
assert.ok(bed[5990] < 0.01); // faded out at the end
assert.equal(new DataView(toWav(new Float32Array(10), 16000)).getUint32(24, true), 16000);

console.log('media ok');
