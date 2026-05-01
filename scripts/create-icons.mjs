import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const publicDir = join(process.cwd(), "public");
mkdirSync(publicDir, { recursive: true });

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function insideRoundRect(x, y, width, height, radius) {
  const left = radius;
  const right = width - radius - 1;
  const top = radius;
  const bottom = height - radius - 1;
  const cx = x < left ? left : x > right ? right : x;
  const cy = y < top ? top : y > bottom ? bottom : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function drawLine(pixels, size, x1, y1, x2, y2, thickness, color) {
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - thickness));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(x1, x2) + thickness));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - thickness));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(y1, y2) + thickness));
  const lengthSq = (x2 - x1) ** 2 + (y2 - y1) ** 2;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(
        0,
        Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / lengthSq)
      );
      const px = x1 + t * (x2 - x1);
      const py = y1 + t * (y2 - y1);
      if ((x - px) ** 2 + (y - py) ** 2 <= thickness ** 2) {
        setPixel(pixels, size, x, y, color);
      }
    }
  }
}

function setPixel(pixels, size, x, y, [r, g, b, a = 255]) {
  const index = (y * size + x) * 4;
  pixels[index] = r;
  pixels[index + 1] = g;
  pixels[index + 2] = b;
  pixels[index + 3] = a;
}

function createIcon(size, fileName) {
  const pixels = Buffer.alloc(size * size * 4);
  const bg = [23, 63, 53, 255];
  const panel = [246, 245, 239, 255];
  const mark = [36, 116, 92, 255];
  const radius = Math.round(size * 0.18);
  const inner = Math.round(size * 0.17);
  const innerSize = size - inner * 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      setPixel(pixels, size, x, y, bg);
      if (insideRoundRect(x - inner, y - inner, innerSize, innerSize, radius)) {
        setPixel(pixels, size, x, y, panel);
      }
    }
  }

  const s = size;
  const thickness = Math.max(7, Math.round(s * 0.045));
  drawLine(pixels, size, s * 0.33, s * 0.31, s * 0.68, s * 0.31, thickness, mark);
  drawLine(pixels, size, s * 0.33, s * 0.42, s * 0.64, s * 0.42, thickness, mark);
  drawLine(pixels, size, s * 0.39, s * 0.31, s * 0.58, s * 0.31, thickness, mark);
  drawLine(pixels, size, s * 0.50, s * 0.31, s * 0.39, s * 0.63, thickness, mark);
  drawLine(pixels, size, s * 0.39, s * 0.63, s * 0.65, s * 0.74, thickness, mark);

  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    scanlines[rowStart] = 0;
    pixels.copy(scanlines, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0))
  ]);

  writeFileSync(join(publicDir, fileName), png);
}

createIcon(192, "pwa-icon-192.png");
createIcon(512, "pwa-icon-512.png");
createIcon(180, "apple-touch-icon.png");

console.log("Generated PWA icons in public/");
