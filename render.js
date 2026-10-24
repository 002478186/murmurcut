// Canvas drawing for captions and b-roll. Works on any 2D context, so the style gallery reuses it.
import { emphasisIndex } from './captions.js';

const DEVA = '"Noto Sans Devanagari"'; // fallback so Hindi glyphs keep a matching weight

export const PRESETS = {
  spotlight: { name: 'Spotlight', font: 'Bricolage Grotesque', weight: 700, fill: '#fff', layout: 'spotlight', upper: false },
  pop: { name: 'Pop', font: 'Anton', fill: '#fff', stroke: '#000', active: '#FFE14D', grow: 1.15 },
  beast: { name: 'Beast', font: 'Anton', fill: '#fff', stroke: '#000', strokeW: 0.3, cycle: ['#FFE14D', '#5BFF7A', '#FF5DA2'], tilt: -0.05, grow: 1.1 },
  bounce: { name: 'Bounce', font: 'Anton', fill: '#fff', stroke: '#000', reveal: 'word', spring: true },
  karaoke: { name: 'Karaoke', font: 'Bricolage Grotesque', weight: 800, fill: '#fff', stroke: '#000', box: '#7C5CFF' },
  sunset: { name: 'Sunset', font: 'Anton', gradient: ['#FF7AB6', '#FFB347'], stroke: '#2A0A1A', active: '#fff' },
  neon: { name: 'Neon', font: 'Bricolage Grotesque', weight: 800, fill: '#A5F3FC', glow: '#22D3EE', active: '#F472B6' },
  outline: { name: 'Outline', font: 'Anton', hollow: true, fill: '#fff' },
  typewriter: { name: 'Typewriter', font: 'Bricolage Grotesque', weight: 600, fill: '#141414', bar: '#fff', reveal: 'char', upper: false },
  minimal: { name: 'Minimal', font: 'Bricolage Grotesque', weight: 600, fill: '#fff', bar: 'rgba(0,0,0,0.6)', upper: false },
};

const font = (p, s, family = p.font, weight = p.weight ?? 400, italic = '') => `${italic}${weight} ${s}px "${family}", ${DEVA}, sans-serif`;

// Pop-in curve for words that appear as they are spoken.
const spring = age => (age < 0.12 ? 0.5 + (age / 0.12) * 0.7 : age < 0.26 ? 1.2 - ((age - 0.12) / 0.14) * 0.2 : 1);

// o: { size (% of height), pos (% of height), upper, index (line number) }
export function drawCaption(ctx, W, H, line, t, p, o) {
  let ws = line.words.filter(w => !w.cut);
  if (p.reveal === 'word') ws = ws.filter(w => t >= w.start);
  if (!ws.length) return;
  const s = (o.size * H) / 100;
  const upper = o.upper && p.upper !== false;
  const texts = ws.map(w => (upper ? w.text.toUpperCase() : w.text));
  ctx.save();
  if (p.layout === 'spotlight') drawSpotlight(ctx, W, H, ws, texts, t, p, o, s);
  else drawLine(ctx, W, H, ws, texts, t, p, o, s);
  ctx.restore();
}

