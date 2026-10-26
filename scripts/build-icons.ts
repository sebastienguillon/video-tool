/**
 * Draws the app icon and writes every file the installers, the README and the project use, from the
 * geometry below: `build/icon.icns` (macOS), `build/icon.ico` (Windows), `build/icons/*.png`
 * (Linux), `docs/brand/icon.svg` and `assets/icon.svg`. Run it after changing the design:
 * `pnpm icons`.
 *
 * The icon is a frame of film between two columns of perforations, the author's SG logo on it: in
 * the logo's lime on the olive black of SG Tag, the author's other app. No text, since font
 * rendering varies. Under 48 px, versions snapped to the pixel grid replace the scaled-down drawing.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

/** The SG logo's lime, on SG Tag's olive black. The logo on the frame takes the ground's colour. */
const GROUND = '#131510';
const FILM = '#a8c70b';

/** Two decimals: enough for a 1024 px drawing, and keeps the SVG files readable. */
const n = (value: number): number => Math.round(value * 100) / 100;

/**
 * The SG logo, as its own SVG draws it: on a 400 grid of circles of radius 100, a 40 stroke, a fill
 * at 25%, and the lower left end cut on a slant by the clip.
 */
const LOGO_SHAPE =
  'M100 200A100 100 0 1 1 200 100A100 100 0 0 0 300 200A100 100 0 1 1 200 300A100 100 0 0 0 100 200';

/**
 * The logo `width` wide, strokes included (440 on its grid), the centre of its grid at (x, y). A
 * `stroke` heavier than the logo's 40 keeps it from fading into the frame at 16 px.
 */
function logo(x: number, y: number, width: number, stroke = 40): string {
  const scale = width / 440;
  return (
    `<g transform="translate(${n(x - 200 * scale)} ${n(y - 200 * scale)}) ` +
    `scale(${Math.round(scale * 10000) / 10000})">` +
    '<defs><clipPath id="logo"><polygon points="-24,-24 424,-24 424,424 0,424 40,290 -24,290"/></clipPath></defs>' +
    `<g clip-path="url(#logo)"><path d="${LOGO_SHAPE}" fill="${GROUND}" fill-opacity="0.25"/>` +
    `<path d="${LOGO_SHAPE}M200 100A100 100 0 1 1 300 200M200 300A100 100 0 0 1 0 300" ` +
    `fill="none" stroke="${GROUND}" stroke-width="${stroke}"/>` +
    `<path d="M380 20L405 -5" stroke="${GROUND}" stroke-width="${stroke}"/></g></g>`
  );
}

/**
 * The ground, its perforations, the frame and the logo, for a ground of side `side` at (`at`, `at`).
 * Proportions are fractions of the side, so the macOS and full-bleed variants are the same drawing
 * at two scales.
 */
function drawing(at: number, side: number): string {
  const centre = at + side / 2;
  const ground = `<rect x="${n(at)}" y="${n(at)}" width="${n(side)}" height="${n(side)}" rx="${n(side * 0.2245)}" fill="${GROUND}"/>`;
  // Seven holes a side, centred, spanning the frame's height.
  const width = side * 0.066;
  const height = side * 0.05;
  let holes = '';
  for (const x of [at + side * 0.0875, at + side * 0.9125]) {
    for (let k = -3; k <= 3; k++) {
      const y = centre + k * side * 0.112;
      holes += `<rect x="${n(x - width / 2)}" y="${n(y - height / 2)}" width="${n(width)}" height="${n(height)}" rx="${n(side * 0.013)}"/>`;
    }
  }
  const frame = `<rect x="${n(at + side * 0.185)}" y="${n(at + side * 0.14)}" width="${n(side * 0.63)}" height="${n(side * 0.72)}" rx="${n(side * 0.05)}"/>`;
  // The logo sits a little right of and below the centre of its grid, where its weight is.
  const mark = logo(centre + side * 0.004, centre + side * 0.006, side * 0.473);
  return `${ground}<g fill="${FILM}">${holes}${frame}</g>${mark}`;
}

const svg = (size: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${body}</svg>`;

/** macOS: the ground on Apple's icon grid (824 of 1024), with its drop shadow. */
const MAC = svg(
  1024,
  '<defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">' +
    '<feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.32"/>' +
    `</filter></defs><g filter="url(#shadow)">${drawing(100, 824)}</g>`,
);

/** Windows and Linux: the same drawing, nearly full bleed. */
const FULL = svg(1024, drawing(32, 960));

/** The project icon (repository, editor): full bleed, as small sidebars show it. */
const PROJECT = svg(1024, drawing(0, 1024));

/**
 * Snapped to the pixel grid at 32 px: five 2 px holes a side, 2 px apart, and a 16 by 20 px frame;
 * the logo, 12 px wide, is the only part left to anti-aliasing.
 */
const PX32 = svg(
  32,
  `<rect x="2" y="2" width="28" height="28" rx="6.5" fill="${GROUND}"/>` +
    `<path fill="${FILM}" d="M4 7h2v2H4ZM4 11h2v2H4ZM4 15h2v2H4ZM4 19h2v2H4ZM4 23h2v2H4Z` +
    `M26 7h2v2H26ZM26 11h2v2H26ZM26 15h2v2H26ZM26 19h2v2H26ZM26 23h2v2H26Z` +
    `M9.5 6H22.5A1.5 1.5 0 0 1 24 7.5V24.5A1.5 1.5 0 0 1 22.5 26H9.5A1.5 1.5 0 0 1 8 24.5V7.5A1.5 1.5 0 0 1 9.5 6Z"/>${logo(16, 16, 12)}`,
);

