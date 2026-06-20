import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { numberLines, splitLines } from "../../core/text.js";
import type { SymbolInfo } from "../../services/ast.js";
import { TYPE_EXTS } from "../../services/scan.js";

const TYPE_KINDS = new Set(["type", "interface", "enum", "struct", "union", "trait", "class", "protocol", "object"]);
const DEFAULT_DEPTH = 3;
const MAX_TYPES = 40;
const MAX_SCAN_FILES = 10_000;
const IDENT_RE = /[A-Za-z_$][\w$]*/g;

/**
 * Returns a type's definition plus the verbatim definitions of the workspace
 * types it transitively references (cycle-safe, depth- and budget-bounded), so
 * you can understand a complex type without chasing each referenced type by
 * hand.
 */
export function typeClosurePlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "type-closure",
    version: "1.0.4",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "type_closure",
        title: "Type closure",
        description:
          "Given a type/interface/enum/class name, return its definition plus the verbatim definitions of the workspace types it transitively references (cycle-safe, depth-bounded), so you can grasp a complex type in one call instead of opening each referenced type. Scope with path or type, and tune maxDepth. Returns real source. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          symbol: z.string().min(1).describe("Name of the type/interface/enum/class to start from."),
          path: z.string().optional().describe("Directory/file to scope the search to (relative)."),
          type: z.string().optional().describe('Only this file type, e.g. "ts".'),
          maxDepth: z.number().int().min(1).optional().describe(`Transitive depth (default ${DEFAULT_DEPTH}).`),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
        },
        handler: async (args) => {
          try {
            const seedName = String(args.symbol);
            const maxDepth = args.maxDepth === undefined ? DEFAULT_DEPTH : Number(args.maxDepth);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const type = args.type === undefined ? undefined : String(args.type).toLowerCase();
            const exts = type ? TYPE_EXTS[type] ?? [type] : undefined;

            const scan = await ctx.scan.files({
              ...(args.path !== undefined ? { within: String(args.path) } : {}),
              ...(exts ? { exts } : {}),
              maxFiles: MAX_SCAN_FILES,
            });

            // Index every type definition: name -> {rel, content, sym} (first wins).
            const index = new Map<string, { rel: string; content: string; sym: SymbolInfo }>();
            for (const f of scan.files) {
              if (!ctx.ast.supports(f.rel)) continue;
              const content = await readText(ctx, f.rel);
              if (content === undefined) continue;
              for (const s of (await ctx.ast.outline(f.rel, content)) ?? []) {
                if (TYPE_KINDS.has(s.kind) && !index.has(s.name)) {
                  index.set(s.name, { rel: f.rel, content, sym: s });
                }
              }
            }

            if (!index.has(seedName)) {
              const inc = scan.truncated ? ` (scan stopped at ${MAX_SCAN_FILES} files — it may be defined beyond; narrow with path/type)` : "";
              return fail(`type "${seedName}" not found among workspace type definitions${args.path ? ` under ${String(args.path)}` : ""}${inc}.`);
            }

            const budgetChars = maxTokens * 4;
            const visited = new Set<string>();
            const queue: Array<{ name: string; depth: number }> = [{ name: seedName, depth: 0 }];
            const blocks: string[] = [];
            let used = 0;
            let truncated = false;

            while (queue.length > 0 && blocks.length < MAX_TYPES) {
              const { name, depth } = queue.shift()!;
              if (visited.has(name)) continue;
              visited.add(name);
              const entry = index.get(name);
              if (entry === undefined) continue;

              const lines = splitLines(entry.content);
              const start = Math.max(1, entry.sym.startLine);
              const end = Math.min(lines.length, entry.sym.endLine);
              const src = lines.slice(start - 1, end);
              const block = `${entry.rel} — ${entry.sym.kind} ${entry.sym.name} (lines ${start}-${end})\n${numberLines(src, start)}`;
              if (used + block.length + 2 > budgetChars) {
                truncated = true;
                break;
              }
              blocks.push(block);
              used += block.length + 2;

              if (depth < maxDepth) {
                const defText = src.join("\n");
                for (const token of new Set(defText.match(IDENT_RE) ?? [])) {
                  if (token !== name && index.has(token) && !visited.has(token)) {
                    queue.push({ name: token, depth: depth + 1 });
                  }
                }
              }
            }

            const note = (truncated || queue.length > 0) ? "\n[closure bounded — raise maxDepth/maxTokens]" : "";
            return ok(`type_closure: ${seedName} — ${blocks.length} type(s) (depth ≤ ${maxDepth})\n\n${blocks.join("\n\n")}${note}`);
          } catch (err) {
            return fail(`type_closure failed: ${errMessage(err)}`);
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
