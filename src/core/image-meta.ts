/**
 * Zero-dependency raster image dimension/format detection from header bytes.
 * Supports PNG, JPEG, GIF, BMP, WebP (VP8/VP8L/VP8X). Container formats
 * (AVIF/HEIC) are identified by brand but dimensions are left to a media probe.
 * Returns `undefined` if the bytes are not a recognized image.
 */
export interface ImageDims {
  format: string;
  width?: number;
  height?: number;
}

export function imageDimensions(b: Buffer): ImageDims | undefined {
  // PNG: \x89 P N G, IHDR width/height are BE at offsets 16/20.
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { format: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  // GIF: full "GIF87a"/"GIF89a" signature, then LE screen width/height at 6/8.
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return { format: "gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  // BMP: "BM", DIB width/height (signed LE) at 18/22; height may be negative
  // (top-down). A non-positive width is malformed, so report dims as unavailable.
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const w = b.readInt32LE(18);
    const h = Math.abs(b.readInt32LE(22));
    return w > 0 && h > 0 ? { format: "bmp", width: w, height: h } : { format: "bmp" };
  }
  // WebP: RIFF....WEBP, then a VP8 variant chunk.
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const fourcc = b.toString("ascii", 12, 16);
    if (fourcc === "VP8X") {
      const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
      const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
      return { format: "webp", width: w, height: h };
    }
    if (fourcc === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      const w = (b[26]! | (b[27]! << 8)) & 0x3fff;
      const h = (b[28]! | (b[29]! << 8)) & 0x3fff;
      return { format: "webp", width: w, height: h };
    }
    if (fourcc === "VP8L" && b[20] === 0x2f) {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { format: "webp" };
  }
  // JPEG: FFD8, then walk segments to the first SOF (frame) marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue; // fill byte
      }
      // SOF0..SOF15 carry the frame size; skip DHT(C4)/JPG(C8)/DAC(CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        // A real SOF segment is length(2) precision(1) height(2) width(2)…, so
        // its declared length must be >= 8. Otherwise it's a coincidental or
        // truncated marker; skip it rather than return garbage dimensions.
        if (b.readUInt16BE(i + 2) >= 8) {
          return { format: "jpeg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + b.readUInt16BE(i + 2);
        continue;
      }
      // Standalone markers (SOI/EOI/RSTn/TEM) carry no length.
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + b.readUInt16BE(i + 2); // skip this segment
    }
    return { format: "jpeg" };
  }
  // ISOBMFF container (AVIF/HEIC): identify the brand; leave dims to a probe.
  if (b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp") {
    const brand = b.toString("ascii", 8, 12);
    if (brand.startsWith("avif")) return { format: "avif" };
    if (brand.startsWith("heic") || brand.startsWith("heix") || brand.startsWith("mif1")) return { format: "heic" };
  }
  return undefined;
}

/** Reduce a w:h ratio to lowest terms (e.g. 1920x1080 -> "16:9"). */
export function aspectRatio(w: number, h: number): string {
  if (w <= 0 || h <= 0) return "?";
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}
