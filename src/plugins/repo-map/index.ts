import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { TYPE_EXTS } from "../../services/scan.js";

const MAX_SCAN_FILES = 10_000;
const DEFAULT_PER_FILE = 40;

/**
 * A deterministic table of contents for the workspace: the file tree plus each
 * file's top-level symbols (name and kind, from the AST). One call replaces
 * dozens of exploratory reads for orientation. Output is bounded by a token
 * budget.
 */
export function repoMapPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "repo-map",
    version: "1.0.1",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "repo_map",
        title: "Repository map",
        description:
          "A compact map of the project: the file tree grouped by directory, with each source file's top-level symbols (classes, functions, types) and their kinds, not the source. Use this once to orient in an unfamiliar codebase instead of reading many files, then drill in with code_outline or code_read. Skips node_modules/.git/build dirs; output is token-bounded.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          path: z.string().optional().describe("Directory to map (relative). Default: whole workspace."),
          glob: z.string().optional().describe('Only include files matching this glob, e.g. "src/**/*.ts".'),
          type: z.string().optional().describe('Only include this file type, e.g. "ts".'),
          maxTokens: z.number().int().positive().optional().describe("Bound the output size (default: server read budget)."),
          symbolsPerFile: z.number().int().positive().optional().describe(`Max symbols listed per file (default ${DEFAULT_PER_FILE}).`),
        },
        handler: async (args) => {
          try {
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const perFile = args.symbolsPerFile === undefined ? DEFAULT_PER_FILE : Number(args.symbolsPerFile);
            const type = args.type === undefined ? undefined : String(args.type).toLowerCase();
            const exts = type ? TYPE_EXTS[type] ?? [type] : undefined;

            const scan = await ctx.scan.files({
              ...(args.path !== undefined ? { within: String(args.path) } : {}),
              ...(args.glob !== undefined ? { glob: String(args.glob) } : {}),
              ...(exts ? { exts } : {}),
              maxFiles: MAX_SCAN_FILES,
            });

            if (scan.files.length === 0) return ok("repo_map: no files found for the given scope.");

            // Group each directory's files together (sorted by directory, then name)
            // so each directory header is emitted exactly once, even when a
            // subdirectory name sorts between that directory's own files.
            const dirOf = (rel: string): string => { const i = rel.lastIndexOf("/"); return i === -1 ? "" : rel.slice(0, i); };
            const baseOf = (rel: string): string => { const i = rel.lastIndexOf("/"); return i === -1 ? rel : rel.slice(i + 1); };
            const files = [...scan.files].sort((a, b) => {
              const da = dirOf(a.rel), db = dirOf(b.rel);
              if (da !== db) return da < db ? -1 : 1;
              const ba = baseOf(a.rel), bb = baseOf(b.rel);
              return ba < bb ? -1 : ba > bb ? 1 : 0;
            });

            const lines: string[] = [];
            const budgetChars = maxTokens * 4;
            let used = 0;
            let lastDir: string | null = null;
            let fileCount = 0;
            let symbolCount = 0;
            let budgetHit = false;

            for (const f of files) {
              const slash = f.rel.lastIndexOf("/");
              const dir = slash === -1 ? "." : f.rel.slice(0, slash);
              const base = slash === -1 ? f.rel : f.rel.slice(slash + 1);

              let entry: string;
              let shownHere = 0;
              if (ctx.ast.supports(f.rel)) {
                const content = await readText(ctx, f.rel);
                const outline = content === undefined ? undefined : await ctx.ast.outline(f.rel, content);
                const top = (outline ?? []).filter((s) => s.container === undefined);
                if (top.length > 0) {
                  const shown = top.slice(0, perFile);
                  shownHere = shown.length;
                  const more = top.length > perFile ? `, +${top.length - perFile} more` : "";
                  entry = `  ${base} — ${shown.map((s) => `${s.kind} ${s.name}`).join(", ")}${more}`;
                } else {
                  entry = `  ${base}`;
                }
              } else {
                entry = `  ${base}`;
              }

              // Budget the directory header and entry together, so we don't leave a
              // dangling header or count symbols for an un-emitted file.
              const dirHeader = dir === "." ? "." : `${dir}/`;
              const needDir = dir !== lastDir;
              const addition = (needDir ? dirHeader.length + 1 : 0) + entry.length + 1;
              if (used + addition > budgetChars) {
                budgetHit = true;
                break;
              }
              if (needDir) {
                lines.push(dirHeader);
                lastDir = dir;
              }
              lines.push(entry);
              used += addition;
              fileCount++;
              symbolCount += shownHere;
            }

            const header = `repo map — ${fileCount} file(s), ${symbolCount} top-level symbol(s)`;
            const trailer =
              budgetHit || scan.truncated
                ? `\n[map truncated — narrow with path/glob/type or raise maxTokens]`
                : "";
            return ok(`${header}\n\n${lines.join("\n")}${trailer}`);
          } catch (err) {
            return fail(`repo_map failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

async function readText(ctx: CoreContext, rel: string): Promise<string | undefined> {
  try {
    const { content } = await ctx.fs.read(rel);
    return content.includes(String.fromCharCode(0)) ? undefined : content; // skip binary
  } catch {
    return undefined;
  }
}
