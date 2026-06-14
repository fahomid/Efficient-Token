import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { splitLines } from "../../core/text.js";
import { formatSyntaxIssues } from "../../services/ast.js";

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
          validate: z
            .boolean()
            .optional()
            .describe("Reject the write if it would introduce a syntax error (default true). Set false to write anyway."),
        },
        handler: async (args) => {
          try {
            const p = String(args.path);
            const content = String(args.content);

            const existed = await ctx.fs.exists(p);

            // Recovery guard: don't persist syntactically-broken code.
            if (args.validate !== false) {
              let oldContent = "";
              // New file -> baseline is empty (clean). Existing file -> read it;
              // if it's UNREADABLE (e.g. over the size cap) the baseline is
              // unknown, so skip the guard rather than fabricate a clean baseline
              // (which would falsely flag a rewrite of an already-broken file).
              let baselineKnown = !existed;
              if (existed) {
                try {
                  oldContent = (await ctx.fs.readRaw(p)).content;
                  baselineKnown = true;
                } catch {
                  baselineKnown = false;
                }
              }
              if (baselineKnown) {
                const introduced = await ctx.ast.introducedSyntaxErrors(p, oldContent, content);
                if (introduced.length > 0) {
                  const rel0 = ctx.paths.relative(ctx.paths.resolve(p));
                  return fail(
                    `code_write refused: the content would introduce ${introduced.length} syntax error(s) in ${rel0}. ` +
                      `Fix it and retry, or set validate=false to override.\n${formatSyntaxIssues(introduced)}`,
                  );
                }
              }
            }

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
