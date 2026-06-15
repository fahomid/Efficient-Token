import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { TYPE_EXTS } from "../../services/scan.js";

const DEFAULT_HEAD = 200;
const MAX_HEAD = 10_000;

/**
 * `glob` — list workspace file PATHS matching a glob and/or type (no content),
 * mirroring Claude's `Glob`. Use it to find files cheaply (e.g. all tests, all
 * `*.ts`) without reading anything. Skips node_modules/.git/build dirs;
 * deterministic, token-bounded. Read-only. Free tier.
 */
export function globPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "glob",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "glob",
        title: "List files",
        description:
          'List file paths matching a glob (e.g. "**/*.ts", "src/**/*.test.ts") and/or a type — paths only, no content. Use this to find files instead of reading directories. Combine glob + type + path to scope. Skips node_modules/.git/build dirs.',
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          pattern: z.string().optional().describe('Glob to match, e.g. "**/*.ts". Omit to list all files in scope.'),
          path: z.string().optional().describe("Directory to scope to (relative). Default: whole workspace."),
          type: z.string().optional().describe('Only this file type, e.g. "ts", "py".'),
          headLimit: z.number().int().positive().optional().describe(`Max paths to return (default ${DEFAULT_HEAD}, capped at ${MAX_HEAD}).`),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
        },
        handler: async (args) => {
          try {
            const head = Math.min(args.headLimit === undefined ? DEFAULT_HEAD : Number(args.headLimit), MAX_HEAD);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const budgetChars = maxTokens * 4;
            const type = args.type === undefined ? undefined : String(args.type).toLowerCase();
            const exts = type ? TYPE_EXTS[type] ?? [type] : undefined;

            const scan = await ctx.scan.files({
              ...(args.path !== undefined ? { within: String(args.path) } : {}),
              ...(args.pattern !== undefined ? { glob: String(args.pattern) } : {}),
              ...(exts ? { exts } : {}),
              maxFiles: head + 1,
            });

            if (scan.files.length === 0) {
              const what = args.pattern ?? args.type ?? args.path ?? "the workspace";
              return ok(`No files match ${String(what)}.`);
            }

            // Bound by BOTH the path count (head) and the token budget, so a deep
            // tree of long paths can't blow the context even within headLimit.
            const lines: string[] = [];
            let used = 0;
            let capped = false;
            for (const f of scan.files) {
              if (lines.length >= head) break;
              if (lines.length > 0 && used + f.rel.length + 1 > budgetChars) {
                capped = true;
                break;
              }
              lines.push(f.rel);
              used += f.rel.length + 1;
            }
            const truncated = scan.truncated || scan.files.length > head || capped;
            const note = truncated ? `\n[showing first ${lines.length}; narrow with pattern/type/path or raise maxTokens/headLimit]` : "";
            return ok(`${lines.length}${truncated ? "+" : ""} file(s):\n${lines.join("\n")}${note}`);
          } catch (err) {
            return fail(`glob failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}
