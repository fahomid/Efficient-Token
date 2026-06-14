import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { readTarget } from "../../core/read.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { truncate } from "../../core/text.js";

/**
 * `read_many` — read several symbols / line ranges / files in ONE call (the
 * read-side analog of apply_patch). Each target follows code_read semantics;
 * results are concatenated and bounded by an overall token budget. Saves the
 * per-call round-trips of reading files one at a time. Read-only. Free tier.
 */
export function readManyPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "read-many",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "read_many",
        title: "Read many",
        description:
          "Read several targets in ONE call instead of multiple code_read calls. Each target: { path, symbol? (a single symbol), startLine?/endLine? (a range) }; omit both for the whole file (degrades over budget). Output is concatenated, labeled per target, and bounded by an overall token budget. Use this to pull together the few pieces you need at once.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          reads: z
            .array(
              z.object({
                path: z.string().describe("File path relative to the workspace root."),
                symbol: z.string().optional().describe("A single symbol to extract."),
                startLine: z.number().int().positive().optional().describe("1-based range start."),
                endLine: z.number().int().positive().optional().describe("1-based range end."),
              }),
            )
            .min(1)
            .describe("Targets to read."),
          maxTokens: z.number().int().positive().optional().describe("Overall output budget (default: server read budget)."),
        },
        handler: async (args) => {
          try {
            const reads = args.reads as Array<{
              path: string;
              symbol?: string;
              startLine?: number;
              endLine?: number;
            }>;
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const budgetChars = maxTokens * 4;

            const blocks: string[] = [];
            let used = 0;
            let shown = 0;
            let truncated = false;
            for (const t of reads) {
              if (used >= budgetChars) {
                truncated = true;
                break;
              }
              // Give each target the remaining budget so a whole-file read degrades.
              const perTarget = Math.max(500, Math.floor((budgetChars - used) / 4));
              const r = await readTarget(ctx, {
                path: String(t.path),
                symbol: t.symbol === undefined ? undefined : String(t.symbol),
                startLine: t.startLine === undefined ? undefined : Number(t.startLine),
                endLine: t.endLine === undefined ? undefined : Number(t.endLine),
                maxTokens: perTarget,
              });
              const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
              const block = `### ${describe(t)}${r.isError ? " (error)" : ""}\n${text}`;
              const room = budgetChars - used - 2;
              if (block.length > room) {
                if (shown > 0) {
                  truncated = true;
                  break;
                }
                // First target alone exceeds the budget: emit a bounded slice
                // (surrogate-safe) rather than dumping it whole.
                blocks.push(`${truncate(block, Math.max(0, room))}\n… [truncated — raise maxTokens]`);
                shown++;
                truncated = true;
                break;
              }
              blocks.push(block);
              used += block.length + 2;
              shown++;
            }

            const header = `read_many: ${shown}/${reads.length} target(s)${truncated ? " (budget reached)" : ""}`;
            return ok(`${header}\n\n${blocks.join("\n\n")}`);
          } catch (err) {
            return fail(`read_many failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

function describe(t: { path: string; symbol?: string; startLine?: number; endLine?: number }): string {
  if (t.symbol !== undefined) return `${t.path} symbol=${t.symbol}`;
  if (t.startLine !== undefined || t.endLine !== undefined) {
    return `${t.path}:${t.startLine ?? 1}-${t.endLine ?? ""}`;
  }
  return t.path;
}
