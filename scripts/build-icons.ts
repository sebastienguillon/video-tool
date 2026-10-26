/**
 * Draws the app icon and writes every file the installers, the README and the project use, from the
 * geometry below: `build/icon.icns` (macOS), `build/icon.ico` (Windows), `build/icons/*.png`
 * (Linux), `docs/brand/icon.svg` and `assets/icon.svg`. Run it after changing the design:
 * `pnpm icons`.
 *
 * The icon is a play triangle between two trim brackets, in white on the brand orange: a video, and
 * the cut made to it. No text, since font rendering varies. Under 48 px, hand-drawn versions
 * snapped to the pixel grid replace the scaled-down drawing.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

/** The brand orange. White on it reads at every size, in light and dark surroundings. */
const GROUND = '#ea580c';
const MOTIF = '#ffffff';

/** Two decimals: enough for a 1024 px drawing, and keeps the SVG files readable. */
const n = (value: number): number => Math.round(value * 100) / 100;

/**
 * The ground and its motif, for a ground of side `side` at (`at`, `at`). Proportions are fractions
 * of the side, so the macOS and full-bleed variants are the same drawing at two scales.
 */
function drawing(at: number, side: number): string {
  const centre = at + side / 2;
  // Brackets, along their centre line: a bar with an arm at each end, pointing inwards. Rounded
  // outer corners, square arm ends, so they read as brackets rather than as a frame.
  const stroke = side * 0.08;
  const reach = side * 0.275;
  const half = side * 0.21;
  const arm = side * 0.08;
  const bracket = (direction: 1 | -1): string => {
    const bar = centre - direction * reach;
    const end = bar + direction * arm;
    return (
      `<path d="M${n(end)} ${n(centre - half)}H${n(bar)}V${n(centre + half)}H${n(end)}" ` +
      `fill="none" stroke="${MOTIF}" stroke-width="${n(stroke)}" stroke-linejoin="round"/>`
    );
  };
  // Play triangle, its corners rounded by a stroke of the same colour. It sits a little right of
  // centre: a triangle's weight is on its base, so a centred one looks pushed to the left.
  const height = side * 0.27;
  const width = height * 0.92;
  const left = centre - width / 2 + width * 0.06;
  const play =
    `<path d="M${n(left)} ${n(centre - height / 2)}L${n(left + width)} ${n(centre)}` +
    `L${n(left)} ${n(centre + height / 2)}Z" fill="${MOTIF}" stroke="${MOTIF}" ` +
    `stroke-width="${n(side * 0.05)}" stroke-linejoin="round"/>`;
  const ground = `<rect x="${n(at)}" y="${n(at)}" width="${n(side)}" height="${n(side)}" rx="${n(side * 0.2245)}" fill="${GROUND}"/>`;
  return ground + bracket(1) + bracket(-1) + play;
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
 * Hand-drawn at 32 px: 2 px brackets 14 px tall with 2 px arms, around a 10 px triangle whose base
 * sits on a pixel edge.
 */
const PX32 = svg(
  32,
  `<rect x="2" y="2" width="28" height="28" rx="6.5" fill="${GROUND}"/>` +
    `<path fill="${MOTIF}" d="M11 9H8a1 1 0 0 0-1 1V22a1 1 0 0 0 1 1H11V21H9V11H11Z` +
    `M21 9H24a1 1 0 0 1 1 1V22a1 1 0 0 1-1 1H21V21H23V11H21Z` +
    `M12 11L20.66 16L12 21Z"/>`,
);

/**
 * Hand-drawn at 16 px: 1 px brackets 10 px tall, square, around a 6 px triangle. Bolder brackets
 * crowd the triangle out at this size.
 */
const PX16 = svg(
  16,
  `<rect width="16" height="16" rx="3.5" fill="${GROUND}"/>` +
    `<path fill="${MOTIF}" d="M3 3H6V4H4V12H6V13H3Z M13 3H10V4H12V12H10V13H13Z M6 5L11 8L6 11Z"/>`,
);

/** The source drawn at each size: hand-drawn below 48 px, scaled down from 1024 above. */
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
