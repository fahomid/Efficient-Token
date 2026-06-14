import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { splitLines } from "../../core/text.js";

/**
 * `code_write` — create or overwrite a whole file, matching Claude's `Write`
 * semantics. Free tier. Creates parent dirs and writes atomically via the
 * sandbox (confined to the workspace root, symlink/ADS-safe).
 */
export function codeWritePlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "code-write",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "code_write",
        title: "Write file",
        description:
          "Create a new file, or OVERWRITE an existing one entirely, with the given content. Use this for new files or full rewrites; to change part of an existing file prefer code_edit. Creates parent directories, writes atomically, and is confined to the workspace.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          path: z.string().describe("File path relative to the workspace root."),
          content: z.string().describe("Full file contents to write."),
        },
        handler: async (args) => {
          try {
            const p = String(args.path);
            const content = String(args.content);

            const existed = await ctx.fs.exists(p);
            const abs = await ctx.fs.writeAtomic(p, content);
            const rel = ctx.paths.relative(abs);
            const lineCount = content === "" ? 0 : splitLines(content).length;
            const bytes = Buffer.byteLength(content, "utf8");
            return ok(
              `${existed ? "Overwrote" : "Created"} ${rel} (${lineCount} line(s), ${bytes} bytes).`,
            );
          } catch (err) {
            return fail(`code_write failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}
