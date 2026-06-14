import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { numberLines, splitLines } from "../../core/text.js";
import { formatSyntaxIssues } from "../../services/ast.js";

/**
 * `code_edit` — exact string replacement in a file, matching Claude's `Edit`
 * semantics: `oldString` must occur VERBATIM and be UNIQUE (unless `replaceAll`),
 * else the edit is refused. Free tier. Writes atomically via the sandbox.
 */
export function codeEditPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "code-edit",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "code_edit",
        title: "Edit code",
        description:
          "Replace an exact string in an existing file (precise find-and-replace). oldString must match the file VERBATIM (including whitespace/indentation) and be UNIQUE unless replaceAll=true — read the file with code_read first and copy the exact text. Refuses missing or ambiguous matches; never edits blindly. Writes atomically. For a full-file create/overwrite use code_write.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          path: z.string().describe("File path relative to the workspace root."),
          oldString: z
            .string()
            .min(1)
            .describe("Exact text to replace — must match the file verbatim."),
          newString: z
            .string()
            .describe("Replacement text (may be empty to delete the matched text)."),
          replaceAll: z
            .boolean()
            .optional()
            .describe("Replace EVERY occurrence instead of requiring a unique match."),
          validate: z
            .boolean()
            .optional()
            .describe("Reject the edit if it would introduce a syntax error into a clean file (default true). Set false to write anyway."),
        },
        handler: async (args) => {
          try {
            const p = String(args.path);
            const oldString = String(args.oldString);
            const newString = String(args.newString);
            const replaceAll = args.replaceAll === true;

            if (oldString === newString) {
              return fail("oldString and newString are identical — nothing to change.");
            }

            const { content, abs } = await ctx.fs.readRaw(p);
            const rel = ctx.paths.relative(abs);

            const count = countOccurrences(content, oldString);
            if (count === 0) {
              return fail(
                `${rel} — oldString not found. Read the file (code_read) and copy the exact text, including whitespace.`,
              );
            }
            if (count > 1 && !replaceAll) {
              return fail(
                `${rel} — oldString is not unique (${count} matches). Add surrounding context to disambiguate, or set replaceAll=true.`,
              );
            }

            // Literal replacement only — never String.replace, whose replacement
            // string interprets `$&`/`$1`/`$$` and would corrupt the output.
            let newContent: string;
            if (replaceAll) {
              newContent = content.split(oldString).join(newString);
            } else {
              const idx = content.indexOf(oldString);
              newContent =
                content.slice(0, idx) + newString + content.slice(idx + oldString.length);
            }

            // Recovery guard: never persist an edit that breaks a clean file.
            if (args.validate !== false) {
              const introduced = await ctx.ast.introducedSyntaxErrors(p, content, newContent);
              if (introduced.length > 0) {
                return fail(
                  `code_edit refused: this change would introduce ${introduced.length} syntax error(s) in ${rel}. ` +
                    `Fix the edit and retry, or set validate=false to override.\n${formatSyntaxIssues(introduced)}`,
                );
              }
            }

            await ctx.fs.writeAtomic(p, newContent);

            const n = replaceAll ? count : 1;
            const preview = changedPreview(content, newContent, oldString, newString);
            return ok(`Edited ${rel}: ${n} replacement(s).\n${preview}`);
          } catch (err) {
            return fail(`code_edit failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

/** Count non-overlapping literal occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Line-numbered window around the FIRST change so the model can verify it. */
function changedPreview(
  oldContent: string,
  newContent: string,
  oldString: string,
  newString: string,
): string {
  const at = oldContent.indexOf(oldString);
  const startLine = newlineCount(newContent.slice(0, at)) + 1;
  const changedLines = Math.max(1, splitLines(newString).length);
  const lines = splitLines(newContent);
  const from = Math.max(1, startLine - 2);
  const to = Math.min(lines.length, startLine + changedLines + 1);
  if (lines.length === 0) return "(file is now empty)";
  return numberLines(lines.slice(from - 1, to), from);
}

function newlineCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}
