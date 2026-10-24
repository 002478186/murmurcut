// Built-in avatars: original cartoon characters drawn in code, so they really talk (the mouth opens with the
// voice) and blink. One shared body and face; each character only adds colours, a shape and one prop.

const TAU = Math.PI * 2;
const circle = (ctx, x, y, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); };

// u = 1% of the frame width, so every character scales with the canvas.
export const TOONS = [
  { name: 'Deadline Duck', bg: ['#ff7a59', '#7a1f12'], body: '#ffd23f', belly: '#fff3b0', beak: '#ff8c1a', prop: (c, u, t) => {
    c.fillStyle = '#2b2d31'; c.fillRect(-30 * u, 38 * u, 60 * u, 4 * u); // laptop
    c.fillStyle = '#3d4046'; c.beginPath(); c.moveTo(-24 * u, 38 * u); c.lineTo(-20 * u, 16 * u); c.lineTo(20 * u, 16 * u); c.lineTo(24 * u, 38 * u); c.fill();
    c.fillStyle = '#7fd1ff'; c.beginPath(); c.ellipse(26 * u, -36 * u + ((t * 30) % 12) * u, 2.6 * u, 4 * u, 0, 0, TAU); c.fill(); // sweat drop
  } },
  { name: 'Buffering Bear', bg: ['#6b8cff', '#1b2559'], body: '#9b6a43', belly: '#d8b38a', ears: true, prop: (c, u, t) => {
    c.lineWidth = 3 * u; c.lineCap = 'round';
    for (let i = 0; i < 8; i++) { // loading spinner over the head
      c.strokeStyle = `rgba(255,255,255,${((i + Math.floor(t * 10)) % 8) / 8 + 0.1})`;
      const a = (i / 8) * TAU;
      c.beginPath(); c.moveTo(Math.cos(a) * 7 * u, -62 * u + Math.sin(a) * 7 * u); c.lineTo(Math.cos(a) * 11 * u, -62 * u + Math.sin(a) * 11 * u); c.stroke();
    }
  } },
  { name: 'Sigma Snail', bg: ['#8e5cff', '#20113f'], body: '#c9a7ff', belly: '#efe3ff', antennae: true, prop: (c, u) => {
    c.fillStyle = '#111'; c.fillRect(-20 * u, -16 * u, 40 * u, 6 * u); // shades sit over the eyes
    c.beginPath(); c.ellipse(-10 * u, -11 * u, 9 * u, 6 * u, 0, 0, Math.PI); c.ellipse(10 * u, -11 * u, 9 * u, 6 * u, 0, 0, Math.PI); c.fill();
    c.strokeStyle = '#d98a3a'; c.lineWidth = 3 * u; c.beginPath(); c.arc(-34 * u, 18 * u, 16 * u, 0.5, TAU - 0.5); c.stroke(); // shell swirl
    c.beginPath(); c.arc(-34 * u, 18 * u, 8 * u, 0, TAU); c.stroke();
  }, shades: true },
  { name: 'Cringe Cactus', bg: ['#ffd27a', '#b5651d'], body: '#4caf50', belly: '#81c784', tall: true, wince: true, prop: (c, u) => {
    c.fillStyle = '#4caf50';
    c.beginPath(); c.roundRect(-46 * u, -6 * u, 12 * u, 30 * u, 6 * u); c.roundRect(34 * u, -18 * u, 12 * u, 30 * u, 6 * u); c.fill(); // arms
    c.fillStyle = '#ff6fa8'; circle(c, 0, -60 * u, 6 * u, '#ff6fa8'); // flower
  } },
  { name: 'Touch Grass Toad', bg: ['#9be15d', '#1f5f2e'], body: '#6fbf4a', belly: '#c8e6a0', wide: true, prop: (c, u, t) => {
    c.strokeStyle = '#2e7d32'; c.lineWidth = 2.4 * u; c.lineCap = 'round';
    for (let i = -3; i <= 3; i++) { c.beginPath(); c.moveTo(22 * u + i * 2 * u, 34 * u); c.quadraticCurveTo(22 * u + i * 3 * u + Math.sin(t * 3 + i) * u, 22 * u, 22 * u + i * 4 * u, 14 * u); c.stroke(); }
    circle(c, 22 * u, 36 * u, 6 * u, '#6fbf4a'); // hand holding the grass
  } },
  { name: 'Ratio Robot', bg: ['#38e8c6', '#0b3b4a'], body: '#b8c4cc', belly: '#dfe6ea', box: true, screen: '#0f1720', prop: (c, u, t) => {
    c.strokeStyle = '#b8c4cc'; c.lineWidth = 2 * u; c.beginPath(); c.moveTo(0, -50 * u); c.lineTo(0, -60 * u); c.stroke();
    circle(c, 0, -62 * u, 3.5 * u, Math.sin(t * 6) > 0 ? '#ff4d6d' : '#ffb3c1'); // antenna light
  } },
  { name: 'Hot Take Taco', bg: ['#ff9f1c', '#5c1a00'], body: '#f4c542', belly: '#f9dd7a', taco: true, prop: (c, u, t) => {
    for (let i = -2; i <= 2; i++) { // flames on top
      const h = (14 + Math.sin(t * 8 + i * 1.7) * 4) * u;
      c.fillStyle = i % 2 ? '#ff5400' : '#ffb000';
      c.beginPath(); c.moveTo(i * 9 * u - 5 * u, -44 * u); c.quadraticCurveTo(i * 9 * u, -44 * u - h * 1.6, i * 9 * u + 5 * u, -44 * u); c.fill();
    }
    c.fillStyle = '#5cb85c'; c.fillRect(-34 * u, -40 * u, 68 * u, 5 * u); // lettuce edge
  } },
  { name: 'Lowkey Llama', bg: ['#c3a6ff', '#3b2a6b'], body: '#f3e9dc', belly: '#fff8ef', tall: true, ears: true, prop: (c, u) => {
    c.fillStyle = '#2f3542'; // hoodie
    c.beginPath(); c.roundRect(-34 * u, 12 * u, 68 * u, 40 * u, 12 * u); c.fill();
    c.strokeStyle = '#a4b0be'; c.lineWidth = 1.5 * u; c.beginPath(); c.moveTo(-6 * u, 14 * u); c.lineTo(-6 * u, 26 * u); c.moveTo(6 * u, 14 * u); c.lineTo(6 * u, 26 * u); c.stroke();
  } },
];

