import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { TYPE_EXTS } from "../../services/scan.js";

const DEFAULT_HEAD = 200;

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
          headLimit: z.number().int().positive().optional().describe(`Max paths to return (default ${DEFAULT_HEAD}).`),
        },
        handler: async (args) => {
          try {
            const head = args.headLimit === undefined ? DEFAULT_HEAD : Number(args.headLimit);
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
            const truncated = scan.truncated || scan.files.length > head;
            const shown = scan.files.slice(0, head);
            const note = truncated ? `\n[showing first ${shown.length}; narrow with pattern/type/path]` : "";
            return ok(`${shown.length}${truncated ? "+" : ""} file(s):\n${shown.map((f) => f.rel).join("\n")}${note}`);
          } catch (err) {
            return fail(`glob failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}
