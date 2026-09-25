// Generates PWA icons into public/ from an inline SVG. Run: node scripts/gen-icons.mjs
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
mkdirSync(join(root, "icons"), { recursive: true });

// A neon double-ring "pin" badge on the TapMap navy background.
function svg({ size, pad, rounded }) {
  const s = 512;
  const c = s / 2;
  const scale = 1 - pad * 2;
  const r = rounded ? 112 : 0;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5b8cff"/><stop offset="0.5" stop-color="#8b5cf6"/><stop offset="1" stop-color="#f062c0"/>
    </linearGradient>
    <radialGradient id="bg" cx="0.5" cy="0.4" r="0.75">
      <stop offset="0" stop-color="#1a1545"/><stop offset="1" stop-color="#0b0a1f"/>
    </radialGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="14" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="${s}" height="${s}" rx="${r}" fill="url(#bg)"/>
  <g transform="translate(${c} ${c}) scale(${scale}) translate(${-c} ${-c})" filter="url(#glow)">
    <circle cx="${c}" cy="${c}" r="150" fill="none" stroke="url(#g)" stroke-width="26"/>
    <circle cx="${c}" cy="${c}" r="112" fill="none" stroke="url(#g)" stroke-width="10" opacity="0.85"/>
    <circle cx="${c}" cy="${c}" r="46" fill="#4ade80"/>
  </g>
</svg>`);
}

const jobs = [
  ["icons/icon-192.png", 192, { pad: 0.08, rounded: true }],
  ["icons/icon-512.png", 512, { pad: 0.08, rounded: true }],
  ["icons/maskable-512.png", 512, { pad: 0.2, rounded: false }],
  ["apple-touch-icon.png", 180, { pad: 0.1, rounded: false }],
  ["icons/favicon-32.png", 32, { pad: 0.02, rounded: true }],
];
for (const [file, size, o] of jobs) {
  await sharp(svg({ size, ...o })).png().toFile(join(root, file));
  console.log("wrote", file);
}
