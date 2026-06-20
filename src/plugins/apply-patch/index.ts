import { promises as fsp } from "node:fs";

import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { applyStringEdit, editFailureMessage } from "../../core/edits.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { runProjectScript } from "../../core/scripts.js";
import { formatSyntaxIssues } from "../../services/ast.js";

interface WorkFile {
  rel: string;
  original: string;
  current: string;
  replacements: number;
}

/**
 * Apply many exact-string edits, across one or several files, in a single
 * all-or-nothing call. Each edit follows `code_edit` semantics: verbatim match,
 * unique unless replaceAll. Everything is computed and validated in memory
 * first, so if any edit fails or would introduce a syntax error, nothing is
 * written. This avoids the per-call round-trips of editing files one at a time.
 */
export function applyPatchPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "apply-patch",
    version: "1.0.4",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "apply_patch",
        title: "Apply a patch",
        description:
          "Use INSTEAD of multiple built-in Edit/Write calls — apply a batch of exact find-and-replace edits across one or more files in one atomic, all-or-nothing call. Each edit: { path, oldString (verbatim, unique unless replaceAll), newString, replaceAll? }. Multiple edits to the same file apply in order. If any edit fails to match or would introduce a syntax error, nothing is written. Prefer this over many code_edit calls for multi-file changes.",
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
                file_path: z.string().describe("File path (absolute, or relative to the workspace root)."),
                old_string: z.string().min(1).describe("Exact text to replace (verbatim)."),
                new_string: z.string().describe("Replacement text (may be empty)."),
                replace_all: z.boolean().optional().describe("Replace every occurrence in this file."),
              }),
            )
            .min(1)
            .describe("Ordered list of edits to apply atomically (each like a code_edit)."),
          validate: z
            .boolean()
            .optional()
            .describe("Reject the whole batch if any file would gain a syntax error (default true)."),
          check: z
            .string()
            .optional()
            .describe('After the patch applies, run this package.json script (e.g. "typecheck" or "lint") and append its result (failures-only), instead of a separate run.'),
        },
        handler: async (args) => {
          try {
            const edits = args.edits as Array<{
              file_path: string;
              old_string: string;
              new_string: string;
              replace_all?: boolean;
            }>;

            // 1) Apply every edit in memory (read each file once), aborting on the
            //    first failure so nothing is partially written.
            const work = new Map<string, WorkFile>();
            const order: string[] = [];
            for (let i = 0; i < edits.length; i++) {
              const e = edits[i]!;
              const abs = ctx.paths.resolve(String(e.file_path));
              // Key by the file's real on-disk identity so case-variant paths
              // (Windows/macOS) or symlink aliases map to one working copy.
              let key: string;
              try {
                key = await fsp.realpath(abs);
              } catch {
                key = abs; // missing file -> readRaw below produces the proper error
              }
              let w = work.get(key);
              if (!w) {
                const { content } = await ctx.fs.readRaw(String(e.file_path));
                w = { rel: ctx.paths.relative(abs), original: content, current: content, replacements: 0 };
                work.set(key, w);
                order.push(key);
              }
              const r = applyStringEdit(w.current, String(e.old_string), String(e.new_string), e.replace_all === true);
              if (!r.ok) {
                return fail(`apply_patch aborted (no files changed): edit #${i + 1} — ${editFailureMessage(w.rel, r)}`);
              }
              w.current = r.content;
              w.replacements += r.count;
            }

            // 2) Syntax guard on every touched file (still nothing written).
            if (args.validate !== false) {
              for (const key of order) {
                const w = work.get(key)!;
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
              for (const key of order) {
                const w = work.get(key)!;
                if (w.current === w.original) continue;
                await ctx.fs.writeAtomic(w.rel, w.current);
                written.push(key);
              }
            } catch (err) {
              const unrestored = await rollback(ctx, written, work);
              const tail =
                unrestored.length > 0
                  ? ` PARTIALLY APPLIED — could not restore: ${unrestored.join(", ")} (manual revert needed).`
                  : " Rolled back.";
              return fail(`apply_patch failed mid-write:${tail} (${errMessage(err)})`);
            }

            const changed = order.map((key) => work.get(key)!).filter((w) => w.current !== w.original);
            const totalEdits = changed.reduce((a, w) => a + w.replacements, 0);
            const summary = changed.map((w) => `  ${w.rel}: ${w.replacements} replacement(s)`).join("\n");
            let body = `Applied ${totalEdits} replacement(s) across ${changed.length} file(s):\n${summary || "  (no net change)"}`;

            // Optional post-edit check: run an allowlisted script and append its
            // result so the analyze step rides on the edit instead of a separate
            // call. The patch already succeeded, so a failing check does not make
            // this an error — it is reported for the model to act on.
            const check = args.check === undefined ? "" : String(args.check).trim();
            if (check !== "") {
              const outcome = await runProjectScript(ctx, check);
              body += `\n\npost-edit check:\n${outcome.text}`;
            }
            return ok(body);
          } catch (err) {
            return fail(`apply_patch failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

/** Restore originals for already-written files; return rels that could not be restored. */
async function rollback(
  ctx: CoreContext,
  writtenKeys: string[],
  work: Map<string, WorkFile>,
): Promise<string[]> {
  const failed: string[] = [];
  for (const key of writtenKeys) {
    const w = work.get(key)!;
    try {
      await ctx.fs.writeAtomic(w.rel, w.original);
    } catch {
      failed.push(w.rel);
    }
  }
  return failed;
}
