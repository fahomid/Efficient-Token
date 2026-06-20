import path from "node:path";

import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { changedLineSet, enclosingSymbol, parseChangedRanges } from "../../core/diff.js";
import { gitOk, isSafeRef, runGit } from "../../core/git.js";
import { errMessage, fail, ok } from "../../core/result.js";

const DEFAULT_ARTIFACTS = ["coverage/lcov.info", "lcov.info", "coverage/lcov"];

/**
 * Answer "did I test my change?" by intersecting the diff's changed lines with
 * an lcov coverage artifact, reporting covered vs uncovered changed lines and
 * their enclosing symbol. This saves reading a huge coverage report and
 * computing the intersection by hand. It is pure set arithmetic over real data
 * and never judges whether coverage is "enough".
 */
export function changeCoveragePlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "change-coverage",
    version: "1.0.4",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "change_coverage",
        title: "Change coverage",
        description:
          "Show which changed lines are covered vs uncovered by tests, intersecting the git diff with an lcov artifact (coverage/lcov.info) instead of reading a huge coverage report by hand. Uncovered changed lines are reported as file:line plus enclosing symbol. Use ref/path/artifact to scope. Read-only. Note that line numbers align only if the artifact matches the current tree.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          ref: z.string().optional().describe('Compare against this branch/commit/range (default: working tree vs HEAD).'),
          path: z.string().optional().describe("Limit to this path (relative)."),
          artifact: z.string().optional().describe("Path to an lcov.info file (default: coverage/lcov.info or lcov.info)."),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
        },
        handler: async (args) => {
          try {
            const root = ctx.config.root;
            const ref = args.ref === undefined ? undefined : String(args.ref);
            if (ref !== undefined && !isSafeRef(ref)) return fail(`invalid ref: ${JSON.stringify(ref)}`);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);

            if (!(await gitOk(root, ["rev-parse", "--is-inside-work-tree"]))) {
              return fail("not a git repository (or git is unavailable) at the workspace root.");
            }

            // Locate + parse the lcov artifact.
            const candidates = args.artifact !== undefined ? [String(args.artifact)] : DEFAULT_ARTIFACTS;
            let lcovText: string | undefined;
            let lcovRel = "";
            for (const cand of candidates) {
              try {
                const { content, abs } = await ctx.fs.read(cand);
                lcovText = content;
                lcovRel = ctx.paths.relative(abs);
                break;
              } catch {
                /* try next */
              }
            }
            if (lcovText === undefined) {
              return fail(`no coverage artifact found (looked in: ${candidates.join(", ")}). Generate one (e.g. run tests with coverage) and retry, or pass artifact=…`);
            }
            const cov = parseLcov(lcovText, root);

            // Changed lines per file (new side), via -U0 diff.
            const base = ["diff", "--unified=0"];
            if (ref !== undefined) base.push(ref);
            else if (await gitOk(root, ["rev-parse", "--verify", "--quiet", "HEAD"])) base.push("HEAD");
            if (args.path !== undefined) {
              ctx.paths.resolve(String(args.path)); // sandbox check
              base.push("--", String(args.path));
            }
            const ranges = parseChangedRanges(await runGit(root, base));
            if (ranges.size === 0) return ok(`No changes${ref ? ` vs ${ref}` : ""}.`);

            const budgetChars = maxTokens * 4;
            const sections: string[] = [];
            let totalExec = 0;
            let totalCovered = 0;
            let used = 0;
            let truncated = false;

            for (const [rel, fileRanges] of ranges) {
              const lines = lookupCoverage(cov, rel);
              if (lines === undefined) {
                const block = `\n${rel}: (no coverage data)`;
                if (used + block.length > budgetChars) { truncated = true; break; }
                sections.push(block);
                used += block.length;
                continue;
              }
              const { set: changed, capped: lineSetCapped } = changedLineSet(fileRanges);
              const execChanged: number[] = [];
              const uncovered: number[] = [];
              for (const L of changed) {
                const hits = lines.get(L);
                if (hits === undefined) continue; // non-executable (comment/brace/blank)
                execChanged.push(L);
                if (hits === 0) uncovered.push(L);
              }
              if (execChanged.length === 0) {
                const block = `\n${rel}: 0 executable changed lines`;
                if (used + block.length > budgetChars) { truncated = true; break; }
                sections.push(block);
                used += block.length;
                continue;
              }
              totalExec += execChanged.length;
              totalCovered += execChanged.length - uncovered.length;
              uncovered.sort((a, b) => a - b);

              const outline = ctx.ast.supports(rel) ? (await safeOutline(ctx, rel)) : [];
              const head = `\n${rel}: ${execChanged.length - uncovered.length}/${execChanged.length} changed lines covered${lineSetCapped ? " [changed-line set capped at 100k — coverage intersection is partial]" : ""}`;
              const detail = uncovered.length === 0
                ? "\n  ✓ all changed lines covered"
                : "\n" + uncovered.map((L) => {
                    const sym = enclosingSymbol(outline, L);
                    return `  uncovered ${rel}:${L}${sym ? `  (${sym.kind} ${sym.container ? `${sym.container}.` : ""}${sym.name})` : ""}`;
                  }).join("\n");
              const block = head + detail;
              if (used + block.length > budgetChars) { truncated = true; break; }
              sections.push(block);
              used += block.length;
            }

            const pct = totalExec > 0 ? Math.round((totalCovered / totalExec) * 100) : 100;
            const header = `change_coverage (lcov: ${lcovRel}) — ${totalCovered}/${totalExec} changed executable lines covered (${pct}%)`;
            const note = truncated ? "\n[truncated — scope with path or raise maxTokens]" : "";
            return ok(`${header}\n${sections.join("\n")}${note}`);
          } catch (err) {
            return fail(`change_coverage failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

/** Parse lcov into rel-path(lowercased) -> Map<line, hits>. */
function parseLcov(text: string, root: string): Map<string, Map<number, number>> {
  const map = new Map<string, Map<number, number>>();
  let lines: Map<number, number> | null = null;
  let key = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const sf = line.slice(3).trim();
      const abs = path.isAbsolute(sf) ? sf : path.join(root, sf);
      const rebased = path.relative(root, abs).split(path.sep).join("/").toLowerCase();
      // If the artifact's path can't be rebased under root (CI/monorepo absolute
      // SF paths), key by the normalized SF so a trailing-segment match can find it.
      const escapes = rebased.startsWith("../") || /^[a-z]:\//.test(rebased);
      key = escapes ? sf.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase() : rebased;
      lines = new Map();
    } else if (lines && line.startsWith("DA:")) {
      const comma = line.indexOf(",", 3);
      if (comma > 0) {
        const n = Number(line.slice(3, comma));
        const h = Number(line.slice(comma + 1));
        if (Number.isFinite(n)) lines.set(n, (lines.get(n) ?? 0) + (Number.isFinite(h) ? h : 0));
      }
    } else if (line === "end_of_record" && lines) {
      map.set(key, lines);
      lines = null;
    }
  }
  return map;
}

/** Exact key, else a unique coverage entry whose path ends with `/<rel>` (else undefined). */
function lookupCoverage(cov: Map<string, Map<number, number>>, rel: string): Map<number, number> | undefined {
  const key = rel.toLowerCase();
  const exact = cov.get(key);
  if (exact) return exact;
  const suffix = `/${key}`;
  let hit: Map<number, number> | undefined;
  for (const [k, v] of cov) {
    if (k.endsWith(suffix)) {
      if (hit) return undefined; // ambiguous: don't guess, stay deterministic
      hit = v;
    }
  }
  return hit;
}

async function safeOutline(ctx: CoreContext, rel: string) {
  try {
    const { content } = await ctx.fs.read(rel);
    return (await ctx.ast.outline(rel, content)) ?? [];
  } catch {
    return [];
  }
}