/**
 * Snapped to the pixel grid at 16 px: four 2 by 1 px holes a side, 2 px apart, and an 8 by 12 px
 * frame holding the logo, 7.4 px wide, with strokes of 64 instead of 40.
 */
const PX16 = svg(
  16,
  `<rect width="16" height="16" rx="3.5" fill="${GROUND}"/>` +
    `<path fill="${FILM}" d="M1 3h2v1H1ZM1 6h2v1H1ZM1 9h2v1H1ZM1 12h2v1H1Z` +
    `M13 3h2v1H13ZM13 6h2v1H13ZM13 9h2v1H13ZM13 12h2v1H13Z` +
    `M5 2H11A1 1 0 0 1 12 3V13A1 1 0 0 1 11 14H5A1 1 0 0 1 4 13V3A1 1 0 0 1 5 2Z"/>${logo(8, 8, 7.4, 64)}`,
);

/** The source drawn at each size: snapped to the pixel grid below 48 px, scaled down from 1024 above. */
function sourceFor(size: number, large: string): string {
  if (size <= 16) {
    return PX16;
  }
  return size <= 32 ? PX32 : large;
}

const png = (source: string, size: number): Promise<Buffer> =>
  sharp(Buffer.from(source), {
    density: (72 * size) / Number(/viewBox="0 0 (\d+)/.exec(source)?.[1]),
  })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();

/**
 * An `ic04`/`ic05` entry: macOS reads no PNG at 16 and 32 px, but ARGB planes, each run-length
 * encoded. Literal runs of up to 128 bytes are valid encoding, and these images are tiny.
 */
async function argb(source: string, size: 16 | 32): Promise<Buffer> {
  const rgba = await sharp(Buffer.from(source), { density: 72 }).ensureAlpha().raw().toBuffer();
  const planes = [3, 0, 1, 2].map((channel) => {
    const plane = Buffer.alloc(size * size);
    for (let pixel = 0; pixel < plane.length; pixel++) {
      plane[pixel] = rgba[pixel * 4 + channel] ?? 0;
    }
    const runs: Buffer[] = [];
    for (let at = 0; at < plane.length; at += 128) {
      const run = plane.subarray(at, at + 128);
      runs.push(Buffer.from([run.length - 1]), run);
    }
    return Buffer.concat(runs);
  });
  return Buffer.concat([Buffer.from('ARGB', 'ascii'), ...planes]);
}

/** An .icns, by OSType (https://en.wikipedia.org/wiki/Apple_Icon_Image_format). */
async function icns(): Promise<Buffer> {
  const entries: [string, () => Promise<Buffer>][] = [
    ['ic04', () => argb(PX16, 16)],
    ['ic05', () => argb(PX32, 32)],
    // Retina entries draw the design at twice its size: 16 pt at 32 px is the 32 px drawing.
    ['ic11', () => png(PX32, 32)],
    ['ic12', () => png(MAC, 64)],
    ['ic07', () => png(MAC, 128)],
    ['ic13', () => png(MAC, 256)],
    ['ic08', () => png(MAC, 256)],
    ['ic14', () => png(MAC, 512)],
    ['ic09', () => png(MAC, 512)],
    ['ic10', () => png(MAC, 1024)],
  ];
  const chunks = await Promise.all(
    entries.map(async ([type, image]) => {
      const data = await image();
      const header = Buffer.alloc(8);
      header.write(type, 0, 'ascii');
      header.writeUInt32BE(data.length + 8, 4);
      return Buffer.concat([header, data]);
    }),
  );
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

/** An .ico of PNG entries (https://en.wikipedia.org/wiki/ICO_(file_format)). */
async function ico(): Promise<Buffer> {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map((size) => png(sourceFor(size, FULL), size)));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const at = 6 + index * 16;
    const image = images[index] ?? Buffer.alloc(0);
    header.writeUInt8(size % 256, at);
    header.writeUInt8(size % 256, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(image.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += image.length;
  });
  return Buffer.concat([header, ...images]);
}

await rm('build/icons', { recursive: true, force: true });
await mkdir('build/icons', { recursive: true });
await mkdir('docs/brand', { recursive: true });
await mkdir('assets', { recursive: true });
await writeFile('build/icon.icns', await icns());
await writeFile('build/icon.ico', await ico());
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  await writeFile(`build/icons/${size}x${size}.png`, await png(sourceFor(size, FULL), size));
}
await writeFile('docs/brand/icon.svg', `${MAC}\n`);
await writeFile('assets/icon.svg', `${PROJECT}\n`);
console.log('Icons written to build/, docs/brand/icon.svg and assets/icon.svg');
