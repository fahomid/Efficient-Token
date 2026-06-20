import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import type { SymbolInfo } from "../../services/ast.js";

/** List a file's symbols (not its source). */
export function codeOutlinePlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "code-outline",
    version: "1.0.5",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "code_outline",
        title: "Code outline",
        description:
          "List the symbols (functions, classes, methods, types) defined in a source file with line ranges and signatures, not the full source. Prefer this over reading a whole file when you only need its shape, then fetch one symbol with code_read.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          path: z
            .string()
            .describe("File path relative to the workspace root."),
          maxTokens: z.number().int().positive().optional().describe("Output token budget (a very large outline is bounded, with the count disclosed)."),
        },
        handler: async (args) => {
          try {
            const p = String(args.path);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const { content, abs } = await ctx.fs.read(p);
            const rel = ctx.paths.relative(abs);
            const symbols = await ctx.ast.outline(p, content);
            if (symbols === undefined) {
              return ok(
                `${rel} — no grammar for this file type; use code_read to read its contents.`,
              );
            }
            if (symbols.length === 0) {
              return ok(
                `${rel} — no symbols found; use code_read to read its contents.`,
              );
            }
            const out = renderOutline(rel, symbols, maxTokens);
            ctx.savings.record("outline", content.length, out.length);
            return ok(out);
          } catch (err) {
            return fail(`code_outline failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

function renderOutline(rel: string, symbols: SymbolInfo[], maxTokens: number): string {
  // Bound a very large outline (a file with thousands of symbols) to the token
  // budget rather than dumping it, and disclose the count — like repo_map.
  const budgetChars = Math.max(2000, maxTokens * 4);
  const blocks: string[] = [];
  let used = 0;
  for (const s of symbols) {
    const container = s.container ? `${s.container}.` : "";
    const doc = s.hasDoc ? "" : "  [no doc]";
    const block = `L${s.startLine}-${s.endLine}  ${s.kind} ${container}${s.name}${doc}\n    ${s.signature}`;
    if (blocks.length > 0 && used + block.length + 1 > budgetChars) break;
    blocks.push(block);
    used += block.length + 1;
    if (used >= budgetChars) break;
  }
  const omitted = symbols.length - blocks.length;
  const header = `${rel} — ${symbols.length} symbol(s)${omitted > 0 ? ` (showing ${blocks.length}; ${omitted} more — raise maxTokens or fetch a symbol with code_read)` : ""}`;
  return [header, ...blocks].join("\n");
}
