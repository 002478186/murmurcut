import assert from 'node:assert/strict';
import { parseCommand } from './chat.js';

const ctx = { presets: { spotlight: 'Spotlight', pop: 'Pop', beast: 'Beast', minimal: 'Minimal' }, now: 7 };
const one = text => {
  const r = parseCommand(text, ctx);
  assert.equal(r.unknown.length, 0, `did not understand part of "${text}": ${r.unknown}`);
  assert.equal(r.actions.length, 1, `expected one action for "${text}"`);
  return r.actions[0];
};

assert.deepEqual(one('remove the ums'), { type: 'fillers', on: true });
assert.deepEqual(one('keep the fillers'), { type: 'fillers', on: false });
assert.deepEqual(one('cut pauses longer than 1.5s'), { type: 'silences', on: true, sec: 1.5 });
assert.deepEqual(one('zoom in at 0:12'), { type: 'zoom', at: 12, dur: 1.5, amount: 1.2 });
assert.deepEqual(one('big punch in here for 2s'), { type: 'zoom', at: 7, dur: 2, amount: 1.35 });
assert.deepEqual(one('zoom at 1:05'), { type: 'zoom', at: 65, dur: 1.5, amount: 1.2 });
assert.deepEqual(one('remove all zooms'), { type: 'clearZooms' });
assert.deepEqual(one('turn auto zoom off'), { type: 'autoZoom', on: false });
assert.deepEqual(one('style beast'), { type: 'style', preset: 'beast' });
assert.deepEqual(one('use the minimal captions'), { type: 'style', preset: 'minimal' });
assert.deepEqual(one('make it square'), { type: 'ratio', value: '1:1' });
assert.deepEqual(one('resize for youtube'), { type: 'ratio', value: '16:9' });
assert.deepEqual(one('9:16'), { type: 'ratio', value: '9:16' });
assert.deepEqual(one('captions bigger'), { type: 'size', delta: 1 });
assert.deepEqual(one('make the text much smaller'), { type: 'size', delta: -2 });
assert.deepEqual(one('move captions to the top'), { type: 'pos', value: 18 });
assert.deepEqual(one('captions lower'), { type: 'pos', delta: 8 });
assert.deepEqual(one('no capital letters'), { type: 'upper', on: false });
assert.deepEqual(one('add a photo of mumbai skyline at 0:08'), { type: 'broll', at: 8, dur: 2.5, query: 'mumbai skyline' });
assert.deepEqual(one('add b-roll of a ps5 here'), { type: 'broll', at: 7, dur: 2.5, query: 'ps5' });
assert.deepEqual(one('remove all b-roll'), { type: 'clearBroll' });
assert.deepEqual(one('replace capsule with Kapso'), { type: 'replace', from: 'capsule', to: 'Kapso' });
assert.deepEqual(one('use split screen'), { type: 'layout', value: 'split' });
assert.deepEqual(one('turn off noise reduction'), { type: 'denoise', on: false });
assert.deepEqual(one('undo'), { type: 'undo' });
assert.deepEqual(one('export'), { type: 'export' });

const many = parseCommand('remove the ums, zoom in at 0:12 and make it square', ctx);
assert.deepEqual(many.actions.map(a => a.type), ['fillers', 'zoom', 'ratio']);
assert.deepEqual(parseCommand('make me a sandwich', ctx).unknown, ['make me a sandwich']);

console.log('chat ok');
