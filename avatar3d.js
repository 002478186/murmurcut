// 3D presenters, built from scratch in three.js: one parametric character (head, eyes that blink and glance,
// brows, nose, ears, a mouth that opens with the voice, hair, clothes, accessories). Each avatar is only data.
// Everything moves as a function of (t, amp), so the export renders exactly what the preview shows.

const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js';

export const AVATARS = [
  { name: 'Maya', voice: 'af_heart', skin: '#c68863', hair: 'long', hairColor: '#1c1410', top: '#1fb5a8', style: 'tee', extras: ['earrings'], bg: ['#2ec4b6', '#0b2a33'] },
  { name: 'Leo', voice: 'am_michael', skin: '#f1c7a5', hair: 'short', hairColor: '#5a3a22', top: '#26355e', style: 'hoodie', extras: ['glasses'], bg: ['#5e6ad2', '#0f1330'] },
  { name: 'Priya', voice: 'af_bella', skin: '#b9785a', hair: 'bun', hairColor: '#2a1a12', top: '#d9a441', style: 'blazer', extras: ['earrings'], bg: ['#f2a65a', '#3a1d0e'] },
  { name: 'Kai', voice: 'am_puck', skin: '#e0ac82', hair: 'curly', hairColor: '#2b2b2b', top: '#d64545', style: 'hoodie', extras: ['headphones'], bg: ['#ff6b6b', '#2a0c14'] },
  { name: 'Emma', voice: 'bf_emma', skin: '#f6d3bd', hair: 'bob', hairColor: '#b5522b', top: '#a99cf0', style: 'tee', extras: [], bg: ['#b8a9ff', '#221a45'] },
  { name: 'George', voice: 'bm_george', skin: '#e8b99a', hair: 'short', hairColor: '#b8b8b8', top: '#3a3d44', style: 'blazer', extras: ['beard', 'glasses'], bg: ['#8a8f98', '#101114'] },
];

export const W3D = 720, H3D = 1280;
let T, renderer, scene, camera, rig = null, built = null;

// Loads three.js and the renderer once; call before render3d.
export async function prepare3d() {
  T ??= await import(THREE_URL);
  if (renderer) return;
  const canvas = document.createElement('canvas');
  renderer = new T.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W3D, H3D, false);
  renderer.toneMapping = T.ACESFilmicToneMapping;
  scene = new T.Scene();
  camera = new T.PerspectiveCamera(26, W3D / H3D, 0.1, 50);
  camera.position.set(0, 1.55, 7.6);
  camera.lookAt(0, 1.3, 0);
  scene.add(new T.HemisphereLight('#ffffff', '#3a3340', 1.1));
  const key = new T.DirectionalLight('#fff1e0', 2.4);
  key.position.set(2.5, 4, 5);
  const rim = new T.DirectionalLight('#9fc7ff', 1.6);
  rim.position.set(-3, 3, -4);
  const fill = new T.DirectionalLight('#ffffff', 0.6);
  fill.position.set(-3, 1, 4);
  scene.add(key, rim, fill);
}

const mat = (color, rough = 0.6, extra = {}) => new T.MeshStandardMaterial({ color, roughness: rough, ...extra });
const mesh = (geo, m, [x = 0, y = 0, z = 0] = [], [sx = 1, sy = 1, sz = 1] = []) => {
  const o = new T.Mesh(geo, m);
  o.position.set(x, y, z);
  o.scale.set(sx, sy, sz);
  return o;
};

// Where the face surface is, so features sit on the (squashed) sphere of the head.
const HX = 0.9, HY = 1.06, HZ = 0.96;
const onFace = (x, y) => HZ * Math.sqrt(Math.max(0, 1 - (x / HX) ** 2 - (y / HY) ** 2));

