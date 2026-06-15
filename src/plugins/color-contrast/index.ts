import { z } from "zod";

import type { Plugin } from "../../core/contract.js";
import { fail, ok } from "../../core/result.js";

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Readonly<Record<string, string>> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff",
  yellow: "#ffff00", cyan: "#00ffff", magenta: "#ff00ff", gray: "#808080", grey: "#808080",
  silver: "#c0c0c0", maroon: "#800000", olive: "#808000", lime: "#00ff00", teal: "#008080",
  navy: "#000080", purple: "#800080", orange: "#ffa500", transparent: "#00000000",
};

/**
 * Deterministic color math: the WCAG contrast ratio (with AA/AAA pass/fail)
 * between two colors, or convert one color between hex, rgb, and hsl. This saves
 * the model doing the luminance and ratio arithmetic itself. Pure, no I/O.
 */
export function colorContrastPlugin(): Plugin {
  return {
    name: "color-contrast",
    version: "0.1.0",
    tier: "free",
    group: "design",
    tools: [
      {
        name: "color_contrast",
        title: "Color contrast / convert",
        description:
          "Color math without doing it by hand: give two colors to get their WCAG contrast ratio and AA/AAA pass-fail (normal and large text); give one color to convert it between hex, rgb, and hsl. Accepts #hex (3/4/6/8), rgb()/rgba(), hsl()/hsla(), and common color names. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          color: z.string().min(1).describe("A color: #hex, rgb()/rgba(), hsl()/hsla(), or a common name."),
          against: z.string().optional().describe("A second color; if given, returns the contrast ratio and AA/AAA verdicts instead of conversions."),
        },
        handler: async (args) => {
          try {
            const a = parseColor(String(args.color));
            if (!a) return fail(`could not parse color: ${JSON.stringify(String(args.color))}`);

            if (args.against !== undefined) {
              const b = parseColor(String(args.against));
              if (!b) return fail(`could not parse color: ${JSON.stringify(String(args.against))}`);
              const ratio = contrast(a, b);
              const r = round2(ratio);
              const verdict = (min: number): string => (ratio >= min ? "PASS" : "FAIL");
              return ok(
                `color_contrast: ${toHex(a)} vs ${toHex(b)}\n` +
                  `  contrast ratio: ${r}:1\n` +
                  `  AA  normal (>=4.5): ${verdict(4.5)}\n` +
                  `  AA  large  (>=3.0): ${verdict(3)}\n` +
                  `  AAA normal (>=7.0): ${verdict(7)}\n` +
                  `  AAA large  (>=4.5): ${verdict(4.5)}`,
              );
            }

            return ok(`color: ${String(args.color)}\n  hex: ${toHex(a)}\n  rgb: ${toRgb(a)}\n  hsl: ${toHsl(a)}`);
          } catch (err) {
            return fail(`color_contrast failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      },
    ],
  };
}

function parseColor(input: string): Rgb | undefined {
  let s = input.trim().toLowerCase();
  const named = NAMED[s];
  if (named) s = named;
  if (s.startsWith("#")) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length === 6) h += "ff";
    if (h.length !== 8 || !/^[0-9a-f]{8}$/.test(h)) return undefined;
    return { r: hx(h, 0), g: hx(h, 2), b: hx(h, 4), a: hx(h, 6) / 255 };
  }
  let m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1]!.split(/[,/]/).map((x) => x.trim());
    if (p.length < 3) return undefined;
    const r = chan(p[0]!), g = chan(p[1]!), b = chan(p[2]!);
    if (r === undefined || g === undefined || b === undefined) return undefined;
    return { r, g, b, a: p[3] !== undefined ? clamp01(Number(p[3]!)) : 1 };
  }
  m = /^hsla?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1]!.split(/[,/]/).map((x) => x.trim());
    if (p.length < 3) return undefined;
    const h = Number(p[0]!.replace("deg", ""));
    const sat = Number(p[1]!.replace("%", "")) / 100;
    const lig = Number(p[2]!.replace("%", "")) / 100;
    if (![h, sat, lig].every(Number.isFinite)) return undefined;
    return { ...hslToRgb(h, sat, lig), a: p[3] !== undefined ? clamp01(Number(p[3]!)) : 1 };
  }
  return undefined;
}

function chan(s: string): number | undefined {
  const v = s.endsWith("%") ? (Number(s.slice(0, -1)) / 100) * 255 : Number(s);
  return Number.isFinite(v) ? clampByte(Math.round(v)) : undefined;
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function luminance({ r, g, b }: Rgb): number {
  const f = (c: number): number => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

function toHex(c: Rgb): string {
  const h = (n: number): string => n.toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a < 1 ? h(Math.round(c.a * 255)) : ""}`;
}

function toRgb(c: Rgb): string {
  return c.a < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${round2(c.a)})` : `rgb(${c.r}, ${c.g}, ${c.b})`;
}

function toHsl(c: Rgb): string {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const hsl = `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
  return c.a < 1 ? hsl.replace("hsl(", "hsla(").replace(")", `, ${round2(c.a)})`) : hsl;
}

function hx(h: string, i: number): number {
  return parseInt(h.slice(i, i + 2), 16);
}
function clampByte(n: number): number {
  return Math.max(0, Math.min(255, n));
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 1));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
