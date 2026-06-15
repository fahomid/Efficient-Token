import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { numberLines, splitLines, truncate } from "../../core/text.js";
import type { SymbolInfo } from "../../services/ast.js";
import { identifierBoundary, TYPE_EXTS } from "../../services/scan.js";

const MAX_SCAN_FILES = 10_000;
const MAX_DEF_LINES = 120;
const MAX_DEPS = 30;
const MAX_REFS = 40;
const MAX_LINE = 400;

interface Def {
  rel: string;
  sym: SymbolInfo;
  content: string;
}

/**
 * Build a one-shot task primer for a symbol: its definition source, the
 * workspace symbols it uses (with signatures), and where it is referenced. This
 * replaces the read-the-definition-then-chase-each-dependency loop with one
 * bounded call.
 */
export function codeContextPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "code-context",
    version: "1.0.1",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "code_context",
        title: "Symbol context pack",
        description:
          "Build a context pack for a symbol in one call: its definition source (line-numbered), the workspace-defined symbols it uses (kind, signature, location), and where it is referenced (file:line). Use this to prime a task on an unfamiliar symbol instead of reading the definition then chasing each dependency. Token-bounded. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          symbol: z.string().min(1).describe("Symbol (function/class/…) to build context for."),
          path: z.string().optional().describe("Prefer the definition in this file (and scope the search)."),
          glob: z.string().optional().describe("Only consider files matching this glob."),
          type: z.string().optional().describe('Only consider this file type, e.g. "ts".'),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
        },
        handler: async (args) => {
          try {
            const symbol = String(args.symbol);
            const type = args.type === undefined ? undefined : String(args.type).toLowerCase();
            const exts = type ? TYPE_EXTS[type] ?? [type] : undefined;
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);

            const scan = await ctx.scan.files({
              ...(args.path !== undefined ? { within: String(args.path) } : {}),
              ...(args.glob !== undefined ? { glob: String(args.glob) } : {}),
              ...(exts ? { exts } : {}),
              maxFiles: MAX_SCAN_FILES,
            });

            // Build a workspace symbol index (name -> first definition) and find
            // every definition of the target.
            const index = new Map<string, { rel: string; sym: SymbolInfo }>();
            const targets: Def[] = [];
            for (const f of scan.files) {
              const content = await readText(ctx, f.rel);
              if (content === undefined || !ctx.ast.supports(f.rel)) continue;
              const outline = (await ctx.ast.outline(f.rel, content)) ?? [];
              for (const s of outline) {
                if (!index.has(s.name)) index.set(s.name, { rel: f.rel, sym: s });
                if (s.name === symbol) targets.push({ rel: f.rel, sym: s, content });
              }
            }

            // Build the reference list (identifier-boundary scan).
            const refRe = identifierBoundary(symbol);
            const refs: string[] = [];
            let refTotal = 0;
            const defLines = new Set(targets.map((t) => `${t.rel}:${t.sym.startLine}`));
            for (const f of scan.files) {
              const content = await readText(ctx, f.rel);
              if (content === undefined) continue;
              const lines = splitLines(content);
              for (let i = 0; i < lines.length; i++) {
                if (!refRe.test(lines[i]!)) continue;
                if (defLines.has(`${f.rel}:${i + 1}`)) continue;
                refTotal++;
                if (refs.length < MAX_REFS) refs.push(`  ${f.rel}:${i + 1}: ${truncate(lines[i]!, MAX_LINE)}`);
              }
            }

            if (targets.length === 0) {
              const head = `code_context: no definition of "${symbol}" found in the workspace.`;
              const body = refs.length ? `\n\nReferenced from (${refTotal}):\n${refs.join("\n")}` : "";
              return ok(head + body);
            }

            const target =
              (args.path !== undefined &&
                targets.find((t) => t.rel === ctx.paths.relative(ctx.paths.resolve(String(args.path))))) ||
              targets[0]!;

            // Definition slice (bounded).
            const lines = splitLines(target.content);
            const start = target.sym.startLine;
            const endFull = target.sym.endLine;
            const end = Math.min(endFull, start + MAX_DEF_LINES - 1);
            const defSlice = numberLines(lines.slice(start - 1, end), start);
            const defTrunc = endFull > end ? `\n  … (${endFull - end} more line(s); use code_read symbol=${symbol})` : "";

            // Dependencies: identifiers in the body that resolve to workspace symbols.
            const bodyText = lines.slice(start - 1, endFull).join("\n");
            const seen = new Set<string>();
            const deps: string[] = [];
            for (const id of bodyText.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
              if (id === symbol || seen.has(id)) continue;
              seen.add(id);
              const d = index.get(id);
              if (!d) continue;
              deps.push(`  ${d.sym.kind} ${id} — ${truncate(d.sym.signature, 120)}  (${d.rel}:${d.sym.startLine})`);
              if (deps.length >= MAX_DEPS) break;
            }

            const container = target.sym.container ? `${target.sym.container}.` : "";
            const sections: string[] = [
              `=== code_context: ${symbol} ===` +
                (targets.length > 1 ? `  (${targets.length} definitions; showing ${target.rel})` : ""),
              "",
              `Definition — ${target.sym.kind} ${container}${symbol} (${target.rel}:${start}-${endFull}):`,
              defSlice + defTrunc,
            ];
            if (deps.length) sections.push("", `Uses (workspace symbols, ${deps.length}):`, deps.join("\n"));
            if (refs.length) sections.push("", `Referenced from (${refTotal}):`, refs.join("\n"));

            // Bound the whole pack: drop references, then deps, if over budget.
            let outText = sections.join("\n");
            const budget = maxTokens * 4;
            if (outText.length > budget && refs.length) {
              sections.splice(sections.indexOf(`Referenced from (${refTotal}):`) - 1, 3);
              sections.push("", `Referenced from (${refTotal}): [omitted — over budget; use find_references]`);
              outText = sections.join("\n");
            }
            return ok(outText);
          } catch (err) {
            return fail(`code_context failed: ${errMessage(err)}`);
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
