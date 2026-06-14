import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";

const TAG_RE = /<([a-zA-Z][\w:-]*)\b/g;
const ATTR_RE = /([\w:-]+)\s*=\s*["']([^"']*)["']/g;
const ID_RE = /\bid\s*=\s*["']([^"']+)["']/g;
const MAX_IDS = 80;

/**
 * `svg_digest` — the STRUCTURE of an SVG (viewBox, intrinsic size, element
 * histogram, defined ids) instead of dumping the full markup with its long
 * path/`d` data. A structural digest like code_outline — use code_read for the
 * actual markup of a region. Read-only. Free tier.
 */
export function svgDigestPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "svg-digest",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "svg_digest",
        title: "SVG digest",
        description:
          "Summarize an SVG's structure — viewBox, intrinsic width/height, an element-type histogram, and defined ids — without dumping the verbose markup and path data. Use this to understand/locate parts of an SVG cheaply; use code_read for the actual markup of a region. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          path: z.string().describe("Path to an .svg file (relative to the workspace root)."),
          maxTokens: z.number().int().positive().optional().describe("Bound output size (default: server read budget)."),
        },
        handler: async (args) => {
          try {
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const { content, abs } = await ctx.fs.read(String(args.path));
            const rel = ctx.paths.relative(abs);
            if (!/<svg[\s>]/i.test(content)) return fail(`${rel} does not look like an SVG (no <svg> root).`);

            const root = /<svg\b[^>]*>/i.exec(content)?.[0] ?? "";
            const rootAttrs = attrsOf(root);
            const viewBox = rootAttrs.viewbox ?? "(none)";
            const width = rootAttrs.width ?? "(auto)";
            const height = rootAttrs.height ?? "(auto)";

            const counts = new Map<string, number>();
            let m: RegExpExecArray | null;
            TAG_RE.lastIndex = 0;
            while ((m = TAG_RE.exec(content)) !== null) {
              const tag = m[1]!.toLowerCase();
              counts.set(tag, (counts.get(tag) ?? 0) + 1);
            }
            const total = [...counts.values()].reduce((a, b) => a + b, 0);
            const histogram = [...counts.entries()]
              .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
              .map(([t, n]) => `${t}×${n}`)
              .join(", ");

            const ids: string[] = [];
            ID_RE.lastIndex = 0;
            while ((m = ID_RE.exec(content)) !== null && ids.length < MAX_IDS) ids.push(m[1]!);

            const parts = [
              `svg_digest: ${rel}`,
              `  viewBox: ${viewBox}`,
              `  width: ${width}  height: ${height}`,
              `  ${total} element(s): ${histogram}`,
            ];
            if (ids.length > 0) parts.push(`  ids (${ids.length}${ids.length >= MAX_IDS ? "+" : ""}): ${ids.join(", ")}`);

            let out = parts.join("\n");
            const budget = maxTokens * 4;
            if (out.length > budget) out = `${out.slice(0, budget)}\n[truncated — raise maxTokens]`;
            return ok(out);
          } catch (err) {
            return fail(`svg_digest failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(tag)) !== null) out[m[1]!.toLowerCase()] = m[2]!;
  return out;
}
