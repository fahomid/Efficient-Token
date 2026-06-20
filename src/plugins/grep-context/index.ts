import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { splitLines, truncate } from "../../core/text.js";
import type { SymbolInfo } from "../../services/ast.js";
import { TYPE_EXTS } from "../../services/scan.js";

const DEFAULT_HEAD = 30;
const MAX_SCAN_FILES = 10_000;
const MAX_SYMBOL_LINES = 80;
const MAX_LINE = 400;

/**
 * Regex search that returns each match together with its enclosing symbol's
 * source (deduped, line-numbered, matched lines marked `›`), so the model gets
 * where it matched and the surrounding code in one call instead of searching
 * and then opening each file.
 */
export function grepContextPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "grep-context",
    version: "1.0.5",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "grep_context",
        title: "Search with context",
        description:
          "Regex search that returns, for each match, the enclosing function/class/method source (deduped, line-numbered, matched lines marked with ›): not just the line, and not the whole file. Use this instead of code_search + code_read when you want to see matches in their code context. Filter with glob/type; output is token-bounded. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          pattern: z.string().min(1).describe("Regular expression to search for."),
          path: z.string().optional().describe("File or directory to scope to (relative)."),
          glob: z.string().optional().describe('Only search files matching this glob.'),
          type: z.string().optional().describe('Only search this file type, e.g. "ts".'),
          caseInsensitive: z.boolean().optional().describe("Case-insensitive match."),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
          headLimit: z.number().int().positive().optional().describe(`Max blocks shown (default ${DEFAULT_HEAD}).`),
        },
        handler: async (args) => {
          try {
            const insensitive = args.caseInsensitive === true;
            let lineRe: RegExp;
            try {
              lineRe = new RegExp(String(args.pattern), insensitive ? "i" : "");
            } catch (e) {
              return fail(`invalid regex: ${errMessage(e)}`);
            }
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const head = args.headLimit === undefined ? DEFAULT_HEAD : Number(args.headLimit);
            const type = args.type === undefined ? undefined : String(args.type).toLowerCase();
            const exts = type ? TYPE_EXTS[type] ?? [type] : undefined;

            const scan = await ctx.scan.files({
              ...(args.path !== undefined ? { within: String(args.path) } : {}),
              ...(args.glob !== undefined ? { glob: String(args.glob) } : {}),
              ...(exts ? { exts } : {}),
              maxFiles: MAX_SCAN_FILES,
            });

            const budgetChars = maxTokens * 4;
            const blocks: string[] = [];
            let used = 0;
            let shown = 0;
            let matchCount = 0;
            let limited = false;

            const add = (block: string): boolean => {
              if (shown >= head || used + block.length + 2 > budgetChars) {
                limited = true;
                return false;
              }
              blocks.push(block);
              used += block.length + 2;
              shown++;
              return true;
            };

            for (const f of scan.files) {
              if (limited) break;
              const content = await readText(ctx, f.rel);
              if (content === undefined) continue;
              const lines = splitLines(content);
              const matched = new Set<number>(); // 0-based line indices
              for (let i = 0; i < lines.length; i++) {
                if (lineRe.test(lines[i]!)) matched.add(i);
              }
              if (matched.size === 0) continue;
              matchCount += matched.size;

              const outline = ctx.ast.supports(f.rel) ? await ctx.ast.outline(f.rel, content) : undefined;
              const bySymbol = new Map<string, SymbolInfo>();
              const scope: number[] = [];
              for (const i of [...matched].sort((a, b) => a - b)) {
                const sym = enclosing(outline, i + 1);
                if (sym) bySymbol.set(`${sym.startLine}:${sym.endLine}:${sym.name}`, sym);
                else scope.push(i);
              }

              for (const sym of [...bySymbol.values()].sort((a, b) => a.startLine - b.startLine)) {
                if (!add(renderSymbol(f.rel, sym, lines, matched))) break;
              }
              if (limited) break;
              for (const i of scope) {
                if (!add(`${f.rel}:${i + 1}: ${truncate(lines[i]!, MAX_LINE)}`)) break;
              }
            }

            if (blocks.length === 0) {
              return ok(`No matches for /${String(args.pattern)}/.`);
            }
            const note = limited || scan.truncated ? "\n\n[output bounded — narrow with path/glob/type or raise maxTokens/headLimit]" : "";
            return ok(`${matchCount}${limited ? "+" : ""} match(es) in ${shown} block(s):\n\n${blocks.join("\n\n")}${note}`);
          } catch (err) {
            return fail(`grep_context failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

function enclosing(outline: SymbolInfo[] | undefined, lineNo: number): SymbolInfo | undefined {
  if (!outline) return undefined;
  let best: SymbolInfo | undefined;
  for (const s of outline) {
    if (s.startLine <= lineNo && lineNo <= s.endLine) {
      if (!best || s.startLine > best.startLine) best = s; // innermost
    }
  }
  return best;
}

function renderSymbol(rel: string, sym: SymbolInfo, lines: string[], matched: Set<number>): string {
  const container = sym.container ? `${sym.container}.` : "";
  const header = `${rel} › ${sym.kind} ${container}${sym.name}  (L${sym.startLine}-${sym.endLine})`;
  const start = sym.startLine - 1;
  const end = Math.min(lines.length - 1, sym.endLine - 1, start + MAX_SYMBOL_LINES - 1);
  const width = String(end + 1).length;
  const body: string[] = [];
  for (let i = start; i <= end; i++) {
    const mark = matched.has(i) ? "›" : " ";
    body.push(`${mark}${String(i + 1).padStart(width)}| ${truncate(lines[i]!, MAX_LINE)}`);
  }
  if (sym.endLine - 1 > end) {
    body.push(`  … (${sym.endLine - 1 - end} more line(s); use code_read symbol=${sym.name})`);
  }
  return `${header}\n${body.join("\n")}`;
}

async function readText(ctx: CoreContext, rel: string): Promise<string | undefined> {
  try {
    const { content } = await ctx.fs.read(rel);
    return content.includes(String.fromCharCode(0)) ? undefined : content; // skip binary
  } catch {
    return undefined;
  }
}