function drawLine(ctx, W, H, ws, texts, t, p, o, s) {
  ctx.font = font(p, s);
  ctx.textBaseline = 'middle';
  const isActive = w => t >= w.start && t < w.end;
  const widths = texts.map(x => ctx.measureText(x).width);
  // A grown word takes its grown width in the layout so it never overlaps its neighbours.
  const slots = widths.map((w, i) => (isActive(ws[i]) && p.grow ? w * p.grow : w));
  const gap = ctx.measureText(' ').width;
  const total = slots.reduce((a, b) => a + b, 0) + gap * (ws.length - 1);
  const fit = Math.min(1, (W * 0.88) / total);
  ctx.translate(W / 2, (H * o.pos) / 100);
  ctx.scale(fit, fit);
  if (p.tilt) ctx.rotate(p.tilt);
  if (p.bar) {
    ctx.fillStyle = p.bar;
    ctx.beginPath();
    ctx.roundRect(-total / 2 - s * 0.4, -s * 0.72, total + s * 0.8, s * 1.44, s * 0.22);
    ctx.fill();
  }
  const activeColor = p.cycle ? p.cycle[o.index % p.cycle.length] : p.active;
  let x = -total / 2;
  ws.forEach((w, i) => {
    const active = isActive(w);
    x += (slots[i] - widths[i]) / 2;
    const cx = x + widths[i] / 2;
    let text = texts[i];
    if (p.reveal === 'char') text = text.slice(0, Math.ceil(text.length * Math.min(1, Math.max(0, (t - w.start) / Math.max(w.end - w.start, 0.01)))));
    ctx.save();
    const k = (active && p.grow ? p.grow : 1) * (p.spring ? spring(t - w.start) : 1);
    if (k !== 1) { ctx.translate(cx, 0); ctx.scale(k, k); ctx.translate(-cx, 0); }
    if (active && p.box) {
      ctx.fillStyle = p.box;
      ctx.beginPath();
      ctx.roundRect(x - s * 0.15, -s * 0.64, widths[i] + s * 0.3, s * 1.28, s * 0.2);
      ctx.fill();
    }
    if (p.glow) { ctx.shadowColor = p.glow; ctx.shadowBlur = s * 0.5; }
    if (p.hollow) {
      ctx.lineWidth = s * 0.06;
      ctx.strokeStyle = p.fill;
      if (active) { ctx.fillStyle = p.fill; ctx.fillText(text, x, 0); } else ctx.strokeText(text, x, 0);
    } else {
      if (p.stroke) { ctx.lineWidth = s * (p.strokeW ?? 0.18); ctx.lineJoin = 'round'; ctx.strokeStyle = p.stroke; ctx.strokeText(text, x, 0); }
      if (active && activeColor) ctx.fillStyle = activeColor;
      else if (p.gradient) {
        const g = ctx.createLinearGradient(0, -s / 2, 0, s / 2);
        g.addColorStop(0, p.gradient[0]);
        g.addColorStop(1, p.gradient[1]);
        ctx.fillStyle = g;
      } else ctx.fillStyle = p.fill;
      ctx.fillText(text, x, 0);
    }
    ctx.restore();
    x += widths[i] + (slots[i] - widths[i]) / 2 + gap;
  });
}

// The look Captions uses for talking heads: small lead-in words over one big italic keyword, placed off-centre and blurred in.
function drawSpotlight(ctx, W, H, ws, texts, t, p, o, s) {
  const ei = emphasisIndex(ws);
  const align = ['left', 'right', 'center'][o.index % 3];
  const x0 = align === 'left' ? W * 0.08 : align === 'right' ? W * 0.92 : W / 2;
  const y0 = (H * o.pos) / 100;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = s * 0.35;
  const appear = w => Math.min(1, Math.max(0, (t - w.start + 0.05) / 0.18));
  const blurIn = (w, draw) => {
    const a = appear(w);
    if (!a) return;
    ctx.save();
    ctx.globalAlpha = a;
    if (a < 1) ctx.filter = `blur(${(1 - a) * s * 0.25}px)`;
    draw();
    ctx.restore();
  };
  const small = s * 0.62, big = s * 1.7;
  const lead = ws.map((w, i) => i !== ei && { w, text: texts[i] }).filter(Boolean);
  ctx.font = font(p, small);
  const leadWidth = lead.reduce((a, l) => a + ctx.measureText(l.text + ' ').width, 0);
  const fitLead = Math.min(1, (W * 0.84) / leadWidth);
  let x = align === 'left' ? x0 : align === 'right' ? x0 - leadWidth * fitLead : x0 - (leadWidth * fitLead) / 2;
  ctx.textAlign = 'left';
  for (const l of lead) {
    const lx = x;
    blurIn(l.w, () => { ctx.font = font(p, small * fitLead); ctx.fillStyle = p.fill; ctx.fillText(l.text, lx, y0 - big * 0.78); });
    ctx.font = font(p, small * fitLead);
    x += ctx.measureText(l.text + ' ').width;
  }
  ctx.textAlign = align;
  ctx.font = font(p, big, 'Instrument Serif', 400, 'italic ');
  const fitBig = Math.min(1, (W * 0.84) / ctx.measureText(texts[ei]).width);
  blurIn(ws[ei], () => {
    ctx.font = font(p, big * fitBig, 'Instrument Serif', 400, 'italic ');
    ctx.fillStyle = p.fill;
    ctx.fillText(texts[ei], x0, y0);
  });
}

// Cover-fit an image or video frame into a box, optionally scaled about its centre (Ken Burns).
// ay picks which part survives a vertical crop: 0 keeps the top, 0.5 the middle.
export function drawCover(ctx, src, sw, sh, x, y, w, h, zoom = 1, ay = 0.5) {
  const k = Math.max(w / sw, h / sh) * zoom;
  ctx.drawImage(src, x + (w - sw * k) / 2, y + (h - sh * k) * ay, sw * k, sh * k);
}

