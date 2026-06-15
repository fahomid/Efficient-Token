import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { formatSyntaxIssues } from "../../services/ast.js";
import { identifierBoundary, TYPE_EXTS } from "../../services/scan.js";

const MAX_SCAN_FILES = 10_000;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

interface Change {
  rel: string;
  count: number;
  original: string;
  next: string;
}

/**
 * Renames a symbol across the whole workspace in one atomic, all-or-nothing call
 * using identifier-boundary text replacement, instead of find_references then
 * editing each file. Syntax-guarded per file, and supports dryRun. Note that the
 * replacement is textual, not scope-aware: it renames every identifier with that
 * name, so scope it with path/glob/type and preview with dryRun first.
 */
export function projectRenamePlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "project-rename",
    version: "1.0.1",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "project_rename",
        title: "Rename across the project",
        description:
          "Rename an identifier across the workspace in one atomic call (identifier-boundary), instead of find_references plus editing each file. dryRun previews counts; syntax-guarded. Note: textual, not scope-aware, so it renames every identifier with that name. Scope with path/glob/type and preview first. Mutating.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        inputSchema: {
          oldName: z.string().min(1).describe("Existing identifier to rename."),
          newName: z.string().min(1).describe("New identifier (must be a valid identifier)."),
          path: z.string().optional().describe("Directory/file to scope the rename to (relative)."),
          glob: z.string().optional().describe("Only rename in files matching this glob."),
          type: z.string().optional().describe('Only rename in this file type, e.g. "ts".'),
          dryRun: z.boolean().optional().describe("Preview the changes (counts per file) without writing."),
          validate: z.boolean().optional().describe("Abort if any file would gain a syntax error (default true)."),
        },
        handler: async (args) => {
          try {
            const oldName = String(args.oldName);
            const newName = String(args.newName);
            if (oldName === newName) return fail("oldName and newName are identical.");
            if (!IDENT.test(oldName)) return fail(`oldName is not a valid identifier: ${JSON.stringify(oldName)}.`);
            if (!IDENT.test(newName)) return fail(`newName is not a valid identifier: ${JSON.stringify(newName)}.`);
            const dryRun = args.dryRun === true;

            const re = identifierBoundary(oldName, "g");
            const type = args.type === undefined ? undefined : String(args.type).toLowerCase();
            const exts = type ? TYPE_EXTS[type] ?? [type] : undefined;
            const scan = await ctx.scan.files({
              ...(args.path !== undefined ? { within: String(args.path) } : {}),
              ...(args.glob !== undefined ? { glob: String(args.glob) } : {}),
              ...(exts ? { exts } : {}),
              maxFiles: MAX_SCAN_FILES,
            });

            const changes: Change[] = [];
            let total = 0;
            for (const f of scan.files) {
              let content: string;
              try {
                content = (await ctx.fs.readRaw(f.rel)).content;
              } catch {
                continue; // unreadable / too large
              }
              if (content.includes(String.fromCharCode(0))) continue; // binary
              let count = 0;
              const next = content.replace(re, () => {
                count++;
                return newName; // function form -> literal (no $ interpretation)
              });
              if (count > 0) {
                changes.push({ rel: f.rel, count, original: content, next });
                total += count;
              }
            }

            if (total === 0) return ok(`No occurrences of "${oldName}" found.`);

            const perFile = changes.map((c) => `  ${c.rel}: ${c.count}`).join("\n");
            if (dryRun) {
              return ok(
                `[dry run] would rename "${oldName}" → "${newName}": ${total} occurrence(s) in ${changes.length} file(s):\n${perFile}`,
              );
            }

            if (args.validate !== false) {
              for (const c of changes) {
                const introduced = await ctx.ast.introducedSyntaxErrors(c.rel, c.original, c.next);
                if (introduced.length > 0) {
                  return fail(
                    `project_rename aborted (no files changed): ${c.rel} would gain ${introduced.length} syntax error(s).\n` +
                      `${formatSyntaxIssues(introduced)}\n(set validate=false to override)`,
                  );
                }
              }
            }

            const written: Change[] = [];
            try {
              for (const c of changes) {
                await ctx.fs.writeAtomic(c.rel, c.next);
                written.push(c);
              }
            } catch (err) {
              const unrestored: string[] = [];
              for (const c of written) {
                try {
                  await ctx.fs.writeAtomic(c.rel, c.original);
                } catch {
                  unrestored.push(c.rel);
                }
              }
              const tail =
                unrestored.length > 0
                  ? ` PARTIALLY APPLIED — could not restore: ${unrestored.join(", ")} (manual revert needed).`
                  : " Rolled back.";
              return fail(`project_rename failed mid-write:${tail} (${errMessage(err)})`);
            }

            return ok(
              `Renamed "${oldName}" → "${newName}": ${total} occurrence(s) across ${changes.length} file(s):\n${perFile}`,
            );
          } catch (err) {
            return fail(`project_rename failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}
