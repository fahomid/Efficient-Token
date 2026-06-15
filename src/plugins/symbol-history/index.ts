import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { gitOk, isSafeRef, runGit } from "../../core/git.js";
import { errMessage, fail, ok } from "../../core/result.js";

/**
 * Traces the history of one symbol (or line range) via `git log -L`, instead of
 * chaining `git log` with per-commit `git show` and dragging in unrelated file
 * context. `list` mode gives the commits that touched the span; `hunks` mode
 * gives the verbatim per-revision diff of just that span. Read-only git.
 */
export function symbolHistoryPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "symbol-history",
    version: "1.0.1",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "symbol_history",
        title: "Symbol history",
        description:
          "History of a single symbol (or line range) via git log -L, not the whole file's log. Pass path + symbol (mapped to its span via the AST) or path + startLine/endLine. mode: list (default, commits as sha date author subject) | hunks (per-revision diff of that span). Optional ref limits how far back. Read-only git.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          path: z.string().describe("File path relative to the workspace root."),
          symbol: z.string().optional().describe("Symbol whose line span to trace (alternative to startLine/endLine)."),
          startLine: z.number().int().positive().optional().describe("1-based span start (with endLine)."),
          endLine: z.number().int().positive().optional().describe("1-based span end (with startLine)."),
          mode: z.enum(["list", "hunks"]).optional().describe('"list" commits (default) | "hunks" per-revision diff.'),
          ref: z.string().optional().describe("Limit history to commits reachable from this ref (e.g. a branch)."),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
        },
        handler: async (args) => {
          try {
            const p = String(args.path);
            const mode = (args.mode as string | undefined) ?? "list";
            const ref = args.ref === undefined ? undefined : String(args.ref);
            if (ref !== undefined && !isSafeRef(ref)) return fail(`invalid ref: ${JSON.stringify(ref)}`);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const root = ctx.config.root;

            const abs = ctx.paths.resolve(p); // sandbox check
            const rel = ctx.paths.relative(abs);

            if (!(await gitOk(root, ["rev-parse", "--is-inside-work-tree"]))) {
              return fail("not a git repository (or git is unavailable) at the workspace root.");
            }

            let start: number;
            let end: number;
            let label: string;
            if (args.startLine !== undefined || args.endLine !== undefined) {
              start = Number(args.startLine ?? args.endLine);
              end = Number(args.endLine ?? args.startLine);
              if (end < start) [start, end] = [end, start];
              label = `lines ${start}-${end}`;
            } else if (args.symbol !== undefined) {
              // Resolve the span against the version being logged (the ref tip,
              // default HEAD) so -L's line numbers align; fall back to the
              // working tree for an as-yet-uncommitted file.
              const symbol = String(args.symbol);
              const tip = ref ?? "HEAD";
              let content: string;
              try {
                content = await runGit(root, ["show", `${tip}:./${rel}`]);
              } catch {
                content = (await ctx.fs.read(p)).content;
              }
              if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
              const matches = await ctx.ast.findSymbol(p, content, symbol);
              if (matches === undefined) {
                return fail(`${rel} — no grammar for this file type; pass startLine/endLine instead.`);
              }
              const target = matches[0];
              if (target === undefined) {
                const names = (await ctx.ast.outline(p, content) ?? []).map((s) => s.name);
                return fail(`${rel} — symbol "${symbol}" not found at ${tip}. ${names.length ? `Defined: ${names.join(", ")}` : ""}`);
              }
              start = target.startLine;
              end = target.endLine;
              label = `${target.kind} ${target.name} (lines ${start}-${end})`;
            } else {
              return fail("provide a symbol, or startLine and endLine.");
            }

            const gargs = ["log", `-L${start},${end}:${rel}`, "--date=short"];
            if (mode === "list") gargs.push("-s", "--format=%h %ad %an %s");
            else gargs.push("--format=commit %h %ad %s");
            if (ref !== undefined) gargs.push(ref);

            let stdout: string;
            try {
              stdout = await runGit(root, gargs);
            } catch (e) {
              return fail(`could not trace ${rel} ${label}: ${errMessage(e).trim()}`);
            }
            if (stdout.trim() === "") return ok(`No history for ${rel} ${label}.`);

            const header = `symbol_history: ${rel} — ${label}${ref ? ` (≤ ${ref})` : ""} [${mode}]`;
            const budgetChars = maxTokens * 4;
            let body = stdout.replace(/\s+$/, "");
            if (body.length > budgetChars) {
              const cut = body.lastIndexOf("\n", budgetChars);
              body = `${body.slice(0, cut > 0 ? cut : budgetChars)}\n[truncated at ~${maxTokens} tokens — use mode=list, narrow the range, or raise maxTokens]`;
            }
            return ok(`${header}\n${body}`);
          } catch (err) {
            return fail(`symbol_history failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}
