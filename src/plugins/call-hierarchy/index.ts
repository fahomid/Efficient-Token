import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { enclosingSymbol } from "../../core/diff.js";
import { errMessage, fail, ok } from "../../core/result.js";
import type { SymbolInfo } from "../../services/ast.js";
import { TYPE_EXTS } from "../../services/scan.js";

const MAX_SCAN_FILES = 10_000;
const DEFAULT_HEAD = 60;

/**
 * Report the local call neighborhood of a function in one call: its callees
 * (functions it calls, with where each is defined) and its callers (workspace
 * call sites). This avoids running call_sites then reading the body to find
 * callees. Resolution is AST-precise.
 */
export function callHierarchyPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "call-hierarchy",
    version: "1.0.4",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "call_hierarchy",
        title: "Call hierarchy",
        description:
          "The call neighborhood of a function in one call: its callees (functions it calls, each annotated with where it's defined if in the workspace) and its callers (workspace call sites). AST-precise: real calls, not text. Pass symbol, plus an optional path to disambiguate. For callers only, call_sites is lighter. Supported: TS/JS, Python, Go, Rust, Java, C/C++, Ruby. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          symbol: z.string().min(1).describe("The function/method name."),
          path: z.string().optional().describe("File the symbol is defined in / scope to (relative)."),
          type: z.string().optional().describe('Only this file type, e.g. "ts".'),
          headLimit: z.number().int().positive().optional().describe(`Max callers + callees to list (default ${DEFAULT_HEAD}).`),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
        },
        handler: async (args) => {
          try {
            const symbol = String(args.symbol);
            const head = args.headLimit === undefined ? DEFAULT_HEAD : Number(args.headLimit);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const type = args.type === undefined ? undefined : String(args.type).toLowerCase();
            const exts = type ? TYPE_EXTS[type] ?? [type] : undefined;
            const scopePath = args.path === undefined ? undefined : String(args.path);

            const scan = await ctx.scan.files({
              ...(scopePath !== undefined ? { within: scopePath } : {}),
              ...(exts ? { exts } : {}),
              maxFiles: MAX_SCAN_FILES,
            });

            const defIndex = new Map<string, { rel: string; line: number; kind: string }>();
            const callers: string[] = [];
            let target: { rel: string; content: string; sym: SymbolInfo } | undefined;
            let callersTotal = 0;

            for (const f of scan.files) {
              if (!ctx.ast.supports(f.rel)) continue;
              const content = await readText(ctx, f.rel);
              if (content === undefined) continue;
              const outline = (await ctx.ast.outline(f.rel, content)) ?? [];
              for (const s of outline) {
                if (!defIndex.has(s.name)) defIndex.set(s.name, { rel: f.rel, line: s.startLine, kind: s.kind });
                if (s.name === symbol && target === undefined) target = { rel: f.rel, content, sym: s };
              }
              if (content.includes(symbol)) {
                const callLines = (await ctx.ast.findCallLines(f.rel, content, symbol)) ?? [];
                for (const L of callLines) {
                  callersTotal++;
                  if (callers.length < head) {
                    const within = enclosingSymbol(outline, L);
                    callers.push(`  ${f.rel}:${L}${within ? `  (${within.container ? `${within.container}.` : ""}${within.name})` : ""}`);
                  }
                }
              }
            }

            if (target === undefined) {
              const inc = scan.truncated ? ` (scan stopped at ${MAX_SCAN_FILES} files — it may be defined beyond; narrow with path/type)` : "";
              return fail(`symbol "${symbol}" not found as a definition${scopePath ? ` under ${scopePath}` : ""}${inc}.`);
            }

            // Callees: distinct call names within the target's span, annotated.
            const allCalls = (await ctx.ast.findCalls(target.rel, target.content)) ?? [];
            const calleeNames = new Set<string>();
            for (const c of allCalls) {
              if (c.line >= target.sym.startLine && c.line <= target.sym.endLine && c.name !== symbol) {
                calleeNames.add(c.name);
              }
            }
            const callees: string[] = [];
            for (const name of [...calleeNames].sort()) {
              if (callees.length >= head) break;
              const def = defIndex.get(name);
              callees.push(`  ${name}${def ? `  -> ${def.kind} at ${def.rel}:${def.line}` : "  (external/unresolved)"}`);
            }

            const budgetChars = maxTokens * 4;
            const calleeBlock = callees.length ? callees.join("\n") : "  (none found in body)";
            const callerBlock = callers.length ? callers.join("\n") : "  (no call sites found)";
            let out =
              `call_hierarchy: ${target.sym.kind} ${symbol} (defined ${target.rel}:${target.sym.startLine})\n\n` +
              `callees (${calleeNames.size}${calleeNames.size > callees.length ? "+" : ""}):\n${calleeBlock}\n\n` +
              `callers (${callersTotal}${callersTotal > callers.length ? "+" : ""}):\n${callerBlock}` +
              (scan.truncated ? `\n\n[workspace scan truncated at ${MAX_SCAN_FILES} files — callers and callee resolution may be incomplete; narrow with path/type]` : "");
            if (out.length > budgetChars) {
              const cut = out.lastIndexOf("\n", budgetChars);
              out = `${out.slice(0, cut > 0 ? cut : budgetChars)}\n[truncated — raise maxTokens/headLimit or scope with path]`;
            }
            return ok(out);
          } catch (err) {
            return fail(`call_hierarchy failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

async function readText(ctx: CoreContext, rel: string): Promise<string | undefined> {
  try {
    const { content } = await ctx.fs.read(rel);
    return content.includes(String.fromCharCode(0)) ? undefined : content;
  } catch {
    return undefined;
  }
}