function build(a) {
  const root = new T.Group(), head = new T.Group(), body = new T.Group();
  const skin = mat(a.skin, 0.55), hair = mat(a.hairColor, 0.7), top = mat(a.top, 0.85), dark = mat('#141416', 0.4);
  const sphere = new T.SphereGeometry(1, 64, 48);

  // backdrop: a soft vertical gradient
  const g = document.createElement('canvas');
  g.width = 4; g.height = 256;
  const gc = g.getContext('2d'), grad = gc.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, a.bg[0]); grad.addColorStop(1, a.bg[1]);
  gc.fillStyle = grad; gc.fillRect(0, 0, 4, 256);
  const tex = new T.CanvasTexture(g);
  tex.colorSpace = T.SRGBColorSpace;

  // body: torso, shoulders, neck, clothes
  body.add(mesh(new T.CapsuleGeometry(0.9, 0.9, 8, 32), top, [0, -0.25, 0], [1.22, 1, 0.7]));
  body.add(mesh(new T.CylinderGeometry(0.3, 0.34, 0.7, 32), skin, [0, 0.72, 0]));
  if (a.style === 'hoodie') {
    body.add(mesh(new T.TorusGeometry(0.42, 0.13, 16, 40), top, [0, 0.52, -0.05], [1.15, 0.7, 1]).rotateX(Math.PI / 2));
    for (const s of [-1, 1]) body.add(mesh(new T.CylinderGeometry(0.025, 0.025, 0.5, 8), mat('#e8e8e8'), [s * 0.16, 0.18, 0.62]));
  }
  if (a.style === 'blazer') {
    body.add(mesh(new T.ConeGeometry(0.34, 0.75, 3), mat('#f4f4f4', 0.7), [0, 0.2, 0.6], [1, 1, 0.3]).rotateZ(Math.PI));
    for (const s of [-1, 1]) body.add(mesh(new T.BoxGeometry(0.16, 0.8, 0.06), mat(a.top, 0.75, { emissive: '#000' }), [s * 0.26, 0.2, 0.62]).rotateZ(s * 0.35));
  }
  if (a.style === 'tee') body.add(mesh(new T.TorusGeometry(0.33, 0.05, 12, 40), top, [0, 0.47, 0.05], [1, 0.8, 1]).rotateX(Math.PI / 2));

  // head
  head.add(mesh(sphere, skin, [], [HX, HY, HZ]));
  for (const s of [-1, 1]) head.add(mesh(sphere, skin, [s * 0.88, 0.02, 0], [0.13, 0.22, 0.17])); // ears
  head.add(mesh(sphere, skin, [0, -0.1, onFace(0, -0.1) + 0.02], [0.1, 0.13, 0.12])); // nose
  for (const s of [-1, 1]) head.add(mesh(sphere, mat('#ff8fa3', 0.8, { transparent: true, opacity: 0.18 }), [s * 0.47, -0.2, onFace(0.47, -0.2) - 0.03], [0.17, 0.11, 0.05]));

  const eyes = [], lids = [], brows = [];
  for (const s of [-1, 1]) {
    const x = s * 0.31, y = 0.14, z = onFace(x, y) - 0.08;
    const eye = new T.Group();
    eye.position.set(x, y, z);
    eye.add(mesh(sphere, mat('#fafafa', 0.25), [], [0.15, 0.15, 0.15]));
    const look = new T.Group();
    look.add(mesh(sphere, mat('#3b2a1e', 0.3), [0, 0, 0.11], [0.085, 0.085, 0.05]));
    look.add(mesh(sphere, mat('#050505', 0.2), [0, 0, 0.145], [0.045, 0.045, 0.03]));
    look.add(mesh(sphere, new T.MeshBasicMaterial({ color: '#ffffff' }), [0.03, 0.035, 0.17], [0.015, 0.015, 0.01]));
    eye.add(look);
    head.add(eye);
    eyes.push(look);
    lids.push(eye); // a blink squashes the whole eye shut
    const brow = mesh(new T.CapsuleGeometry(0.035, 0.2, 4, 12), hair, [s * 0.31, 0.38, onFace(0.31, 0.38) + 0.01]).rotateZ(Math.PI / 2 + s * 0.12);
    head.add(brow);
    brows.push(brow);
  }

  // mouth: dark inside, teeth, lips; the group stretches open with the voice
  const mouth = new T.Group();
  mouth.position.set(0, -0.43, onFace(0, -0.43) - 0.02);
  const inside = mesh(sphere, mat('#3b0d12', 0.9), [], [0.2, 0.08, 0.06]);
  const lips = mesh(new T.TorusGeometry(0.19, 0.04, 12, 40), mat('#b55b5b', 0.5), [], [1.05, 0.35, 0.6]);
  mouth.add(inside, lips);
  head.add(mouth);

  // hair
  // the cap's pole tips back, so its front edge is a hairline above the brows and its back edge covers the nape
  const cap = (scale, rotX = -0.38, theta = 0.47) => mesh(new T.SphereGeometry(1, 48, 32, 0, Math.PI * 2, 0, Math.PI * theta), hair, [0, 0.04, -0.02], scale).rotateX(rotX);
  if (a.hair !== 'bald') head.add(cap([0.96, 1.1, 1.02]));
  if (a.hair === 'long' || a.hair === 'bob') {
    const len = a.hair === 'long' ? 1.25 : 0.6;
    head.add(mesh(new T.CapsuleGeometry(0.62, len, 8, 24), hair, [0, -0.25 - len / 3, -0.42], [1.3, 1, 0.6]));
    for (const s of [-1, 1]) head.add(mesh(new T.CapsuleGeometry(0.2, len * 0.75, 6, 16), hair, [s * 0.82, -0.25 - len / 4, 0.05], [1, 1, 0.9]));
  }
  if (a.hair === 'bun') head.add(mesh(sphere, hair, [0, 0.95, -0.45], [0.34, 0.32, 0.34]));
  if (a.hair === 'curly') {
    for (let i = 0; i < 90; i++) { // little curls scattered over the cap
      const th = (i * 2.399) % (Math.PI * 2), ph = 0.15 + ((i * 0.618) % 1) * 1.25;
      const r = 1.04;
      head.add(mesh(sphere, hair, [Math.sin(ph) * Math.cos(th) * r * 0.97, Math.cos(ph) * r * 1.08 + 0.02, Math.sin(ph) * Math.sin(th) * r - 0.08], [0.2, 0.2, 0.2]));
    }
  }

  // accessories
  const x = a.extras ?? [];
  if (x.includes('glasses')) {
    const frame = mat('#111214', 0.3);
    for (const s of [-1, 1]) head.add(mesh(new T.TorusGeometry(0.17, 0.022, 10, 36), frame, [s * 0.31, 0.14, onFace(0.31, 0.14) + 0.04]));
    head.add(mesh(new T.CylinderGeometry(0.018, 0.018, 0.22, 8), frame, [0, 0.16, onFace(0, 0.16) + 0.05]).rotateZ(Math.PI / 2));
  }
  if (x.includes('beard')) head.add(mesh(sphere, hair, [0, -0.55, 0.32], [0.72, 0.5, 0.62]));
  if (x.includes('earrings')) for (const s of [-1, 1]) head.add(mesh(sphere, mat('#e8c35a', 0.2, { metalness: 0.9 }), [s * 0.9, -0.22, 0.05], [0.055, 0.055, 0.055]));
  if (x.includes('headphones')) {
    head.add(mesh(new T.TorusGeometry(1.02, 0.06, 12, 48, Math.PI), dark, [0, 0.02, 0], [1, 1.12, 1]));
    for (const s of [-1, 1]) head.add(mesh(new T.CylinderGeometry(0.26, 0.26, 0.16, 32), dark, [s * 0.98, 0, 0]).rotateZ(Math.PI / 2));
  }

  head.scale.setScalar(0.64);
  head.position.set(0, 1.68, 0);
  root.add(body, head);
  return { root, head, body, eyes, lids, brows, mouth, inside, bg: tex };
}

