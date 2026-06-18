import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { truncate } from "../../core/text.js";
import { TYPE_EXTS } from "../../services/scan.js";

const DEFAULT_HEAD = 50;
const MAX_SCAN_FILES = 10_000;

/**
 * Locates where symbols are defined across the workspace by name (exact, or
 * `substring` for fuzzy recall), returning `file:line  kind name signature`.
 * Unlike find_references (exact-name usages) and code_search (raw text), this
 * finds the definition of the thing called X.
 */
export function symbolFindPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "symbol-find",
    version: "1.0.3",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "symbol_find",
        title: "Find a symbol definition",
        description:
          "Find where symbols are defined by name: exact, or substring=true for fuzzy recall. Returns file:line, kind, and signature per definition, with an optional kind filter. Jump to a definition you half-remember instead of grepping. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          name: z.string().min(1).describe("Symbol name (or substring with substring=true)."),
          substring: z.boolean().optional().describe("Match the name as a substring (fuzzy) instead of exact."),
          kind: z.string().optional().describe('Only this kind, e.g. "class", "function", "method".'),
          caseInsensitive: z.boolean().optional().describe("Case-insensitive name match."),
          path: z.string().optional().describe("Directory/file to scope to (relative)."),
          glob: z.string().optional().describe("Only consider files matching this glob."),
          type: z.string().optional().describe('Only this file type, e.g. "ts".'),
          headLimit: z.number().int().positive().optional().describe(`Max results (default ${DEFAULT_HEAD}).`),
        },
        handler: async (args) => {
          try {
            const name = String(args.name);
            const substring = args.substring === true;
            const insensitive = args.caseInsensitive === true;
            const needle = insensitive ? name.toLowerCase() : name;
            const kindFilter = args.kind === undefined ? undefined : String(args.kind).toLowerCase();
            const head = args.headLimit === undefined ? DEFAULT_HEAD : Number(args.headLimit);
            const type = args.type === undefined ? undefined : String(args.type).toLowerCase();
            const exts = type ? TYPE_EXTS[type] ?? [type] : undefined;

            const matchName = (n: string): boolean => {
              const h = insensitive ? n.toLowerCase() : n;
              return substring ? h.includes(needle) : h === needle;
            };

            const scan = await ctx.scan.files({
              ...(args.path !== undefined ? { within: String(args.path) } : {}),
              ...(args.glob !== undefined ? { glob: String(args.glob) } : {}),
              ...(exts ? { exts } : {}),
              maxFiles: MAX_SCAN_FILES,
            });

            const hits: string[] = [];
            let total = 0;
            for (const f of scan.files) {
              if (!ctx.ast.supports(f.rel)) continue;
              const content = await readText(ctx, f.rel);
              if (content === undefined) continue;
              for (const s of (await ctx.ast.outline(f.rel, content)) ?? []) {
                if (!matchName(s.name)) continue;
                if (kindFilter !== undefined && s.kind.toLowerCase() !== kindFilter) continue;
                total++;
                if (hits.length < head) {
                  const container = s.container ? `${s.container}.` : "";
                  hits.push(`  ${f.rel}:${s.startLine}  ${s.kind} ${container}${s.name}  ${truncate(s.signature, 120)}`);
                }
              }
            }

            const how = substring ? "containing" : "named";
            if (total === 0) {
              const inc = scan.truncated
                ? `\n[scan incomplete — over ${MAX_SCAN_FILES} files; it may be defined in an unscanned file — narrow with kind/type/path]`
                : "";
              return ok(`No symbol ${how} "${name}" found.${inc}`);
            }
            const capped = total > hits.length;
            const note = capped || scan.truncated ? "\n[results bounded — narrow with kind/type/path or raise headLimit]" : "";
            return ok(`${total}${capped ? "+" : ""} symbol(s) ${how} "${name}":\n${hits.join("\n")}${note}`);
          } catch (err) {
            return fail(`symbol_find failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

async function readText(ctx: CoreContext, rel: string): Promise<string | undefined> {
  try {
    const { content } = await ctx.fs.read(rel);
    return content.includes(String.fromCharCode(0)) ? undefined : content; // skip binary
  } catch {
    return undefined;
  }
}
