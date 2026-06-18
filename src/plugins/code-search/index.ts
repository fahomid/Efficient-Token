import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { splitLines, truncate } from "../../core/text.js";
import { TYPE_EXTS } from "../../services/scan.js";

const DEFAULT_HEAD = 100;
const MAX_SCAN_FILES = 10_000;
const MAX_LINE = 400;

/**
 * Regex content search across the workspace, mirroring Claude's `Grep`
 * (ripgrep) tool: `glob`/`type` filters; `content`/`files_with_matches`/`count`
 * output modes; context lines; case-insensitive and multiline. Returns matching
 * lines or paths, never whole files.
 */
export function codeSearchPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "code-search",
    version: "1.0.3",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "code_search",
        title: "Search code",
        description:
          "Regex search across the workspace, mirroring Claude's Grep (ripgrep): same params (output_mode, -i, -A/-B/-C, -n, -o, head_limit, glob, type, multiline). Returns matching file paths (default), matching lines (output_mode=content), or per-file counts (output_mode=count), not whole files. Prefer this over reading many files to find where something is. Skips node_modules/.git/build dirs.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          pattern: z.string().min(1).describe("Regular expression to search for."),
          path: z.string().optional().describe("File or directory to scope the search to. Default: whole workspace."),
          glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts" or "src/**/*.tsx".'),
          type: z.string().optional().describe('Only search this file type, e.g. "ts", "py", "go".'),
          output_mode: z
            .enum(["content", "files_with_matches", "count"])
            .optional()
            .describe('"files_with_matches" (default) | "content" (matching lines) | "count".'),
          "-i": z.boolean().optional().describe("Case-insensitive match."),
          "-A": z.number().int().min(0).optional().describe("Lines of context after each match (content mode)."),
          "-B": z.number().int().min(0).optional().describe("Lines of context before each match (content mode)."),
          "-C": z.number().int().min(0).optional().describe("Lines of context before and after each match (content mode)."),
          "-n": z.boolean().optional().describe("Show line numbers in content output (default true)."),
          "-o": z.boolean().optional().describe("Output only the matched parts, one per line (content mode)."),
          multiline: z.boolean().optional().describe("Let the pattern span lines (dot matches newline)."),
          head_limit: z.number().int().positive().optional().describe(`Cap results (default ${DEFAULT_HEAD}).`),
        },
        handler: async (args) => {
          try {
            const pattern = String(args.pattern);
            const mode = (args["output_mode"] as string | undefined) ?? "files_with_matches";
            const insensitive = args["-i"] === true;
            const multiline = args.multiline === true;
            const head = args["head_limit"] === undefined ? DEFAULT_HEAD : Number(args["head_limit"]);
            const before = numOr(args["-B"], numOr(args["-C"], 0));
            const after = numOr(args["-A"], numOr(args["-C"], 0));
            const showLineNo = args["-n"] !== false; // Grep -n defaults to true
            const onlyMatching = args["-o"] === true;

            let lineRe: RegExp;
            let blockRe: RegExp;
            try {
              lineRe = new RegExp(pattern, insensitive ? "i" : "");
              blockRe = new RegExp(pattern, `g${insensitive ? "i" : ""}s`);
            } catch (e) {
              return fail(`invalid regex: ${errMessage(e)}`);
            }

            const type = args.type === undefined ? undefined : String(args.type).toLowerCase();
            const exts = type ? TYPE_EXTS[type] ?? [type] : undefined;
            const scan = await ctx.scan.files({
              ...(args.path !== undefined ? { within: String(args.path) } : {}),
              ...(args.glob !== undefined ? { glob: String(args.glob) } : {}),
              ...(exts ? { exts } : {}),
              maxFiles: MAX_SCAN_FILES,
            });

            const matchesText = (content: string): boolean =>
              multiline ? blockRe.test(content) : splitLines(content).some((l) => lineRe.test(l));

            if (mode === "files_with_matches") {
              const hits: string[] = [];
              for (const f of scan.files) {
                const content = await readText(ctx, f.rel);
                if (content === undefined) continue;
                blockRe.lastIndex = 0;
                if (matchesText(content)) hits.push(f.rel);
                if (hits.length >= head) break;
              }
              const capped = hits.length >= head;
              if (hits.length === 0) return ok(noMatchMessage(args));
              return ok(
                `${hits.length}${capped ? "+" : ""} file(s) with matches:\n${hits.join("\n")}` +
                  trailer(scan.truncated, capped),
              );
            }

            if (mode === "count") {
              const counts: Array<[string, number]> = [];
              for (const f of scan.files) {
                const content = await readText(ctx, f.rel);
                if (content === undefined) continue;
                const n = multiline ? countAll(blockRe, content) : splitLines(content).filter((l) => lineRe.test(l)).length;
                if (n > 0) counts.push([f.rel, n]);
                if (counts.length >= head) break;
              }
              if (counts.length === 0) return ok(noMatchMessage(args));
              const total = counts.reduce((a, [, n]) => a + n, 0);
              return ok(
                `${total} match(es) in ${counts.length} file(s):\n` +
                  counts.map(([r, n]) => `${r}: ${n}`).join("\n") +
                  trailer(scan.truncated, counts.length >= head),
              );
            }

            // content mode
            const out: string[] = [];
            let shown = 0;
            let limited = false;
            const oRe = onlyMatching ? new RegExp(pattern, `g${insensitive ? "i" : ""}`) : null;
            for (const f of scan.files) {
              if (limited) break;
              const content = await readText(ctx, f.rel);
              if (content === undefined) continue;
              const lines = splitLines(content);
              const matched = new Set<number>();
              for (let i = 0; i < lines.length; i++) {
                if (lineRe.test(lines[i]!)) matched.add(i);
              }
              if (matched.size === 0) continue;
              if (oRe) {
                // -o: emit only the matched substrings, one per match (no context).
                for (const i of [...matched].sort((a, b) => a - b)) {
                  if (limited) break;
                  oRe.lastIndex = 0;
                  let m: RegExpExecArray | null;
                  while ((m = oRe.exec(lines[i]!)) !== null) {
                    out.push(`${f.rel}${showLineNo ? `:${i + 1}` : ""}:${truncate(m[0], MAX_LINE)}`);
                    if (m.index === oRe.lastIndex) oRe.lastIndex++; // zero-width match guard
                    if (++shown >= head) { limited = true; break; }
                  }
                }
                continue;
              }
              for (const [s, e] of mergeRanges([...matched], before, after, lines.length)) {
                if (out.length > 0) out.push("--");
                for (let i = s; i <= e && !limited; i++) {
                  const hit = matched.has(i);
                  const sep = hit ? ":" : "-";
                  const loc = showLineNo ? `${sep}${i + 1}` : "";
                  out.push(`${f.rel}${loc}${sep}${truncate(lines[i]!, MAX_LINE)}`);
                  if (hit && ++shown >= head) limited = true;
                }
              }
            }
            if (shown === 0) return ok(noMatchMessage(args));
            return ok(`${shown}${limited ? "+" : ""} match(es):\n${out.join("\n")}` + trailer(scan.truncated, limited));
          } catch (err) {
            return fail(`code_search failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

async function readText(ctx: CoreContext, rel: string): Promise<string | undefined> {
  try {
    const { content } = await ctx.fs.read(rel);
    return content.includes(String.fromCharCode(0)) ? undefined : content; // skip binary
  } catch {
    return undefined; // unreadable / too large
  }
}

function numOr(v: unknown, fallback: number): number {
  return v === undefined ? fallback : Number(v);
}

function countAll(re: RegExp, s: string): number {
  re.lastIndex = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    n++;
    if (n >= 1_000_000) break; // runaway guard
    if (m.index === re.lastIndex) {
      // Zero-width match (e.g. /\w*/): force progress so we cannot loop forever.
      re.lastIndex++;
      if (re.lastIndex > s.length) break;
    }
  }
  return n;
}

/** Merge sorted line indices (± context) into inclusive [start,end] ranges. */
function mergeRanges(idx: number[], before: number, after: number, total: number): Array<[number, number]> {
  const sorted = [...idx].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const i of sorted) {
    const s = Math.max(0, i - before);
    const e = Math.min(total - 1, i + after);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  }
  return ranges;
}

function trailer(scanTruncated: boolean, capped: boolean): string {
  const notes: string[] = [];
  if (capped) notes.push("results capped (raise headLimit or narrow the search)");
  if (scanTruncated) notes.push("file scan truncated (narrow with path/glob/type)");
  return notes.length ? `\n[${notes.join("; ")}]` : "";
}

function noMatchMessage(args: Record<string, unknown>): string {
  const scope = args.glob ?? args.type ?? args.path ?? "workspace";
  return `No matches for /${String(args.pattern)}/ in ${String(scope)}.`;
}
