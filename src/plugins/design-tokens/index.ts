import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";

const MAX_SCAN_FILES = 5000;
const MAX_TOKENS_OUT = 2000;
const CSS_VAR_RE = /--([A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g;
const COLOR_RE = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklch|oklab|color)\()/i;
const SIZE_RE = /^-?[\d.]+(px|rem|em|%|vh|vw|vmin|vmax|pt|pc|ch|ex|fr|deg|turn|ms|s)?$/i;
const FONT_NAME_RE = /font|family|weight|leading|line-?height|tracking|letter|text-/i;

type Category = "color" | "size" | "font" | "other";

interface Token {
  name: string;
  value: string;
  source: string;
  category: Category;
}

/**
 * `design_tokens` — distill a project's design tokens (colors, spacing,
 * typography) from CSS custom properties and design-token JSON, instead of
 * re-reading large stylesheets/config every turn. Verbatim name=value pairs,
 * classified by value form. Deterministic — never judges quality. Read-only.
 */
export function designTokensPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "design-tokens",
    version: "0.1.0",
    tier: "free",
    group: "design",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "design_tokens",
        title: "Design tokens",
        description:
          "Extract design tokens (colors, sizes/spacing, typography) as verbatim name=value pairs from CSS custom properties (--var) and design-token JSON, grouped by kind — instead of re-reading whole stylesheets/configs. Pass paths, or omit to auto-discover .css and token/theme .json files. Filter with category (color|size|font|all). Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          paths: z.array(z.string()).optional().describe("Files to read (.css / token .json). Omit to auto-discover."),
          category: z.enum(["color", "size", "font", "all"]).optional().describe('Limit to a kind (default "all").'),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
        },
        handler: async (args) => {
          try {
            const category = (args.category as string | undefined) ?? "all";
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);

            const files = args.paths !== undefined ? (args.paths as unknown[]).map(String) : await discover(ctx);
            if (files.length === 0) {
              return ok("No design-token sources found (looked for .css and token/theme .json). Pass paths to target specific files.");
            }

            const tokens: Token[] = [];
            for (const f of files) {
              if (tokens.length > MAX_TOKENS_OUT) break;
              let content: string;
              let rel: string;
              try {
                const r = await ctx.fs.read(f);
                content = r.content;
                rel = ctx.paths.relative(r.abs);
              } catch {
                continue;
              }
              if (f.toLowerCase().endsWith(".json")) extractJson(content, rel, tokens);
              else extractCss(content, rel, tokens);
            }

            const wanted = category === "all" ? tokens : tokens.filter((t) => t.category === category);
            if (wanted.length === 0) {
              return ok(`No ${category === "all" ? "" : `${category} `}tokens found in ${files.length} file(s).`);
            }

            const budgetChars = maxTokens * 4;
            const order: Category[] = ["color", "size", "font", "other"];
            const out: string[] = [`design_tokens — ${wanted.length} token(s) from ${files.length} file(s):`];
            let used = out[0]!.length;
            let truncated = false;
            for (const cat of order) {
              const group = wanted.filter((t) => t.category === cat);
              if (group.length === 0) continue;
              const head = `\n${cat} (${group.length}):`;
              if (used + head.length > budgetChars) {
                truncated = true;
                break;
              }
              out.push(head);
              used += head.length;
              for (const t of group) {
                const row = `  --${t.name} = ${t.value}  [${t.source}]`;
                if (used + row.length + 1 > budgetChars) {
                  truncated = true;
                  break;
                }
                out.push(row);
                used += row.length + 1;
              }
              if (truncated) break;
            }
            return ok(out.join("\n") + (truncated ? "\n[truncated — filter with category/paths or raise maxTokens]" : ""));
          } catch (err) {
            return fail(`design_tokens failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

async function discover(ctx: CoreContext): Promise<string[]> {
  const css = await ctx.scan.files({ exts: ["css"], maxFiles: MAX_SCAN_FILES });
  const json = await ctx.scan.files({ exts: ["json"], maxFiles: MAX_SCAN_FILES });
  const tokenJson = json.files.filter((f) => /token|theme|design/i.test(f.rel.split("/").pop() ?? ""));
  return [...css.files, ...tokenJson].map((f) => f.rel);
}

function extractCss(content: string, source: string, out: Token[]): void {
  CSS_VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = CSS_VAR_RE.exec(content)) !== null) {
    const name = m[1]!;
    const value = m[2]!.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, value, source, category: classify(name, value) });
  }
}

function extractJson(content: string, source: string, out: Token[]): void {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return;
  }
  flatten(data, "", source, out, 0);
}

function flatten(node: unknown, prefix: string, source: string, out: Token[], depth: number): void {
  if (depth > 12 || out.length > MAX_TOKENS_OUT) return;
  if (node !== null && typeof node === "object" && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    // W3C / Style Dictionary leaf: { $value | value: <primitive> }
    const leaf = obj.$value ?? obj.value;
    if (leaf !== undefined && (typeof leaf !== "object" || leaf === null) && prefix !== "") {
      out.push({ name: prefix, value: String(leaf), source, category: classify(prefix, String(leaf)) });
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith("$")) continue; // token metadata ($type/$description)
      flatten(v, prefix ? `${prefix}-${k}` : k, source, out, depth + 1);
    }
  } else if (node !== null && typeof node !== "object" && prefix !== "") {
    out.push({ name: prefix, value: String(node), source, category: classify(prefix, String(node)) });
  }
}

function classify(name: string, value: string): Category {
  const v = value.trim();
  if (COLOR_RE.test(v)) return "color";
  if (SIZE_RE.test(v) && /[\d]/.test(v)) return "size";
  if (FONT_NAME_RE.test(name)) return "font";
  return "other";
}
