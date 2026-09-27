/**
 * Minimal PNG encoder/decoder — evidence captures without an image dependency.
 *
 * Encodes 8-bit greyscale or RGB, decodes 8-bit RGB/RGBA/greyscale (non-interlaced).
 * Enough for turntable stills, the comparison sheet, and reference-mask admission.
 * Uses node:zlib, which is built in.
 *
 * Spec: https://www.w3.org/TR/png/
 */

import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

export type PngColorType = "gray" | "rgb";

/**
 * Encode raw samples to PNG. `pixels` is row-major with 1 byte per sample
 * (1 sample per pixel for `gray`, 3 for `rgb`).
 */
export function encodePng(
  pixels: Uint8Array,
  width: number,
  height: number,
  colorType: PngColorType = "gray"
): Buffer {
  const channels = colorType === "gray" ? 1 : 3;
  const expected = width * height * channels;
  if (pixels.length !== expected) {
    throw new Error(`encodePng: expected ${expected} bytes, received ${pixels.length}.`);
  }

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(height * (1 + width * channels));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * channels);
    raw[rowStart] = 0;
    for (let i = 0; i < width * channels; i++) {
      raw[rowStart + 1 + i] = pixels[y * width * channels + i]!;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType === "gray" ? 0 : 2;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export type DecodedPng = {
  width: number;
  height: number;
  channels: number;
  /** Row-major, `channels` bytes per pixel. */
  pixels: Uint8Array;
};

export class PngDecodeError extends Error {}

function unfilter(
  raw: Buffer,
  width: number,
  height: number,
  bytesPerPixel: number
): Uint8Array {
  const stride = width * bytesPerPixel;
  const out = new Uint8Array(height * stride);
  let pos = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    if (filter === undefined) throw new PngDecodeError("Truncated scanline.");
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos++];
      if (rawByte === undefined) throw new PngDecodeError("Truncated pixel data.");
      const a = x >= bytesPerPixel ? out[rowStart + x - bytesPerPixel]! : 0;
      const b = y > 0 ? out[prevStart + x]! : 0;
      const c = y > 0 && x >= bytesPerPixel ? out[prevStart + x - bytesPerPixel]! : 0;

      let value: number;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          value = rawByte + pred;
          break;
        }
        default:
          throw new PngDecodeError(`Unsupported PNG filter ${filter}.`);
      }
      out[rowStart + x] = value & 0xff;
    }
  }
  return out;
}

/**
 * Decode a non-interlaced 8-bit PNG. Palette and 16-bit are rejected rather than guessed
 * at — admission must fail closed on formats it cannot actually measure.
 */
export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PngDecodeError("Not a PNG (bad signature).");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buf.length) throw new PngDecodeError("Chunk runs past end of file.");

    if (type === "IHDR") {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8]!;
      colorType = buf[dataStart + 9]!;
      interlace = buf[dataStart + 12]!;
    } else if (type === "IDAT") {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4; // skip CRC
  }

  if (width <= 0 || height <= 0) throw new PngDecodeError("PNG has no valid IHDR.");
  if (bitDepth !== 8) throw new PngDecodeError(`Unsupported bit depth ${bitDepth} (need 8).`);
  if (interlace !== 0) throw new PngDecodeError("Interlaced PNG is not supported.");
  if (idat.length === 0) throw new PngDecodeError("PNG has no image data.");

  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0) {
    throw new PngDecodeError(`Unsupported PNG color type ${colorType} (palette not supported).`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const pixels = unfilter(raw, width, height, channels);
  return { width, height, channels, pixels };
}

/** Greyscale shading buffer → PNG on a light background, so uncovered pixels read as paper. */
export function shadeToPng(
  shade: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  background = 244
): Buffer {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    out[i] = mask[i] ? shade[i]! : background;
  }
  return encodePng(out, width, height, "gray");
}

export function pngToDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

export type SheetTile = {
  label: string;
  width: number;
  height: number;
  /** Greyscale samples, 1 byte per pixel. */
  pixels: Uint8Array;
};

/**
 * Compose tiles into one horizontal strip — this is the single comparison sheet the
 * evidence contract allows per runId. Labels are drawn as a coded marker bar rather than
 * real glyphs (no font dependency); the ordering is recorded in the score report.
 */
export function composeComparisonSheet(tiles: SheetTile[], gap = 8, background = 232): Buffer {
  if (tiles.length === 0) throw new Error("composeComparisonSheet: no tiles.");
  const height = Math.max(...tiles.map((t) => t.height));
  const labelBar = 6;
  const totalHeight = height + labelBar;
  const width = tiles.reduce((sum, t) => sum + t.width, 0) + gap * (tiles.length - 1);

  const canvas = new Uint8Array(width * totalHeight).fill(background);
  let x = 0;
  for (let index = 0; index < tiles.length; index++) {
    const tile = tiles[index]!;
    for (let y = 0; y < tile.height; y++) {
      for (let tx = 0; tx < tile.width; tx++) {
        canvas[y * width + x + tx] = tile.pixels[y * tile.width + tx]!;
      }
    }
    // Marker bar: (index + 1) dashes identify the column without a font.
    const dashes = index + 1;
    const dashWidth = Math.max(4, Math.floor(tile.width / (dashes * 3)));
    for (let d = 0; d < dashes; d++) {
      const start = x + 4 + d * (dashWidth + 4);
      for (let bx = start; bx < Math.min(start + dashWidth, x + tile.width); bx++) {
        for (let by = height + 1; by < totalHeight - 1; by++) {
          canvas[by * width + bx] = 40;
        }
      }
    }
    x += tile.width + gap;
  }

  return encodePng(canvas, width, totalHeight, "gray");
}
