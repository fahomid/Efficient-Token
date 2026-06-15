import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { gitOk, runGit } from "../../core/git.js";
import { errMessage, fail, ok } from "../../core/result.js";

interface BlameMeta {
  author: string;
  date: string;
  summary: string;
}

/**
 * Reports who last changed each line, with contiguous same-commit runs
 * collapsed into ranges, so a region authored in one commit is one row, not N.
 * Scope to a symbol or line range to keep it tight.
 */
export function lineBlamePlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "line-blame",
    version: "1.0.2",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "line_blame",
        title: "Line blame",
        description:
          "Line provenance via git blame, with contiguous same-commit runs collapsed into ranges (Lstart-Lend  sha  date  author  summary), far more compact than per-line blame. Scope with symbol (mapped to its span via the AST) or startLine/endLine; omit both for the whole file (token-bounded). Use this to see who/when/why a region last changed. Read-only git.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          path: z.string().describe("File path relative to the workspace root."),
          symbol: z.string().optional().describe("Blame just this symbol's span (alternative to startLine/endLine)."),
          startLine: z.number().int().positive().optional().describe("1-based span start."),
          endLine: z.number().int().positive().optional().describe("1-based span end."),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
        },
        handler: async (args) => {
          try {
            const p = String(args.path);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const root = ctx.config.root;
            const abs = ctx.paths.resolve(p); // sandbox check
            const rel = ctx.paths.relative(abs);

            if (!(await gitOk(root, ["rev-parse", "--is-inside-work-tree"]))) {
              return fail("not a git repository (or git is unavailable) at the workspace root.");
            }

            let range: [number, number] | undefined;
            let label = "whole file";
            if (args.startLine !== undefined || args.endLine !== undefined) {
              let s = Number(args.startLine ?? args.endLine);
              let e = Number(args.endLine ?? args.startLine);
              if (e < s) [s, e] = [e, s];
              range = [s, e];
              label = `lines ${s}-${e}`;
            } else if (args.symbol !== undefined) {
              const symbol = String(args.symbol);
              const content = (await ctx.fs.read(p)).content;
              const matches = await ctx.ast.findSymbol(p, content, symbol);
              if (matches === undefined) return fail(`${rel} — no grammar for this file type; pass startLine/endLine instead.`);
              const target = matches[0];
              if (target === undefined) {
                const names = (await ctx.ast.outline(p, content) ?? []).map((x) => x.name);
                return fail(`${rel} — symbol "${symbol}" not found. ${names.length ? `Defined: ${names.join(", ")}` : ""}`);
              }
              range = [target.startLine, target.endLine];
              label = `${target.kind} ${target.name} (lines ${range[0]}-${range[1]})`;
            }

            const gargs = ["blame", "--porcelain"];
            if (range) gargs.push(`-L${range[0]},${range[1]}`);
            gargs.push("--", rel);

            let stdout: string;
            try {
              stdout = await runGit(root, gargs);
            } catch (e) {
              return fail(`could not blame ${rel}: ${errMessage(e).trim()}`);
            }

            const runs = collapse(parsePorcelain(stdout));
            if (runs.length === 0) return ok(`No blame for ${rel} ${label}.`);

            const budgetChars = maxTokens * 4;
            const rows: string[] = [];
            let used = 0;
            let capped = false;
            for (const r of runs) {
              const span = r.startLine === r.endLine ? `L${r.startLine}` : `L${r.startLine}-${r.endLine}`;
              const row =
                r.sha === ZERO
                  ? `  ${span}  (uncommitted)`
                  : `  ${span}  ${r.sha.slice(0, 8)}  ${r.meta.date}  ${r.meta.author}  ${r.meta.summary}`;
              if (used + row.length + 1 > budgetChars) {
                capped = true;
                break;
              }
              rows.push(row);
              used += row.length + 1;
            }
            const note = capped ? "\n[truncated — scope with symbol/range or raise maxTokens]" : "";
            return ok(`line_blame: ${rel} — ${label} (${rows.length} run(s))\n${rows.join("\n")}${note}`);
          } catch (err) {
            return fail(`line_blame failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

const ZERO = "0000000000000000000000000000000000000000";

interface BlamedLine {
  sha: string;
  finalLine: number;
  meta: BlameMeta;
}

/** Parse `git blame --porcelain` into per-line {sha, finalLine, meta}. */
function parsePorcelain(out: string): BlamedLine[] {
  const lines = out.split("\n");
  const metaBySha = new Map<string, BlameMeta>();
  const result: BlamedLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i] ?? "";
    const m = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(header);
    if (!m) {
      i++;
      continue;
    }
    const sha = m[1]!;
    const finalLine = Number(m[2]);
    i++;
    let meta = metaBySha.get(sha);
    const collected: Partial<BlameMeta> = {};
    let authorTime = 0;
    while (i < lines.length && !lines[i]!.startsWith("\t")) {
      const l = lines[i]!;
      if (l.startsWith("author ")) collected.author = l.slice(7).trim();
      else if (l.startsWith("author-time ")) authorTime = Number(l.slice(12).trim());
      else if (l.startsWith("summary ")) collected.summary = l.slice(8).trim();
      i++;
    }
    if (i < lines.length && lines[i]!.startsWith("\t")) i++; // skip the content line
    if (meta === undefined) {
      meta = {
        author: collected.author ?? "?",
        summary: collected.summary ?? "",
        date: authorTime > 0 ? new Date(authorTime * 1000).toISOString().slice(0, 10) : "",
      };
      if (sha !== ZERO) metaBySha.set(sha, meta);
    }
    result.push({ sha, finalLine, meta });
  }
  return result;
}

interface BlameRun {
  sha: string;
  startLine: number;
  endLine: number;
  meta: BlameMeta;
}

/** Collapse contiguous same-commit lines into runs. */
function collapse(blamed: BlamedLine[]): BlameRun[] {
  const sorted = [...blamed].sort((a, b) => a.finalLine - b.finalLine);
  const runs: BlameRun[] = [];
  for (const b of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.sha === b.sha && b.finalLine === last.endLine + 1) {
      last.endLine = b.finalLine;
    } else {
      runs.push({ sha: b.sha, startLine: b.finalLine, endLine: b.finalLine, meta: b.meta });
    }
  }
  return runs;
}
