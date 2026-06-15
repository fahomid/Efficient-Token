import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { enclosingSymbol } from "../../core/diff.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { splitLines, truncate } from "../../core/text.js";
import { TYPE_EXTS } from "../../services/scan.js";

const DEFAULT_HEAD = 100;
const MAX_SCAN_FILES = 10_000;

/**
 * `call_sites` — where a symbol is actually CALLED (AST-precise: the callee of a
 * call/invocation), not text matches like find_references/code_search would give
 * (which include imports, type annotations, comments, value-passing). Each hit
 * is `file:line  enclosing.symbol  ›<call line>`. Read-only. Free tier.
 */
export function callSitesPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "call-sites",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "call_sites",
        title: "Find call sites",
        description:
          "Find where a function/method is actually CALLED (AST callee), not text matches. Distinct from find_references (counts imports/types/comments) and code_search (raw regex). Each hit: file:line + enclosing symbol + the call line. TS/JS, Python, Go, Rust, Java, C/C++, Ruby. Scope with path/glob/type. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          symbol: z.string().min(1).describe("The function/method name being called."),
          path: z.string().optional().describe("Directory/file to scope to (relative)."),
          glob: z.string().optional().describe("Only consider files matching this glob."),
          type: z.string().optional().describe('Only this file type, e.g. "ts", "py".'),
          headLimit: z.number().int().positive().optional().describe(`Max call sites to return (default ${DEFAULT_HEAD}).`),
          maxTokens: z.number().int().positive().optional().describe("Bound output size (default: server read budget)."),
        },
        handler: async (args) => {
          try {
            const symbol = String(args.symbol);
            const head = args.headLimit === undefined ? DEFAULT_HEAD : Number(args.headLimit);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const type = args.type === undefined ? undefined : String(args.type).toLowerCase();
            const exts = type ? TYPE_EXTS[type] ?? [type] : undefined;

            const scan = await ctx.scan.files({
              ...(args.path !== undefined ? { within: String(args.path) } : {}),
              ...(args.glob !== undefined ? { glob: String(args.glob) } : {}),
              ...(exts ? { exts } : {}),
              maxFiles: MAX_SCAN_FILES,
            });

            const budgetChars = maxTokens * 4;
            const hits: string[] = [];
            let total = 0;
            let used = 0;
            let analyzable = false;
            let capped = false;

            for (const f of scan.files) {
              if (!ctx.ast.supports(f.rel)) continue;
              const content = await readText(ctx, f.rel);
              if (content === undefined) continue;
              const callLines = await ctx.ast.findCallLines(f.rel, content, symbol);
              if (callLines === undefined) continue; // grammar has no call mapping
              analyzable = true;
              if (callLines.length === 0) continue;

              const lines = splitLines(content);
              const outline = (await ctx.ast.outline(f.rel, content)) ?? [];
              for (const L of callLines) {
                total++;
                if (hits.length >= head || capped) continue;
                const sym = enclosingSymbol(outline, L);
                const callText = truncate((lines[L - 1] ?? "").trim(), 160);
                const line = `  ${f.rel}:${L}  ${sym ? `${sym.container ? `${sym.container}.` : ""}${sym.name}` : "(top level)"}  ›${callText}`;
                if (used + line.length + 1 > budgetChars) {
                  capped = true;
                  continue;
                }
                hits.push(line);
                used += line.length + 1;
              }
            }

            if (!analyzable) {
              return ok(`No call-site analysis available for the scanned files (unsupported language for "${symbol}"). Try find_references.`);
            }
            if (total === 0) return ok(`No call sites for "${symbol}" found.`);
            const shownCapped = capped || total > hits.length || scan.truncated;
            const note = shownCapped ? "\n[results bounded — narrow with path/type/glob or raise headLimit/maxTokens]" : "";
            return ok(`${total}${shownCapped ? "+" : ""} call site(s) of "${symbol}":\n${hits.join("\n")}${note}`);
          } catch (err) {
            return fail(`call_sites failed: ${errMessage(err)}`);
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
