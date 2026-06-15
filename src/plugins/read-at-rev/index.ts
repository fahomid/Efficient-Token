import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { gitOk, gitShortRef, isSafeRef, runGit } from "../../core/git.js";
import { renderRead } from "../../core/read.js";
import { errMessage, fail } from "../../core/result.js";

/**
 * The historical analog of code_read. Reads one symbol or line range from a file
 * as it was at a git revision, instead of `git show <ref>:file` dumping the whole
 * file. Same faithful slice and degrade-to-outline behavior as code_read, over
 * read-only git.
 */
export function readAtRevPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "read-at-rev",
    version: "1.0.2",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "read_at_rev",
        title: "Read at revision",
        description:
          'Read a file as of a git revision: one symbol, a line range, or the whole file (degrades to an outline over budget), instead of `git show <ref>:file` dumping everything. Pass ref (branch/commit/tag, e.g. "main", "HEAD~3", a SHA) and path; optionally symbol or startLine/endLine. Use this to see an old version of just the code you care about. Read-only git.',
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          path: z.string().describe("File path relative to the workspace root."),
          ref: z.string().describe('Git revision: branch/commit/tag (e.g. "main", "HEAD~3", a SHA).'),
          symbol: z.string().optional().describe("A single symbol to extract from that revision."),
          startLine: z.number().int().positive().optional().describe("1-based range start."),
          endLine: z.number().int().positive().optional().describe("1-based range end."),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
        },
        handler: async (args) => {
          try {
            const p = String(args.path);
            const ref = String(args.ref);
            if (!isSafeRef(ref)) return fail(`invalid ref: ${JSON.stringify(ref)}`);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const root = ctx.config.root;

            const abs = ctx.paths.resolve(p); // sandbox check (throws if escaping)
            const rel = ctx.paths.relative(abs);

            if (!(await gitOk(root, ["rev-parse", "--is-inside-work-tree"]))) {
              return fail("not a git repository (or git is unavailable) at the workspace root.");
            }

            let content: string;
            try {
              // `:./<rel>` resolves relative to cwd (the workspace root), so this
              // works whether the root is the repo top-level or a sub-directory.
              content = await runGit(root, ["show", `${ref}:./${rel}`]);
            } catch (e) {
              return fail(`could not read ${rel} at ${ref}: ${errMessage(e).trim()}`);
            }
            if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // strip BOM

            const short = await gitShortRef(root, ref);
            return await renderRead(ctx, {
              filePath: p,
              content,
              displayRel: `${rel} @${short}`,
              ...(args.symbol !== undefined ? { symbol: String(args.symbol) } : {}),
              ...(args.startLine !== undefined ? { startLine: Number(args.startLine) } : {}),
              ...(args.endLine !== undefined ? { endLine: Number(args.endLine) } : {}),
              maxTokens,
            });
          } catch (err) {
            return fail(`read_at_rev failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}
