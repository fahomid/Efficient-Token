import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { fontNames } from "../../core/font-meta.js";
import { errMessage, fail, ok } from "../../core/result.js";

const FONT_MAX_BYTES = 30 * 1024 * 1024;
const FACE_RE = /@font-face\s*\{([^}]*)\}/gi;

/**
 * Reports the family, style, and weights a font actually provides, instead of
 * guessing from a filename. Reads the family and subfamily from TTF/OTF files
 * via the `name` table (no dependencies), and extracts `@font-face` declarations
 * (family, weight, style, src) from CSS.
 */
export function fontInfoPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "font-info",
    version: "1.0.2",
    tier: "free",
    group: "design",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "font_info",
        title: "Font info",
        description:
          "Report the real family/style of fonts instead of guessing from filenames: the family + subfamily from TTF/OTF files (name table), and @font-face declarations (family, weight, style, src) from CSS. WOFF/WOFF2 report format only (check @font-face). Pass font and/or CSS paths. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          paths: z.array(z.string()).min(1).describe("Font (.ttf/.otf/.woff/.woff2) and/or CSS file path(s)."),
        },
        handler: async (args) => {
          try {
            const paths = (args.paths as unknown[]).map(String);
            const lines: string[] = [];
            for (const p of paths) {
              const ext = extOf(p);
              try {
                if (ext === "ttf" || ext === "otf") {
                  const { abs, bytes } = await ctx.fs.readBytes(p, FONT_MAX_BYTES);
                  const rel = ctx.paths.relative(abs);
                  const n = fontNames(bytes);
                  if (n) {
                    const sub = n.subfamily ? `, subfamily "${n.subfamily}"` : "";
                    lines.push(`  ${rel}: family "${n.family ?? n.fullName ?? "?"}"${sub}, ${bytes.length} bytes`);
                  } else {
                    lines.push(`  ${rel}: ${ext} (no name table), ${bytes.length} bytes`);
                  }
                } else if (ext === "woff" || ext === "woff2") {
                  const abs = ctx.paths.resolve(p);
                  lines.push(`  ${ctx.paths.relative(abs)}: ${ext} (binary; family via @font-face)`);
                } else if (ext === "css" || ext === "scss" || ext === "less") {
                  const { content, abs } = await ctx.fs.read(p);
                  const rel = ctx.paths.relative(abs);
                  const faces = parseFontFaces(content);
                  if (faces.length === 0) lines.push(`  ${rel}: (no @font-face)`);
                  for (const f of faces) lines.push(`  ${rel}: @font-face ${f}`);
                } else {
                  lines.push(`  ${p}: unsupported (${ext})`);
                }
              } catch (e) {
                lines.push(`  ${p}: ${errMessage(e)}`);
              }
            }
            return ok(`font_info — ${paths.length} path(s):\n${lines.join("\n")}`);
          } catch (err) {
            return fail(`font_info failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

function parseFontFaces(css: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  FACE_RE.lastIndex = 0;
  while ((m = FACE_RE.exec(css)) !== null) {
    const body = m[1]!;
    const family = decl(body, "font-family")?.replace(/['"]/g, "");
    const weight = decl(body, "font-weight");
    const style = decl(body, "font-style");
    const src = (decl(body, "src") ?? "").match(/url\(([^)]+)\)/i)?.[1]?.replace(/['"]/g, "");
    const parts = [family ? `family "${family}"` : "family ?"];
    if (weight) parts.push(`weight ${weight}`);
    if (style) parts.push(`style ${style}`);
    if (src) parts.push(`src ${src.split(/[\\/]/).pop()}`);
    out.push(parts.join(" "));
  }
  return out;
}

function decl(body: string, prop: string): string | undefined {
  const m = new RegExp(`${prop}\\s*:\\s*([^;]+)`, "i").exec(body);
  return m ? m[1]!.trim() : undefined;
}

function extOf(p: string): string {
  const dot = p.lastIndexOf(".");
  return dot === -1 ? "" : p.slice(dot + 1).toLowerCase();
}
