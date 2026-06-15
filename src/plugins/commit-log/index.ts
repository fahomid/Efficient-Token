import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { gitOk, isSafeRef, runGit } from "../../core/git.js";
import { errMessage, fail, ok } from "../../core/result.js";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 1000;

/**
 * Returns compact commit metadata (`sha date author subject`, no bodies or
 * diffs), optionally scoped to a path or ref, instead of raw `git log`. Use it
 * to orient in history cheaply.
 */
export function commitLogPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "commit-log",
    version: "1.0.1",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "commit_log",
        title: "Commit log",
        description:
          "Compact commit history: one row per commit (short-sha date author subject) with no bodies or diffs. Scope with path (commits touching it), ref (branch/range), or limit. Use this to orient in history without raw git log noise. For the changes themselves use diff_digest; for one symbol's history use symbol_history. Read-only git.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          path: z.string().optional().describe("Only commits touching this path (relative)."),
          ref: z.string().optional().describe('Branch/commit/range (e.g. "main", "main..HEAD"). Default: current HEAD.'),
          limit: z.number().int().positive().optional().describe(`Max commits (default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}).`),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
        },
        handler: async (args) => {
          try {
            const root = ctx.config.root;
            const ref = args.ref === undefined ? undefined : String(args.ref);
            if (ref !== undefined && !isSafeRef(ref)) return fail(`invalid ref: ${JSON.stringify(ref)}`);
            const limit = Math.min(args.limit === undefined ? DEFAULT_LIMIT : Number(args.limit), MAX_LIMIT);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);

            if (!(await gitOk(root, ["rev-parse", "--is-inside-work-tree"]))) {
              return fail("not a git repository (or git is unavailable) at the workspace root.");
            }
            if (!(await gitOk(root, ["rev-parse", "--verify", "--quiet", "HEAD"]))) {
              return ok("No commits yet.");
            }

            const gargs = ["log", `-n${limit}`, "--date=short", "--format=%h %ad %an %s"];
            if (ref !== undefined) gargs.push(ref);
            if (args.path !== undefined) {
              ctx.paths.resolve(String(args.path)); // sandbox check
              gargs.push("--", String(args.path));
            }

            const stdout = (await runGit(root, gargs)).replace(/\s+$/, "");
            if (stdout === "") return ok(`No commits${args.path ? ` touching ${String(args.path)}` : ""}${ref ? ` in ${ref}` : ""}.`);

            const rows = stdout.split("\n");
            const budgetChars = maxTokens * 4;
            const kept: string[] = [];
            let used = 0;
            let capped = false;
            for (const r of rows) {
              if (used + r.length + 1 > budgetChars) {
                capped = true;
                break;
              }
              kept.push(r);
              used += r.length + 1;
            }
            const more = capped || rows.length >= limit;
            const note = more ? `\n[${kept.length} shown${capped ? "; output truncated" : ""} — raise limit/maxTokens or scope with path]` : "";
            return ok(`commit_log${args.path ? ` ${String(args.path)}` : ""}${ref ? ` (${ref})` : ""} — ${kept.length} commit(s):\n${kept.join("\n")}${note}`);
          } catch (err) {
            return fail(`commit_log failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}
