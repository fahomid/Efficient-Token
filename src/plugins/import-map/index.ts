import path from "node:path";

import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { splitLines } from "../../core/text.js";

const JS_EXTS = ["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx"];
const MAX_SCAN_FILES = 10_000;
const ciFs = process.platform === "win32" || process.platform === "darwin";

/**
 * Maps a file's dependency edges: what it imports (deps) and/or who imports it
 * (importers), resolved across the workspace, instead of grepping for import
 * lines and resolving paths by hand. Handles the JS/TS family.
 */
export function importMapPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "import-map",
    version: "1.0.3",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "import_map",
        title: "Import map",
        description:
          "Show a file's import edges: imports (what it depends on: workspace files vs external packages) and/or importers (which workspace files import it), resolved across the workspace, instead of grepping import lines and resolving paths by hand. direction: both (default) | imports | importers. JS/TS family (.ts/.tsx/.js/.mjs/…). Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          path: z.string().describe("File path relative to the workspace root."),
          direction: z.enum(["both", "imports", "importers"]).optional().describe('"both" (default) | "imports" (deps) | "importers" (dependents).'),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
        },
        handler: async (args) => {
          try {
            const p = String(args.path);
            const direction = (args.direction as string | undefined) ?? "both";
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const budgetChars = maxTokens * 4;

            const targetAbs = ctx.paths.resolve(p); // sandbox check
            const rel = ctx.paths.relative(targetAbs);
            const targetKey = stripExt(targetAbs);

            const sections: string[] = [`import_map: ${rel}`];

            if (direction === "imports" || direction === "both") {
              const content = await readText(ctx, rel);
              if (content === undefined) {
                sections.push("\nimports: (file unreadable)");
              } else {
                const imports = extractImports(content);
                if (imports.length === 0) {
                  sections.push("\nimports: (none found)");
                } else {
                  const rows = imports.map((im) => {
                    if (isRelative(im.spec)) {
                      const resolved = resolveSpec(targetAbs, im.spec);
                      return `  L${im.line}  ${im.spec}  -> ${displayRel(ctx.config.root, resolved)}`;
                    }
                    return `  L${im.line}  ${im.spec}  [external]`;
                  });
                  sections.push(`\nimports (${imports.length}):\n${rows.join("\n")}`);
                }
              }
            }

            if (direction === "importers" || direction === "both") {
              const scan = await ctx.scan.files({ exts: JS_EXTS, maxFiles: MAX_SCAN_FILES });
              const importers: string[] = [];
              for (const f of scan.files) {
                if (sameFile(f.abs, targetAbs)) continue;
                const content = await readText(ctx, f.rel);
                if (content === undefined) continue;
                if (!content.includes("import") && !content.includes("require")) continue;
                for (const im of extractImports(content)) {
                  if (!isRelative(im.spec)) continue;
                  const resolved = resolveSpec(f.abs, im.spec);
                  if (resolved.toLowerCase() === targetKey.toLowerCase()) {
                    importers.push(`  ${f.rel}:${im.line}`);
                    break;
                  }
                }
              }
              const note = scan.truncated ? "  [scan incomplete — >10k files]" : "";
              sections.push(importers.length ? `\nimporters (${importers.length}):${note}\n${importers.join("\n")}` : `\nimporters: (none)${note}`);
            }

            let body = sections.join("\n");
            if (body.length > budgetChars) {
              const cut = body.lastIndexOf("\n", budgetChars);
              body = `${body.slice(0, cut > 0 ? cut : budgetChars)}\n[truncated — raise maxTokens or use direction=]`;
            }
            return ok(body);
          } catch (err) {
            return fail(`import_map failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

interface ImportRef {
  line: number;
  spec: string;
}

const SPEC_RES = [
  /\b(?:import|export)\b[^'"`\n]*?\bfrom\s*['"]([^'"]+)['"]/,
  /\bimport\s*['"]([^'"]+)['"]/,
  /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/,
];

/** Extract import/require/from specifiers (JS/TS), with 1-based line numbers. */
function extractImports(content: string): ImportRef[] {
  const out: ImportRef[] = [];
  const seen = new Set<string>();
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 2000) continue;
    for (const re of SPEC_RES) {
      const g = new RegExp(re.source, "g");
      let m: RegExpExecArray | null;
      while ((m = g.exec(line)) !== null) {
        const spec = m[1]!;
        const key = `${i}:${spec}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ line: i + 1, spec });
        }
      }
    }
  }
  return out;
}

function isRelative(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/");
}

/** Extensionless absolute identity of a relative import (handles .js->.ts and /index). */
function resolveSpec(importerAbs: string, spec: string): string {
  return stripExt(path.resolve(path.dirname(importerAbs), spec));
}

/** Workspace-relative (forward-slashed) display of an extensionless module path. */
function displayRel(root: string, absNoExt: string): string {
  return path.relative(root, absNoExt).replace(/\\/g, "/");
}

function stripExt(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const dot = norm.lastIndexOf(".");
  const slash = norm.lastIndexOf("/");
  // Drop a trailing `/index` so `./core` and `./core/index` are the same module.
  const noExt = dot > slash ? norm.slice(0, dot) : norm;
  return noExt.replace(/\/index$/, "");
}

function sameFile(a: string, b: string): boolean {
  const na = a.replace(/\\/g, "/");
  const nb = b.replace(/\\/g, "/");
  return ciFs ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

async function readText(ctx: CoreContext, rel: string): Promise<string | undefined> {
  try {
    const { content } = await ctx.fs.read(rel);
    return content.includes(String.fromCharCode(0)) ? undefined : content;
  } catch {
    return undefined;
  }
}
