// Avatars come from the user's own folder: one subfolder per character, holding a picture or video and an
// optional voice sample. Drive downloads often drop file extensions, so the kind is read from the first bytes.

export function sniffKind(bytes, name = '') {
  const b = [...bytes.slice(0, 12)], hex = b.map(x => x.toString(16).padStart(2, '0')).join('');
  const ascii = String.fromCharCode(...b);
  if (hex.startsWith('89504e47') || hex.startsWith('ffd8ff') || ascii.startsWith('GIF8') || (ascii.startsWith('RIFF') && ascii.slice(8) === 'WEBP')) return 'image';
  if (ascii.slice(4, 11) === 'ftypM4A') return 'voice'; // AAC audio shares the MP4 container
  if (ascii.slice(4, 8) === 'ftyp' || hex.startsWith('1a45dfa3')) return 'video';
  if ((ascii.startsWith('RIFF') && ascii.slice(8) === 'WAVE') || ascii.startsWith('ID3') || hex.startsWith('fff') || ascii.startsWith('OggS')) return 'voice';
  const ext = name.split('.').pop().toLowerCase();
  return { png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', mp4: 'video', webm: 'video', mov: 'video', wav: 'voice', mp3: 'voice', m4a: 'voice', ogg: 'voice' }[ext] ?? null;
}

// files: [{ path: 'Animal Character/Chef Frog/072-chef-frog.wav', kind }] -> [{ name, image | video, voice }],
// named after the folder that holds them (or the file, for loose files). First of each kind wins.
export function groupAvatars(files) {
  const groups = new Map();
  for (const f of files) {
    if (!f.kind) continue;
    const parts = f.path.split('/');
    const name = parts.length > 2 ? parts.at(-2) : parts.at(-1).replace(/\.[^.]+$/, '');
    const g = groups.get(name) ?? { name };
    g[f.kind] ??= f;
    groups.set(name, g);
  }
  return [...groups.values()].filter(g => g.image || g.video).sort((a, b) => a.name.localeCompare(b.name));
}
