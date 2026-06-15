import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { splitLines, truncate } from "../../core/text.js";
import { identifierBoundary, TYPE_EXTS } from "../../services/scan.js";

const DEFAULT_HEAD = 100;
const MAX_SCAN_FILES = 10_000;
const MAX_LINE = 400;

/**
 * Locates where a symbol is defined and used across the workspace in one call.
 * Definitions come from the AST (kind, line, signature); usages come from an
 * identifier-boundary text scan. Returns `file:line` locations, not whole files.
 */
export function findReferencesPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "find-references",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "find_references",
        title: "Find references",
        description:
          "Find everywhere a symbol (function/class/variable/…) is defined and used across the workspace, returned as compact file:line locations. Definitions are AST-precise; usages are identifier-boundary text matches. Use this instead of reading many files to trace a symbol. Skips node_modules/.git/build dirs.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          symbol: z.string().min(1).describe("Identifier to locate (exact name)."),
          path: z.string().optional().describe("Directory/file to scope to (relative). Default: whole workspace."),
          glob: z.string().optional().describe('Only consider files matching this glob, e.g. "src/**/*.ts".'),
          type: z.string().optional().describe('Only consider this file type, e.g. "ts", "py".'),
          caseInsensitive: z.boolean().optional().describe("Match the name case-insensitively (default: case-sensitive)."),
          headLimit: z.number().int().positive().optional().describe(`Cap each section (default ${DEFAULT_HEAD}).`),
        },
        handler: async (args) => {
          try {
            const symbol = String(args.symbol);
            const insensitive = args.caseInsensitive === true;
            const head = args.headLimit === undefined ? DEFAULT_HEAD : Number(args.headLimit);

            let refRe: RegExp;
            try {
              // Unicode-aware identifier boundaries (won't match inside a larger id).
              refRe = identifierBoundary(symbol, `g${insensitive ? "i" : ""}`);
            } catch (e) {
              return fail(`find_references failed: ${errMessage(e)}`);
            }
            const sameName = (n: string): boolean =>
              insensitive ? n.toLowerCase() === symbol.toLowerCase() : n === symbol;

            const type = args.type === undefined ? undefined : String(args.type).toLowerCase();
            const exts = type ? TYPE_EXTS[type] ?? [type] : undefined;
            const scan = await ctx.scan.files({
              ...(args.path !== undefined ? { within: String(args.path) } : {}),
              ...(args.glob !== undefined ? { glob: String(args.glob) } : {}),
              ...(exts ? { exts } : {}),
              maxFiles: MAX_SCAN_FILES,
            });

            const defs: string[] = [];
            const refs: string[] = [];
            let defCount = 0;
            let refCount = 0;

            for (const f of scan.files) {
              const content = await readText(ctx, f.rel);
              if (content === undefined) continue;
              const lines = splitLines(content);

              const defLines = new Set<number>();
              if (ctx.ast.supports(f.rel)) {
                const outline = await ctx.ast.outline(f.rel, content);
                for (const s of outline ?? []) {
                  if (!sameName(s.name)) continue;
                  defLines.add(s.startLine);
                  defCount++;
                  if (defs.length < head) {
                    const container = s.container ? `${s.container}.` : "";
                    defs.push(`${f.rel}:${s.startLine}  ${s.kind} ${container}${s.name}  ${s.signature}`);
                  }
                }
              }

              for (let i = 0; i < lines.length; i++) {
                refRe.lastIndex = 0;
                if (!refRe.test(lines[i]!)) continue;
                const lineNo = i + 1;
                if (defLines.has(lineNo)) continue; // shown under Definitions
                refCount++;
                if (refs.length < head) refs.push(`${f.rel}:${lineNo}: ${truncate(lines[i]!, MAX_LINE)}`);
              }
            }

            if (defCount === 0 && refCount === 0) {
              return ok(`No definitions or references to "${symbol}" found.`);
            }

            const defCapped = defCount > defs.length;
            const refCapped = refCount > refs.length;
            const parts = [
              `Definitions of "${symbol}" (${defCount}${defCapped ? "+" : ""}):`,
              defs.length ? defs.join("\n") : "  (none found in parsed files)",
              "",
              `References (${refCount}${refCapped ? "+" : ""}):`,
              refs.length ? refs.join("\n") : "  (none)",
            ];
            const notes: string[] = [];
            if (defCapped || refCapped) notes.push("results capped (raise headLimit or narrow scope)");
            if (scan.truncated) notes.push("file scan truncated (narrow with path/glob/type)");
            if (notes.length) parts.push(`\n[${notes.join("; ")}]`);
            return ok(parts.join("\n"));
          } catch (err) {
            return fail(`find_references failed: ${errMessage(err)}`);
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
