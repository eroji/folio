// Generates the PWA icons and logo assets from the brand SVGs in docs/sample.
// No system SVG rasterizer exists, so this uses sharp (dev dependency).
// Run with: npm run icons
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..");
const sample = join(frontend, "..", "docs", "sample");
const publicDir = join(frontend, "public");
const iconsDir = join(publicDir, "icons");
const iconSvg = join(sample, "folio-icon.svg");
const INK = "#1E2235";

await mkdir(iconsDir, { recursive: true });

// Vector mark + wordmarks (light and dark) copied straight into public/.
await copyFile(iconSvg, join(publicDir, "logo.svg"));
await copyFile(join(sample, "folio-logo.svg"), join(publicDir, "logo-wordmark.svg"));
await copyFile(join(sample, "folio-logo-dark.svg"), join(publicDir, "logo-wordmark-dark.svg"));
await copyFile(join(sample, "favicon.svg"), join(publicDir, "favicon.svg"));

const render = (size) => sharp(iconSvg, { density: 300 }).resize(size, size);
for (const size of [512, 192, 32]) {
  await render(size).png().toFile(join(iconsDir, `icon-${size}.png`));
}

// Apple touch: opaque, so flatten the mark onto an ink tile.
await render(180).flatten({ background: INK }).png().toFile(join(iconsDir, "apple-touch-icon-180.png"));

// Maskable 512: mark scaled to the central 80% safe zone on a full-bleed ink tile.
const mark = await render(Math.round(512 * 0.8)).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: INK } })
  .composite([{ input: mark, gravity: "centre" }])
  .png()
  .toFile(join(iconsDir, "icon-maskable-512.png"));

// favicon.ico: single-PNG-entry ICO wrapper around the 32px render.
const png32 = await render(32).png().toBuffer();
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // one image
const entry = Buffer.alloc(16);
entry.writeUInt8(32, 0);
entry.writeUInt8(32, 1);
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png32.length, 8);
entry.writeUInt32LE(header.length + entry.length, 12);
await writeFile(join(publicDir, "favicon.ico"), Buffer.concat([header, entry, png32]));

console.log("icons: wrote public/logo*.svg, public/favicon.{svg,ico} and public/icons/*.png");
