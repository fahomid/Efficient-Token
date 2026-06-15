import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { splitLines, truncate } from "../../core/text.js";
import { escapeRegExp, TYPE_EXTS } from "../../services/scan.js";

const DEFAULT_TAGS = ["TODO", "FIXME", "HACK", "XXX", "BUG"];
const DEFAULT_HEAD = 200;
const MAX_SCAN_FILES = 10_000;

/**
 * Collects code-comment markers (TODO / FIXME / HACK / …) across the workspace
 * as `file:line  text`, grouped by tag, instead of grepping and opening files.
 * Matches markers only after a comment leader, so prose words aren't false
 * positives. Returns the real comment lines.
 */
export function markerInventoryPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "marker-inventory",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "marker_inventory",
        title: "Marker inventory",
        description:
          "Inventory code-comment markers (TODO, FIXME, HACK, XXX, BUG by default; pass tags to customize) across the workspace, grouped by tag, each as file:line plus the marker text, instead of grepping and opening files. Only matches markers after a comment leader (//, #, /*, *, <!--, ;, --) so prose isn't a false positive. Scope with path/glob/type. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          tags: z.array(z.string()).optional().describe(`Marker tags to look for (default: ${DEFAULT_TAGS.join(", ")}).`),
          path: z.string().optional().describe("Directory/file to scope to (relative)."),
          glob: z.string().optional().describe("Only files matching this glob."),
          type: z.string().optional().describe('Only this file type, e.g. "ts".'),
          headLimit: z.number().int().positive().optional().describe(`Max markers to return (default ${DEFAULT_HEAD}).`),
          maxTokens: z.number().int().positive().optional().describe("Output token budget."),
        },
        handler: async (args) => {
          try {
            const tags = (Array.isArray(args.tags) && args.tags.length > 0 ? args.tags : DEFAULT_TAGS)
              .map((t) => String(t).trim())
              .filter((t) => /^[A-Za-z0-9_]+$/.test(t));
            if (tags.length === 0) return fail("no valid tags (use word characters only).");
            const head = args.headLimit === undefined ? DEFAULT_HEAD : Number(args.headLimit);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const type = args.type === undefined ? undefined : String(args.type).toLowerCase();
            const exts = type ? TYPE_EXTS[type] ?? [type] : undefined;

            const tagAlt = tags.map(escapeRegExp).join("|");
            // A comment leader, then (soon after) the tag, then the marker text.
            const re = new RegExp(`(?://+|/\\*+|\\*|#+|<!--|;+|--)\\s*(${tagAlt})\\b[:(\\s]?\\s*(.*)`);

            const scan = await ctx.scan.files({
              ...(args.path !== undefined ? { within: String(args.path) } : {}),
              ...(args.glob !== undefined ? { glob: String(args.glob) } : {}),
              ...(exts ? { exts } : {}),
              maxFiles: MAX_SCAN_FILES,
            });

            const byTag = new Map<string, string[]>();
            for (const t of tags) byTag.set(t, []);
            let total = 0;
            let shown = 0;
            const budgetChars = maxTokens * 4;
            let used = 0;
            let capped = false;

            outer: for (const f of scan.files) {
              const content = await readText(ctx, f.rel);
              if (content === undefined) continue;
              if (!tags.some((t) => content.includes(t))) continue; // fast reject
              const lines = splitLines(content);
              for (let i = 0; i < lines.length; i++) {
                const m = re.exec(lines[i]!);
                if (!m) continue;
                const tag = m[1]!.toUpperCase();
                const bucket = byTag.get(tag) ?? byTag.get(m[1]!);
                if (!bucket) continue;
                total++;
                if (shown >= head || capped) continue;
                const text = truncate((m[2] ?? "").trim(), 160);
                const row = `  ${f.rel}:${i + 1}  ${text}`;
                if (used + row.length + 1 > budgetChars) {
                  capped = true;
                  continue;
                }
                bucket.push(row);
                used += row.length + 1;
                shown++;
              }
              if (capped && shown >= head) break outer;
            }

            if (total === 0) return ok(`No markers (${tags.join(", ")}) found.`);

            const sections: string[] = [];
            for (const t of tags) {
              const rows = byTag.get(t)!;
              if (rows.length > 0) sections.push(`${t} (${rows.length}):\n${rows.join("\n")}`);
            }
            const bounded = capped || total > shown || scan.truncated;
            const note = bounded ? "\n[results bounded — narrow with path/type/tags or raise headLimit/maxTokens]" : "";
            return ok(`marker_inventory — ${total}${bounded ? "+" : ""} marker(s):\n\n${sections.join("\n\n")}${note}`);
          } catch (err) {
            return fail(`marker_inventory failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

async function readText(ctx: CoreContext, rel: string): Promise<string | undefined> {
  try {
    const { content } = await ctx.fs.read(rel);
    return content.includes(String.fromCharCode(0)) ? undefined : content;
  } catch {
    return undefined;
  }
}
