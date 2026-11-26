import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.cwd();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// CRC32 for PNG chunks
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodeRgbaToPng(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    raw[rowOffset] = 0; // filter None
    rgba.copy(raw, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function renderVesperaIconRgba(size) {
  const buf = Buffer.alloc(size * size * 4);
  const samples = size <= 32 ? 4 : 2;

  // Normalized [0..1] polygons matching our SVG emblem
  const outerOct = [
    [0.28, 0.06],
    [0.72, 0.06],
    [0.94, 0.28],
    [0.94, 0.72],
    [0.72, 0.94],
    [0.28, 0.94],
    [0.06, 0.72],
    [0.06, 0.28],
  ];
  const innerOct = [
    [0.30, 0.10],
    [0.70, 0.10],
    [0.90, 0.30],
    [0.90, 0.70],
    [0.70, 0.90],
    [0.30, 0.90],
    [0.10, 0.70],
    [0.10, 0.30],
  ];
  const leftWing = [
    [0.21, 0.24],
    [0.37, 0.24],
    [0.50, 0.62],
    [0.50, 0.82],
    [0.43, 0.82],
  ];
  const rightWing = [
    [0.79, 0.24],
    [0.63, 0.24],
    [0.50, 0.62],
    [0.50, 0.82],
    [0.57, 0.82],
  ];
  const coreDiamond = [
    [0.50, 0.26],
    [0.58, 0.42],
    [0.50, 0.56],
    [0.42, 0.42],
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rAcc = 0,
        gAcc = 0,
        bAcc = 0,
        aAcc = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const nx = (x + (sx + 0.5) / samples) / size;
          const ny = (y + (sy + 0.5) / samples) / size;

          if (!pointInPolygon(nx, ny, outerOct)) continue;

          let r = 36,
            g = 43,
            b = 58,
            a = 255;

          if (pointInPolygon(nx, ny, innerOct)) {
            // Deep obsidian radial chassis
            const grad = Math.min(1, Math.hypot(nx - 0.5, ny - 0.35));
            r = Math.round(18 - grad * 8);
            g = Math.round(22 - grad * 9);
            b = Math.round(31 - grad * 11);

            if (pointInPolygon(nx, ny, leftWing)) {
              // Molten gold / solar amber left facet
              const t = Math.min(1, Math.max(0, (ny - 0.24) / 0.58));
              r = Math.round(251 - t * 12);
              g = Math.round(191 - t * 55);
              b = Math.round(36 - t * 22);
            } else if (pointInPolygon(nx, ny, rightWing)) {
              // Deep amber-copper right facet for crisp 3D depth
              const t = Math.min(1, Math.max(0, (ny - 0.24) / 0.58));
              r = Math.round(245 - t * 28);
              g = Math.round(158 - t * 52);
              b = Math.round(11 + t * 8);
            }

            if (pointInPolygon(nx, ny, coreDiamond)) {
              // Cryo-cyan precision prism core
              const t = Math.min(1, Math.max(0, (ny - 0.26) / 0.30));
              r = Math.round(103 - t * 69);
              g = Math.round(232 - t * 35);
              b = Math.round(249 - t * 18);
            }
          } else {
            // Titanium + subtle amber top rim
            const topLight = Math.max(0, 1 - ny * 1.4);
            r = Math.round(42 + topLight * 140);
            g = Math.round(49 + topLight * 95);
            b = Math.round(66 - topLight * 18);
          }

          rAcc += r;
          gAcc += g;
          bAcc += b;
          aAcc += a;
        }
      }

      const totalSamples = samples * samples;
      const idx = (y * size + x) * 4;
      if (aAcc > 0) {
        const covered = aAcc / 255;
        buf[idx] = Math.round(rAcc / covered);
        buf[idx + 1] = Math.round(gAcc / covered);
        buf[idx + 2] = Math.round(bAcc / covered);
        buf[idx + 3] = Math.round(aAcc / totalSamples);
      }
    }
  }
  return buf;
}