// A repeatable hash, so blinks and glances land at the same moments in the preview and the export.
const rand = n => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };

// Draws avatar `a` at time t with voice loudness amp (0..1) and returns the canvas to composite.
export function render3d(a, t, amp) {
  if (built?.a !== a) {
    if (rig) scene.remove(rig.root);
    rig = build(a);
    built = { a };
    scene.add(rig.root);
    scene.background = rig.bg;
  }
  const { head, body, eyes, lids, brows, mouth, inside } = rig;
  const talk = Math.min(1, amp * 1.3);
  head.rotation.set(-0.04 + Math.sin(t * 1.3) * 0.03 - talk * 0.05, Math.sin(t * 0.7) * 0.12 + talk * 0.04 * Math.sin(t * 6), Math.sin(t * 0.5) * 0.03);
  body.scale.y = 1 + Math.sin(t * 1.6) * 0.01; // breathing
  const beat = Math.floor(t / 3.1), into = t - beat * 3.1 - rand(beat) * 1.5;
  const blink = into > 0 && into < 0.14 ? 1 - Math.abs(into - 0.07) / 0.07 : 0;
  for (const eye of lids) eye.scale.y = 1 - blink * 0.92;
  const g = Math.floor(t / 1.7);
  for (const e of eyes) { e.rotation.y = (rand(g) - 0.5) * 0.5; e.rotation.x = (rand(g + 9) - 0.5) * 0.25; }
  for (const b of brows) b.position.y = 0.38 + talk * 0.04;
  mouth.scale.set(1 - talk * 0.1, 0.6 + talk * 0.75, 1);
  inside.scale.y = 0.035 + talk * 0.075;
  renderer.render(scene, camera);
  return renderer.domElement;
}
