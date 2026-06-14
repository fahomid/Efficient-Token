import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { applyStringEdit, editFailureMessage } from "../../core/edits.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { formatSyntaxIssues } from "../../services/ast.js";

interface WorkFile {
  rel: string;
  original: string;
  current: string;
  replacements: number;
}

/**
 * `apply_patch` — apply MANY exact-string edits (across one or several files) in
 * a single, all-or-nothing call. Each edit follows `code_edit` semantics
 * (verbatim + unique-or-replaceAll). Everything is computed and validated in
 * memory first; if ANY edit fails or would introduce a syntax error, nothing is
 * written. Saves the per-call round-trips of editing files one at a time.
 * Mutating. Free tier.
 */
export function applyPatchPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "apply-patch",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "apply_patch",
        title: "Apply a patch",
        description:
          "Apply a batch of exact find-and-replace edits across one or more files in ONE atomic call (all-or-nothing). Each edit: { path, oldString (verbatim, unique unless replaceAll), newString, replaceAll? }. Multiple edits to the same file apply in order. If any edit fails to match or would introduce a syntax error, NOTHING is written. Use this instead of many code_edit calls for multi-file changes.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          edits: z
            .array(
              z.object({
                path: z.string().describe("File path relative to the workspace root."),
                oldString: z.string().min(1).describe("Exact text to replace (verbatim)."),
                newString: z.string().describe("Replacement text (may be empty)."),
                replaceAll: z.boolean().optional().describe("Replace every occurrence in this file."),
              }),
            )
            .min(1)
            .describe("Ordered list of edits to apply atomically."),
          validate: z
            .boolean()
            .optional()
            .describe("Reject the whole batch if any file would gain a syntax error (default true)."),
        },
        handler: async (args) => {
          try {
            const edits = args.edits as Array<{
              path: string;
              oldString: string;
              newString: string;
              replaceAll?: boolean;
            }>;

            // 1) Apply every edit IN MEMORY (read each file once), aborting on the
            //    first failure so nothing is partially written.
            const work = new Map<string, WorkFile>();
            const order: string[] = [];
            for (let i = 0; i < edits.length; i++) {
              const e = edits[i]!;
              const abs = ctx.paths.resolve(String(e.path));
              let w = work.get(abs);
              if (!w) {
                const { content } = await ctx.fs.readRaw(String(e.path));
                w = { rel: ctx.paths.relative(abs), original: content, current: content, replacements: 0 };
                work.set(abs, w);
                order.push(abs);
              }
              const r = applyStringEdit(w.current, String(e.oldString), String(e.newString), e.replaceAll === true);
              if (!r.ok) {
                return fail(`apply_patch aborted (no files changed): edit #${i + 1} — ${editFailureMessage(w.rel, r)}`);
              }
              w.current = r.content;
              w.replacements += r.count;
            }

            // 2) Syntax guard on every touched file (still nothing written).
            if (args.validate !== false) {
              for (const abs of order) {
                const w = work.get(abs)!;
                if (w.current === w.original) continue;
                const introduced = await ctx.ast.introducedSyntaxErrors(w.rel, w.original, w.current);
                if (introduced.length > 0) {
                  return fail(
                    `apply_patch aborted (no files changed): ${w.rel} would gain ${introduced.length} syntax error(s).\n` +
                      `${formatSyntaxIssues(introduced)}\n(set validate=false to override)`,
                  );
                }
              }
            }

            // 3) Write all changed files; roll back already-written ones on failure.
            const written: string[] = [];
            try {
              for (const abs of order) {
                const w = work.get(abs)!;
                if (w.current === w.original) continue;
                await ctx.fs.writeAtomic(w.rel, w.current);
                written.push(abs);
              }
            } catch (err) {
              for (const abs of written) {
                const w = work.get(abs)!;
                try {
                  await ctx.fs.writeAtomic(w.rel, w.original);
                } catch {
                  /* best-effort rollback */
                }
              }
              return fail(`apply_patch failed mid-write and rolled back: ${errMessage(err)}`);
            }

            const changed = order.map((abs) => work.get(abs)!).filter((w) => w.current !== w.original);
            const totalEdits = changed.reduce((a, w) => a + w.replacements, 0);
            const summary = changed.map((w) => `  ${w.rel}: ${w.replacements} replacement(s)`).join("\n");
            return ok(
              `Applied ${totalEdits} replacement(s) across ${changed.length} file(s):\n${summary || "  (no net change)"}`,
            );
          } catch (err) {
            return fail(`apply_patch failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}
