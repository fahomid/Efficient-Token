import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { TYPE_EXTS } from "../../services/scan.js";

const MAX_SCAN_FILES = 10_000;
const DEFAULT_PER_FILE = 40;

/**
 * `repo_map` — a deterministic table of contents for the workspace: the file
 * tree plus each file's TOP-LEVEL symbols (name + kind, from the AST). One call
 * replaces dozens of exploratory reads for orientation. Output is bounded by a
 * token budget. Read-only. Free tier.
 */
export function repoMapPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "repo-map",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "repo_map",
        title: "Repository map",
        description:
          "A compact map of the project: the file tree grouped by directory, with each source file's TOP-LEVEL symbols (classes/functions/types) and their kinds — NOT the source. Use this once to orient in an unfamiliar codebase instead of reading many files; then drill in with code_outline / code_read. Skips node_modules/.git/build dirs; output is token-bounded.",
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

            const lines: string[] = [];
            const budgetChars = maxTokens * 4;
            let used = 0;
            let lastDir: string | null = null;
            let fileCount = 0;
            let symbolCount = 0;
            let budgetHit = false;

            const push = (s: string): boolean => {
              if (used + s.length + 1 > budgetChars) {
                budgetHit = true;
                return false;
              }
              lines.push(s);
              used += s.length + 1;
              return true;
            };

            for (const f of scan.files) {
              const slash = f.rel.lastIndexOf("/");
              const dir = slash === -1 ? "." : f.rel.slice(0, slash);
              const base = slash === -1 ? f.rel : f.rel.slice(slash + 1);

              let entry: string;
              if (ctx.ast.supports(f.rel)) {
                const content = await readText(ctx, f.rel);
                const outline = content === undefined ? undefined : await ctx.ast.outline(f.rel, content);
                const top = (outline ?? []).filter((s) => s.container === undefined);
                if (top.length > 0) {
                  const shown = top.slice(0, perFile);
                  symbolCount += shown.length;
                  const more = top.length > perFile ? `, +${top.length - perFile} more` : "";
                  entry = `  ${base} — ${shown.map((s) => `${s.kind} ${s.name}`).join(", ")}${more}`;
                } else {
                  entry = `  ${base}`;
                }
              } else {
                entry = `  ${base}`;
              }

              if (dir !== lastDir) {
                if (!push(dir === "." ? "." : `${dir}/`)) break;
                lastDir = dir;
              }
              if (!push(entry)) break;
              fileCount++;
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
