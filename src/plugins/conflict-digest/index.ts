import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { gitOk, runGit } from "../../core/git.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { numberLines, splitLines } from "../../core/text.js";

interface ConflictBlock {
  startLine: number; // 1-based line of the <<<<<<< marker
  oursLabel: string;
  theirsLabel: string;
  ours: { start: number; lines: string[] };
  base?: { start: number; lines: string[] };
  theirs: { start: number; lines: string[] };
}

/**
 * `conflict_digest` — show ONLY the three-way conflict regions of merge-
 * conflicted files (ours / base / theirs, verbatim + line-numbered), instead of
 * reading whole files to hunt for `<<<<<<<` markers. Extracts; never proposes a
 * resolution (that's the model's call). Read-only. Free tier.
 */
export function conflictDigestPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "conflict-digest",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "conflict_digest",
        title: "Conflict digest",
        description:
          "List unresolved merge conflicts as just their three-way regions — per file, per conflict: the ours / base / theirs sides sliced VERBATIM and line-numbered — instead of reading whole conflicted files to find the markers. Optionally scope to a path. Extracts only; you decide the resolution. Read-only git.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          path: z.string().optional().describe("Limit to this path (relative to the workspace)."),
          maxTokens: z.number().int().positive().optional().describe("Bound output size (default: server read budget)."),
        },
        handler: async (args) => {
          try {
            const root = ctx.config.root;
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);

            if (!(await gitOk(root, ["rev-parse", "--is-inside-work-tree"]))) {
              return fail("not a git repository (or git is unavailable) at the workspace root.");
            }

            const dargs = ["diff", "--name-only", "--diff-filter=U"];
            if (args.path !== undefined) {
              ctx.paths.resolve(String(args.path)); // sandbox check
              dargs.push("--", String(args.path));
            }
            const listing = (await runGit(root, dargs)).split("\n").map((s) => s.trim()).filter(Boolean);
            if (listing.length === 0) return ok("No unresolved merge conflicts.");

            const budgetChars = maxTokens * 4;
            const out: string[] = [`${listing.length} conflicted file(s):`];
            let used = out[0]!.length;
            let truncated = false;

            for (const rel of listing) {
              let content: string;
              try {
                content = (await ctx.fs.read(rel)).content;
              } catch {
                out.push(`\n### ${rel} (could not read working tree)`);
                continue;
              }
              const blocks = parseConflicts(content);
              const fileHeader = `\n### ${rel} — ${blocks.length} conflict(s)`;
              if (used + fileHeader.length > budgetChars) {
                truncated = true;
                break;
              }
              out.push(fileHeader);
              used += fileHeader.length;

              for (const b of blocks) {
                const piece = renderBlock(b);
                if (used + piece.length > budgetChars) {
                  truncated = true;
                  break;
                }
                out.push(piece);
                used += piece.length;
              }
              if (truncated) break;
            }

            const note = truncated ? "\n[truncated — scope with path or raise maxTokens]" : "";
            return ok(out.join("\n") + note);
          } catch (err) {
            return fail(`conflict_digest failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

/** Parse `<<<<<<< / ||||||| / ======= / >>>>>>>` regions with real line numbers. */
function parseConflicts(content: string): ConflictBlock[] {
  const lines = splitLines(content);
  const blocks: ConflictBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.startsWith("<<<<<<<")) {
      i++;
      continue;
    }
    const startLine = i + 1;
    const oursLabel = lines[i]!.slice(7).trim();
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let oursStart = 0;
    let baseStart = 0;
    let theirsStart = 0;
    let section: "ours" | "base" | "theirs" = "ours";
    let theirsLabel = "";
    i++;
    while (i < lines.length && !lines[i]!.startsWith(">>>>>>>")) {
      const l = lines[i]!;
      if (l.startsWith("|||||||")) {
        section = "base";
        i++;
        continue;
      }
      if (l.startsWith("=======")) {
        section = "theirs";
        i++;
        continue;
      }
      if (section === "ours") {
        if (ours.length === 0) oursStart = i + 1;
        ours.push(l);
      } else if (section === "base") {
        if (base.length === 0) baseStart = i + 1;
        base.push(l);
      } else {
        if (theirs.length === 0) theirsStart = i + 1;
        theirs.push(l);
      }
      i++;
    }
    if (i < lines.length) {
      theirsLabel = lines[i]!.slice(7).trim();
      i++;
    }
    const block: ConflictBlock = {
      startLine,
      oursLabel,
      theirsLabel,
      ours: { start: oursStart || startLine + 1, lines: ours },
      theirs: { start: theirsStart || startLine + 1, lines: theirs },
    };
    if (base.length > 0) block.base = { start: baseStart, lines: base };
    blocks.push(block);
  }
  return blocks;
}

function renderBlock(b: ConflictBlock): string {
  const parts = [`\n@L${b.startLine}  ours «${b.oursLabel || "HEAD"}» vs theirs «${b.theirsLabel || "incoming"}»`];
  parts.push(`  --- ours ---`, numberLines(b.ours.lines, b.ours.start));
  if (b.base) parts.push(`  --- base ---`, numberLines(b.base.lines, b.base.start));
  parts.push(`  --- theirs ---`, numberLines(b.theirs.lines, b.theirs.start));
  return parts.join("\n");
}
