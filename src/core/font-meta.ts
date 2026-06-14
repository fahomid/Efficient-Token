/**
 * Zero-dependency font name extraction from an sfnt (TTF/OTF) `name` table.
 * Returns the typographic family/subfamily/full name, or `undefined` if the
 * bytes are not a parseable sfnt (WOFF/WOFF2 wrappers are handled elsewhere).
 */
export interface FontNames {
  family?: string;
  subfamily?: string;
  fullName?: string;
}

export function fontNames(b: Buffer): FontNames | undefined {
  if (b.length < 12) return undefined;
  const tagStr = b.toString("ascii", 0, 4);
  const isSfnt = tagStr === "OTTO" || tagStr === "true" || tagStr === "typ1" || b.readUInt32BE(0) === 0x00010000;
  if (!isSfnt) return undefined; // ttcf collections / WOFF are out of scope here

  const numTables = b.readUInt16BE(4);
  let nameOff = -1;
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    if (o + 16 > b.length) break;
    if (b.toString("ascii", o, o + 4) === "name") {
      nameOff = b.readUInt32BE(o + 8);
      break;
    }
  }
  if (nameOff < 0 || nameOff + 6 > b.length) return undefined;

  const count = b.readUInt16BE(nameOff + 2);
  const strBase = nameOff + b.readUInt16BE(nameOff + 4);
  // nameID -> value, preferring the first Windows (platform 3) record we see.
  const byId = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12;
    if (r + 12 > b.length) break;
    const platform = b.readUInt16BE(r);
    const nameID = b.readUInt16BE(r + 6);
    const len = b.readUInt16BE(r + 8);
    const off = b.readUInt16BE(r + 10);
    if (![1, 2, 4, 16, 17].includes(nameID)) continue;
    const s = strBase + off;
    if (s + len > b.length || len === 0) continue;
    const val = platform === 1 ? b.toString("latin1", s, s + len) : utf16be(b, s, len);
    const clean = val.replace(/\0/g, "").trim();
    if (clean === "") continue;
    if (platform === 3 || !byId.has(nameID)) byId.set(nameID, clean);
  }

  const out: FontNames = {};
  const family = byId.get(16) ?? byId.get(1);
  const subfamily = byId.get(17) ?? byId.get(2);
  const fullName = byId.get(4);
  if (family) out.family = family;
  if (subfamily) out.subfamily = subfamily;
  if (fullName) out.fullName = fullName;
  return out.family || out.subfamily || out.fullName ? out : undefined;
}

function utf16be(b: Buffer, start: number, len: number): string {
  let s = "";
  for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(b.readUInt16BE(start + i));
  return s;
}
