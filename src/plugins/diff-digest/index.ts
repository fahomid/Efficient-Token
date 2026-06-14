import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";

const execFileP = promisify(execFile);

/**
 * `diff_digest` — summarize git changes as just the changed hunks (or a `--stat`
 * / file list), instead of the model reading whole changed files. Runs only
 * read-only git (`diff`/`rev-parse`) via `execFile` (no shell). Free tier.
 */
export function diffDigestPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "diff-digest",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "diff_digest",
        title: "Diff digest",
        description:
          'Summarize git changes as the changed hunks only (or a --stat summary / file list) — NOT whole files. Defaults to uncommitted changes vs HEAD. Pass ref (a branch/commit/range like "main" or "main...HEAD"), staged=true for the index, or path to scope. outputMode: digest (default) | stat | files. Use this to review changes without reading files. Read-only git.',
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          ref: z.string().optional().describe('Compare against this branch/commit/range (e.g. "main", "HEAD~3", "main...HEAD"). Default: working tree vs HEAD.'),
          staged: z.boolean().optional().describe("Diff the staged index instead of the working tree."),
          path: z.string().optional().describe("Limit the diff to this path (relative to the workspace)."),
          outputMode: z.enum(["digest", "stat", "files"]).optional().describe('"digest" hunks (default) | "stat" summary | "files" name-status list.'),
          context: z.number().int().min(0).optional().describe("Hunk context lines (default 3)."),
          maxTokens: z.number().int().positive().optional().describe("Bound output size (default: server read budget)."),
        },
        handler: async (args) => {
          try {
            const ref = args.ref === undefined ? undefined : String(args.ref);
            if (ref !== undefined && (ref.trim() === "" || ref.startsWith("-"))) {
              return fail(`invalid ref: ${JSON.stringify(ref)}`);
            }
            const staged = args.staged === true;
            const mode = (args.outputMode as string | undefined) ?? "digest";
            const context = args.context === undefined ? 3 : Number(args.context);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);

            if (!(await gitOk(["rev-parse", "--is-inside-work-tree"]))) {
              return fail("not a git repository (or git is unavailable) at the workspace root.");
            }

            const dargs = ["diff"];
            if (staged) dargs.push("--cached");
            if (mode === "stat") dargs.push("--stat");
            else if (mode === "files") dargs.push("--name-status");
            else dargs.push(`-U${context}`);
            if (ref !== undefined) {
              dargs.push(ref);
            } else if (!staged && (await gitOk(["rev-parse", "--verify", "--quiet", "HEAD"]))) {
              dargs.push("HEAD");
            }
            if (args.path !== undefined) {
              ctx.paths.resolve(String(args.path)); // sandbox check (throws if escaping)
              dargs.push("--", String(args.path));
            }

            const stdout = await runGit(dargs);
            if (stdout.trim() === "") {
              return ok(`No ${staged ? "staged " : ""}changes${ref ? ` vs ${ref}` : ""}.`);
            }

            const budgetChars = maxTokens * 4;
            if (stdout.length > budgetChars) {
              const cut = stdout.lastIndexOf("\n", budgetChars);
              return ok(
                stdout.slice(0, cut > 0 ? cut : budgetChars) +
                  `\n[diff truncated at ~${maxTokens} tokens — narrow with path, or use outputMode=stat/files]`,
              );
            }
            return ok(stdout);
          } catch (err) {
            return fail(`diff_digest failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };

  async function runGit(args: string[]): Promise<string> {
    const { stdout } = await execFileP("git", args, {
      cwd: ctx.config.root,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20_000,
      windowsHide: true,
      encoding: "utf8",
    });
    return stdout;
  }

  async function gitOk(args: string[]): Promise<boolean> {
    try {
      await runGit(args);
      return true;
    } catch {
      return false;
    }
  }
}