// A talking character: it leans in and lifts with the loudness of the voice (amp 0..1) and sways a little.
// Not lip-sync, but it reads as speaking. corner: a round badge top right; full: stands in for the speaker.
export function drawAvatar(ctx, W, H, src, sw, sh, amp, t, mode) {
  const k = 1 + 0.06 * amp, tilt = Math.sin(t * 1.7) * 0.015 + 0.02 * amp * Math.sin(t * 9);
  ctx.save();
  if (mode === 'corner') {
    const d = W * 0.34, cx = W * 0.95 - d / 2, cy = H * 0.05 + d / 2;
    ctx.fillStyle = '#f7f8f8';
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2 + W * 0.008, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(cx, cy - d * 0.04 * amp);
    ctx.rotate(tilt);
    ctx.scale(k, k);
    drawCover(ctx, src, sw, sh, -d / 2, -d / 2, d, d, 1.05, 0.25);
  } else {
    // Fill the frame like a video (avatar packs are usually full 9:16 scenes); a cut-out lands on the dark backdrop.
    ctx.fillStyle = '#010102';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2 - H * 0.015 * amp);
    ctx.rotate(tilt);
    drawCover(ctx, src, sw, sh, -W / 2, -H / 2, W, H, 1.04 * k, 0.35);
  }
  ctx.restore();
}

// The speaker on the bottom of a split screen: heads sit high in a phone frame, so crop from near the top.
export function drawSpeaker(ctx, video, x, y, w, h) {
  ctx.save();
  ctx.filter = 'blur(24px) brightness(0.7)';
  drawCover(ctx, video, video.videoWidth, video.videoHeight, x, y, w, h, 1.15);
  ctx.restore();
  drawCover(ctx, video, video.videoWidth, video.videoHeight, x, y, w, h, 1, 0.2);
}

// item: { start, end, mode, query, label, img } for a photo, or { clip: { el, from, to } } for a second video.
export function drawBroll(ctx, W, H, item, t, video) {
  const img = item.clip?.el ?? item.img;
  if ((!img && item.mode !== 'text') || t < item.start || t >= item.end) return;
  const iw = item.clip ? img.videoWidth : img?.naturalWidth, ih = item.clip ? img.videoHeight : img?.naturalHeight;
  const d = item.end - item.start, age = t - item.start;
  // Clips are footage split into pieces; a fade at every split would flicker, so only photos fade.
  const fade = item.clip ? 1 : Math.min(1, age / 0.2, (item.end - t) / 0.2);
  ctx.save();
  ctx.globalAlpha = fade;
  if (item.mode === 'text') {
    // No photo fits, so the words become the visual: the speaker blurred out, the keyword set large.
    ctx.filter = 'blur(18px) brightness(0.7)';
    drawCover(ctx, video, video.videoWidth, video.videoHeight, 0, 0, W, H, 1.1);
    ctx.filter = 'none';
    const label = item.label || item.query;
    let s = W * 0.17;
    ctx.font = `italic 400 ${s}px "Instrument Serif", ${DEVA}, serif`;
    s *= Math.min(1, (W * 0.84) / ctx.measureText(label).width);
    const k = 0.9 + 0.1 * Math.min(1, age / 0.25);
    ctx.translate(W / 2, H * 0.4);
    ctx.scale(k, k);
    ctx.font = `italic 400 ${s}px "Instrument Serif", ${DEVA}, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = s * 0.3;
    ctx.fillStyle = '#fff';
    ctx.fillText(label, 0, 0);
  } else if (item.mode === 'full') {
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    drawCover(ctx, img, iw, ih, 0, 0, W, H, item.clip ? 1 : 1.04 + 0.08 * (age / d)); // no drift over screen text
  } else if (item.mode === 'card') {
    const w = W * 0.74, h = Math.min(H * 0.42, (w * ih) / iw);
    const k = 0.86 + 0.14 * Math.min(1, age / 0.22);
    ctx.translate(W / 2, H * 0.34);
    ctx.scale(k, k);
    ctx.rotate(-0.025);
    const r = W * 0.035, b = W * 0.012;
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = W * 0.05;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.roundRect(-w / 2 - b, -h / 2 - b, w + b * 2, h + b * 2, r + b);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, r);
    ctx.clip();
    drawCover(ctx, img, iw, ih, -w / 2, -h / 2, w, h);
  } else {
    // blur: the speaker blurred behind the image, the image as a framed square
    ctx.filter = 'blur(18px) brightness(0.75)';
    drawCover(ctx, video, video.videoWidth, video.videoHeight, 0, 0, W, H, 1.1);
    ctx.filter = 'none';
    const w = W * 0.62, k = 0.92 + 0.08 * Math.min(1, age / 0.25);
    ctx.translate(W / 2, H * 0.4);
    ctx.scale(k, k);
    ctx.beginPath();
    ctx.roundRect(-w / 2, -w / 2, w, w, W * 0.04);
    ctx.clip();
    drawCover(ctx, img, iw, ih, -w / 2, -w / 2, w, w);
  }
  ctx.restore();
}
