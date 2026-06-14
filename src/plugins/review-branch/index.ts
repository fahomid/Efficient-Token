import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { gitOk, isSafeRef, runGit } from "../../core/git.js";
import { errMessage, fail, ok } from "../../core/result.js";
import type { SymbolInfo } from "../../services/ast.js";

const MAX_CHANGED_LINES = 3000;

/**
 * `review_branch` — a SEMANTIC change summary: for a ref/branch, list each
 * changed file with the symbols (functions/classes/methods) that changed,
 * instead of raw hunks. Use it to review what changed without reading diffs or
 * files. Read-only git + AST. Free tier.
 */
export function reviewBranchPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "review-branch",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "review_branch",
        title: "Review changes",
        description:
          "Summarize git changes SEMANTICALLY: each changed file with the functions/classes/methods that changed (mapped from the diff to the AST) — not raw hunks. Defaults to uncommitted changes vs HEAD; pass ref (branch/commit/range), staged=true, or path to scope. Use this to review a branch/PR compactly. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          ref: z.string().optional().describe('Compare against this branch/commit/range (e.g. "main", "main...HEAD"). Default: working tree vs HEAD.'),
          staged: z.boolean().optional().describe("Review the staged index instead of the working tree."),
          path: z.string().optional().describe("Limit to this path (relative)."),
          maxTokens: z.number().int().positive().optional().describe("Bound output size (default: server read budget)."),
        },
        handler: async (args) => {
          try {
            const root = ctx.config.root;
            const ref = args.ref === undefined ? undefined : String(args.ref);
            if (ref !== undefined && !isSafeRef(ref)) return fail(`invalid ref: ${JSON.stringify(ref)}`);
            const staged = args.staged === true;
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);

            if (!(await gitOk(root, ["rev-parse", "--is-inside-work-tree"]))) {
              return fail("not a git repository (or git is unavailable) at the workspace root.");
            }

            const base = ["diff"];
            if (staged) base.push("--cached");
            const tail: string[] = [];
            if (ref !== undefined) tail.push(ref);
            else if (!staged && (await gitOk(root, ["rev-parse", "--verify", "--quiet", "HEAD"]))) tail.push("HEAD");
            const pathArgs: string[] = [];
            if (args.path !== undefined) {
              ctx.paths.resolve(String(args.path)); // sandbox check
              pathArgs.push("--", String(args.path));
            }

            const numstat = parseNumstat(await runGit(root, [...base, "--numstat", ...tail, ...pathArgs]));
            if (numstat.length === 0) {
              return ok(`No ${staged ? "staged " : ""}changes${ref ? ` vs ${ref}` : ""}.`);
            }
            const ranges = parseRanges(await runGit(root, [...base, "--unified=0", ...tail, ...pathArgs]));

            const budget = maxTokens * 4;
            const sections: string[] = [];
            let used = 0;
            let shown = 0;
            let truncated = false;

            for (const file of numstat) {
              const headLine = `${file.path} (+${file.adds}/-${file.dels})`;
              let detail: string;
              if (file.binary) {
                detail = "  (binary)";
              } else {
                const content = await readText(ctx, file.path);
                if (content === undefined) {
                  detail = "  (deleted or unreadable)";
                } else if (!ctx.ast.supports(file.path)) {
                  detail = "  (no parsed symbols for this file type)";
                } else {
                  const outline = (await ctx.ast.outline(file.path, content)) ?? [];
                  const changed = changedSymbols(outline, ranges.get(file.path) ?? []);
                  detail = changed.length
                    ? changed.map((s) => `  ~ ${s.kind} ${s.container ? `${s.container}.` : ""}${s.name}`).join("\n")
                    : "  (changes outside any symbol)";
                }
              }
              const block = `${headLine}\n${detail}`;
              if (used + block.length + 1 > budget) {
                truncated = true;
                break;
              }
              sections.push(block);
              used += block.length + 1;
              shown++;
            }

            const scope = ref ?? (staged ? "staged" : "working tree vs HEAD");
            const header = `review: ${scope} — ${shown}${truncated ? `/${numstat.length}` : ""} file(s) changed`;
            const note = truncated ? "\n[truncated — narrow with path or raise maxTokens]" : "";
            return ok(`${header}\n\n${sections.join("\n")}${note}`);
          } catch (err) {
            return fail(`review_branch failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

interface NumstatEntry {
  adds: string;
  dels: string;
  binary: boolean;
  path: string;
}

function parseNumstat(s: string): NumstatEntry[] {
  const out: NumstatEntry[] = [];
  for (const line of s.split("\n")) {
    if (line.trim() === "") continue;
    const t1 = line.indexOf("\t");
    const t2 = line.indexOf("\t", t1 + 1);
    if (t1 < 0 || t2 < 0) continue;
    const adds = line.slice(0, t1);
    const dels = line.slice(t1 + 1, t2);
    out.push({ adds, dels, binary: adds === "-" && dels === "-", path: line.slice(t2 + 1) });
  }
  return out;
}

/** Map each changed file to its NEW-side changed line ranges (from `-U0`). */
function parseRanges(diff: string): Map<string, Array<[number, number]>> {
  const map = new Map<string, Array<[number, number]>>();
  let cur: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      cur = p === "/dev/null" ? null : p.startsWith("b/") ? p.slice(2) : p;
      if (cur && !map.has(cur)) map.set(cur, []);
    } else if (cur && line.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (m) {
        const c = Number(m[1]);
        const d = m[2] === undefined ? 1 : Number(m[2]);
        if (d > 0) map.get(cur)!.push([c, c + d - 1]);
      }
    }
  }
  return map;
}

function changedSymbols(outline: SymbolInfo[], ranges: Array<[number, number]>): SymbolInfo[] {
  const set = new Map<string, SymbolInfo>();
  let budget = MAX_CHANGED_LINES;
  for (const [c, e] of ranges) {
    for (let L = c; L <= e && budget > 0; L++, budget--) {
      const s = enclosing(outline, L);
      if (s) set.set(`${s.startLine}:${s.name}`, s);
    }
  }
  return [...set.values()].sort((a, b) => a.startLine - b.startLine);
}

function enclosing(outline: SymbolInfo[], lineNo: number): SymbolInfo | undefined {
  let best: SymbolInfo | undefined;
  for (const s of outline) {
    if (s.startLine <= lineNo && lineNo <= s.endLine) {
      if (!best || s.startLine > best.startLine) best = s;
    }
  }
  return best;
}

async function readText(ctx: CoreContext, rel: string): Promise<string | undefined> {
  try {
    const { content } = await ctx.fs.read(rel);
    return content.includes(String.fromCharCode(0)) ? undefined : content;
  } catch {
    return undefined;
  }
}
