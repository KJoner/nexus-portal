// Generates the PWA / home-screen icons from one SVG: the Nexus amber dot on the base colour.
// Run with `node apps/web/scripts/gen-icons.mjs` after changing the artwork.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const out = join(dirname(fileURLToPath(import.meta.url)), '../public/icons');
mkdirSync(out, { recursive: true });

// `pad` shrinks the artwork into the maskable safe zone (centre 80 %).
const art = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><radialGradient id="g" cx="50%" cy="50%" r="50%">
    <stop offset="0" stop-color="#e6c08a" stop-opacity=".55"/><stop offset="1" stop-color="#e6c08a" stop-opacity="0"/>
  </radialGradient><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2621"/><stop offset="1" stop-color="#1b1a17"/></linearGradient></defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="${150 * pad}" fill="url(#g)"/>
  <circle cx="256" cy="256" r="${62 * pad}" fill="#e6c08a"/>
</svg>`;

const jobs = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['maskable-512.png', 512, 0.8],
  ['apple-touch-icon.png', 180, 1],
];
for (const [name, size, pad] of jobs) {
  await sharp(Buffer.from(art(pad))).resize(size, size).png().toFile(join(out, name));
  console.log('wrote', name);
}
