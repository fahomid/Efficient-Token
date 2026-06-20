import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { gitOk, isSafeRef, runGit } from "../../core/git.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { splitLines } from "../../core/text.js";
import type { SymbolInfo } from "../../services/ast.js";

const MAX_FILES = 200;

/**
 * Computes the symbol-level delta between two revisions. For each changed file
 * it reports which symbols were added, removed, or changed (body differs), an
 * API-surface diff rather than a stream of hunks. Unlike review_branch (which is
 * working-tree, changed-only), this works on arbitrary rev-to-rev with
 * add/remove. Uses read-only git plus the AST.
 */
export function outlineDiffPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "outline-diff",
    version: "1.0.4",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "outline_diff",
        title: "Outline diff",
        description:
          "Symbol-level change between two git revisions: per changed file, the symbols added, removed, or changed (definition body differs), an API-surface diff without reading hunks. Pass ref (base) and optionally to (default: working tree); scope with path. Unlike review_branch (working-tree, changed-only), this does arbitrary rev-to-rev with add/remove. Read-only git.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          ref: z.string().describe('Base revision (branch/commit/tag, e.g. "main", "v1.0").'),
          to: z.string().optional().describe("Target revision (default: the working tree)."),
          path: z.string().optional().describe("Limit to this path (relative)."),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
        },
        handler: async (args) => {
          try {
            const root = ctx.config.root;
            const base = String(args.ref);
            if (!isSafeRef(base)) return fail(`invalid ref: ${JSON.stringify(base)}`);
            const to = args.to === undefined ? undefined : String(args.to);
            if (to !== undefined && !isSafeRef(to)) return fail(`invalid ref: ${JSON.stringify(to)}`);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);

            if (!(await gitOk(root, ["rev-parse", "--is-inside-work-tree"]))) {
              return fail("not a git repository (or git is unavailable) at the workspace root.");
            }

            const nameArgs = ["diff", "--name-only", base];
            if (to !== undefined) nameArgs.push(to);
            if (args.path !== undefined) {
              ctx.paths.resolve(String(args.path)); // sandbox check
              nameArgs.push("--", String(args.path));
            }
            const files = (await runGit(root, nameArgs)).split("\n").map((s) => s.trim()).filter(Boolean);
            if (files.length === 0) return ok(`No changes between ${base} and ${to ?? "the working tree"}.`);

            const budgetChars = maxTokens * 4;
            const sections: string[] = [];
            let used = 0;
            let truncated = false;
            let shown = 0;
            let skippedUnsupported = 0;

            for (const rel of files.slice(0, MAX_FILES)) {
              if (!ctx.ast.supports(rel)) { skippedUnsupported++; continue; }
              const baseContent = await showAt(ctx, base, rel);
              const toContent = to === undefined ? await readWorking(ctx, rel) : await showAt(ctx, to, rel);
              if (baseContent === undefined && toContent === undefined) continue;

              const baseSyms = await outlineMap(ctx, rel, baseContent);
              const toSyms = await outlineMap(ctx, rel, toContent);

              const added: string[] = [];
              const removed: string[] = [];
              const changed: string[] = [];
              for (const [key, s] of toSyms) {
                const b = baseSyms.get(key);
                if (!b) added.push(label(s.sym));
                else if (b.source !== s.source) changed.push(label(s.sym));
              }
              for (const [key, b] of baseSyms) {
                if (!toSyms.has(key)) removed.push(label(b.sym));
              }
              if (added.length === 0 && removed.length === 0 && changed.length === 0) continue;

              const lines = [`${rel}:`];
              if (added.length) lines.push(`  + added: ${added.join(", ")}`);
              if (removed.length) lines.push(`  - removed: ${removed.join(", ")}`);
              if (changed.length) lines.push(`  ~ changed: ${changed.join(", ")}`);
              const block = lines.join("\n");
              if (used + block.length + 1 > budgetChars) {
                truncated = true;
                break;
              }
              sections.push(block);
              used += block.length + 1;
              shown++;
            }

            const header = `outline_diff: ${base}..${to ?? "(working tree)"} — ${shown} file(s) with symbol changes`;
            const notes: string[] = [];
            if (truncated || files.length > MAX_FILES) notes.push("truncated — scope with path or raise maxTokens");
            if (skippedUnsupported > 0) notes.push(`${skippedUnsupported} changed file(s) skipped (unparsed type) — use diff_digest for their line-level changes`);
            const note = notes.length ? `\n[${notes.join("; ")}]` : "";
            if (shown === 0) return ok(`${header}\n(no symbol-level changes; changes are outside any symbol or in non-parsed files)${note}`);
            return ok(`${header}\n\n${sections.join("\n\n")}${note}`);
          } catch (err) {
            return fail(`outline_diff failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

interface Entry {
  sym: SymbolInfo;
  source: string;
}

async function outlineMap(ctx: CoreContext, rel: string, content: string | undefined): Promise<Map<string, Entry>> {
  const map = new Map<string, Entry>();
  if (content === undefined) return map;
  const lines = splitLines(content);
  const seen = new Map<string, number>();
  // Occurrence-index duplicate keys (overloads, multiple impl blocks, same-named
  // defs) by source order so the Nth on each side pairs up rather than collapsing.
  for (const s of (await ctx.ast.outline(rel, content)) ?? []) {
    const baseKey = [s.container ?? "", s.kind, s.name].join(" ");
    const n = seen.get(baseKey) ?? 0;
    seen.set(baseKey, n + 1);
    const key = n === 0 ? baseKey : `${baseKey}#${n}`;
    const source = lines.slice(s.startLine - 1, s.endLine).join("\n");
    map.set(key, { sym: s, source });
  }
  return map;
}

function label(s: SymbolInfo): string {
  return `${s.kind} ${s.container ? `${s.container}.` : ""}${s.name}`;
}

async function showAt(ctx: CoreContext, ref: string, rel: string): Promise<string | undefined> {
  try {
    let content = await runGit(ctx.config.root, ["show", `${ref}:./${rel}`]);
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    return content;
  } catch {
    return undefined; // not present at that revision
  }
}

async function readWorking(ctx: CoreContext, rel: string): Promise<string | undefined> {
  try {
    const { content } = await ctx.fs.read(rel);
    return content.includes(String.fromCharCode(0)) ? undefined : content;
  } catch {
    return undefined;
  }
}