// amp: voice loudness 0..1; t: seconds. Draws a full 9:16 scene.
export function drawToon(ctx, toon, W, H, amp, t) {
  const u = W / 100, c = ctx;
  c.save();
  const bg = c.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, toon.bg[0]);
  bg.addColorStop(1, toon.bg[1]);
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);
  c.fillStyle = 'rgba(255,255,255,0.08)'; // soft spotlight behind the character
  c.beginPath(); c.arc(W / 2, H * 0.48, 48 * u, 0, TAU); c.fill();
  c.translate(W / 2, H * 0.56);

  // body: one blob for head and body, like a mascot
  const bw = (toon.wide ? 46 : toon.tall ? 32 : 38) * u, bh = (toon.tall ? 58 : 48) * u;
  c.fillStyle = toon.body;
  c.beginPath();
  if (toon.box) c.roundRect(-bw, -bh, bw * 2, bh * 2, 10 * u);
  else if (toon.taco) c.ellipse(0, 6 * u, bw * 1.1, bh * 0.85, 0, Math.PI, 0);
  else c.ellipse(0, 0, bw, bh, 0, 0, TAU);
  c.fill();
  if (toon.taco) { c.fillStyle = '#8d5524'; c.fillRect(-bw * 1.1, 4 * u, bw * 2.2, 6 * u); } // filling stripe
  else { c.fillStyle = toon.belly; c.beginPath(); c.ellipse(0, bh * 0.45, bw * 0.62, bh * 0.42, 0, 0, TAU); c.fill(); }
  if (toon.ears) for (const s of [-1, 1]) { circle(c, s * bw * 0.7, -bh * 0.85, 9 * u, toon.body); circle(c, s * bw * 0.7, -bh * 0.85, 4.5 * u, toon.belly); }
  if (toon.antennae) {
    c.strokeStyle = toon.body; c.lineWidth = 3 * u;
    for (const s of [-1, 1]) { c.beginPath(); c.moveTo(s * 8 * u, -bh * 0.9); c.lineTo(s * 14 * u, -bh * 1.35); c.stroke(); circle(c, s * 14 * u, -bh * 1.35, 3.5 * u, toon.body); }
  }

  // face
  const fy = toon.taco ? -14 * u : -12 * u;
  if (toon.screen) { c.fillStyle = toon.screen; c.beginPath(); c.roundRect(-26 * u, fy - 16 * u, 52 * u, 34 * u, 6 * u); c.fill(); }
  const blink = (t % 3.4) < 0.12; // a quick blink every few seconds
  const eye = toon.screen ? '#5cf2d0' : '#1a1a1a';
  if (!toon.shades) for (const s of [-1, 1]) {
    const x = s * 10 * u;
    if (toon.wince) { // squeezed shut, > <
      c.lineWidth = 2.4 * u; c.lineCap = c.lineJoin = 'round'; c.strokeStyle = eye;
      c.beginPath(); c.moveTo(x + s * 4 * u, fy - 7 * u); c.lineTo(x - s * 4 * u, fy - 4 * u); c.lineTo(x + s * 4 * u, fy - 1 * u); c.stroke();
      continue;
    }
    if (!toon.screen) circle(c, x, fy - 4 * u, 7 * u, '#fff');
    c.fillStyle = eye;
    c.beginPath();
    if (blink) c.fillRect(x - 5 * u, fy - 4.5 * u, 10 * u, 1.6 * u);
    else c.arc(x + 1 * u, fy - 3 * u, 3.6 * u, 0, TAU);
    c.fill();
  }
  if (toon.beak) { c.fillStyle = toon.beak; c.beginPath(); c.ellipse(0, fy + 6 * u, 10 * u, 4 * u + amp * 5 * u, 0, 0, TAU); c.fill(); }
  // mouth: a line when quiet, an open oval as the voice gets louder
  const open = Math.min(1, amp * 1.4);
  c.fillStyle = toon.screen ? '#5cf2d0' : '#3a1010';
  c.beginPath();
  if (!toon.beak) c.ellipse(0, fy + 10 * u, (5 + open * 3) * u, (0.8 + open * 5) * u, 0, 0, TAU);
  c.fill();
  if (!toon.screen && !toon.beak) { circle(c, -17 * u, fy + 6 * u, 3.5 * u, 'rgba(255,120,140,0.35)'); circle(c, 17 * u, fy + 6 * u, 3.5 * u, 'rgba(255,120,140,0.35)'); }

  toon.prop(c, u, t, amp);
  c.restore();
}