function buildWindowsIco(sizes) {
  const pngBuffers = sizes.map((sz) => ({
    size: sz,
    data: encodeRgbaToPng(sz, sz, renderVesperaIconRgba(sz)),
  }));

  const headerSize = 6;
  const dirEntrySize = 16;
  let dataOffset = headerSize + dirEntrySize * pngBuffers.length;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = ICO
  header.writeUInt16LE(pngBuffers.length, 4);

  const dirEntries = [];
  for (const entry of pngBuffers) {
    const dir = Buffer.alloc(dirEntrySize);
    dir[0] = entry.size >= 256 ? 0 : entry.size;
    dir[1] = entry.size >= 256 ? 0 : entry.size;
    dir[2] = 0; // palette
    dir[3] = 0; // reserved
    dir.writeUInt16LE(1, 4); // color planes
    dir.writeUInt16LE(32, 6); // 32 bpp RGBA
    dir.writeUInt32LE(entry.data.length, 8);
    dir.writeUInt32LE(dataOffset, 12);
    dataOffset += entry.data.length;
    dirEntries.push(dir);
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers.map((p) => p.data)]);
}

const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none">
  <defs>
    <linearGradient id="rim" x1="24" y1="16" x2="232" y2="240" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FBBF24"/>
      <stop offset="38%" stop-color="#334155"/>
      <stop offset="100%" stop-color="#1E293B"/>
    </linearGradient>
    <linearGradient id="chassis" x1="128" y1="24" x2="128" y2="232" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#141821"/>
      <stop offset="100%" stop-color="#090B10"/>
    </linearGradient>
    <linearGradient id="wingL" x1="54" y1="60" x2="128" y2="210" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#FDE68A"/>
      <stop offset="45%" stop-color="#F59E0B"/>
      <stop offset="100%" stop-color="#EA580C"/>
    </linearGradient>
    <linearGradient id="wingR" x1="202" y1="60" x2="128" y2="210" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#F59E0B"/>
      <stop offset="100%" stop-color="#B45309"/>
    </linearGradient>
    <linearGradient id="core" x1="128" y1="66" x2="128" y2="144" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#A5F3FC"/>
      <stop offset="100%" stop-color="#06B6D4"/>
    </linearGradient>
  </defs>
  <polygon points="72,15 184,15 241,72 241,184 184,241 72,241 15,184 15,72" fill="url(#rim)"/>
  <polygon points="77,25 179,25 231,77 231,179 179,231 77,231 25,179 25,77" fill="url(#chassis)"/>
  <polygon points="54,62 95,62 128,158 128,210 110,210" fill="url(#wingL)"/>
  <polygon points="202,62 161,62 128,158 128,210 146,210" fill="url(#wingR)"/>
  <polygon points="128,66 149,107 128,144 107,107" fill="url(#core)"/>
</svg>
`;

const wordmarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 96" fill="none">
  <g transform="translate(8,8) scale(0.3125)">
    <polygon points="72,15 184,15 241,72 241,184 184,241 72,241 15,184 15,72" fill="#F59E0B"/>
    <polygon points="77,25 179,25 231,77 231,179 179,231 77,231 25,179 25,77" fill="#0D1017"/>
    <polygon points="54,62 95,62 128,158 128,210 110,210" fill="#FBBF24"/>
    <polygon points="202,62 161,62 128,158 128,210 146,210" fill="#D97706"/>
    <polygon points="128,66 149,107 128,144 107,107" fill="#22D3EE"/>
  </g>
  <text x="106" y="54" fill="#F8FAFC" font-family="Segoe UI, Inter, system-ui, sans-serif" font-weight="800" font-size="38" letter-spacing="4">VESPERA</text>
  <text x="108" y="76" fill="#94A3B8" font-family="Consolas, JetBrains Mono, monospace" font-weight="600" font-size="13" letter-spacing="3.5">PRECISION MINECRAFT CLIENT</text>
</svg>
`;

ensureDir(path.join(ROOT, 'ui/public'));
ensureDir(path.join(ROOT, 'native/resources'));
ensureDir(path.join(ROOT, 'mod/src/main/resources/assets/vespera'));

fs.writeFileSync(path.join(ROOT, 'ui/public/vespera-mark.svg'), markSvg);
fs.writeFileSync(path.join(ROOT, 'ui/public/vespera-wordmark.svg'), wordmarkSvg);

const icoBuffer = buildWindowsIco([16, 24, 32, 48, 64, 128, 256]);
fs.writeFileSync(path.join(ROOT, 'native/resources/vespera.ico'), icoBuffer);

const modPng128 = encodeRgbaToPng(128, 128, renderVesperaIconRgba(128));
fs.writeFileSync(path.join(ROOT, 'mod/src/main/resources/assets/vespera/icon.png'), modPng128);
fs.writeFileSync(path.join(ROOT, 'ui/public/vespera-icon-128.png'), modPng128);

console.log(`Generated Vespera branding assets: vespera.ico (${icoBuffer.length} bytes), mod icon (${modPng128.length} bytes).`);
