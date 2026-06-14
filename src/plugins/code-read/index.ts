import { z } from "zod";

import type { CoreContext, Plugin, ToolResult } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { numberLines, splitLines, truncate } from "../../core/text.js";

/** `code_read` — read source faithfully but minimally. Free tier. */
export function codeReadPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "code-read",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "code_read",
        title: "Read code",
        description:
          "Read source faithfully but minimally: a single named symbol (symbol), a line range (startLine/endLine), or a whole file that degrades to an outline + head when it exceeds the token budget. Prefer symbol/range over whole-file. Output is line-numbered real source — never summarized.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          path: z.string().describe("File path relative to the workspace root."),
          symbol: z
            .string()
            .optional()
            .describe("Extract a single symbol (function/class/method/type) by name."),
          startLine: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("1-based start line for a range read."),
          endLine: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("1-based end line for a range read."),
          maxTokens: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Override the whole-file token budget before it degrades."),
        },
        handler: async (args) => {
          try {
            const p = String(args.path);
            const symbol =
              args.symbol === undefined ? undefined : String(args.symbol);
            const startLine =
              args.startLine === undefined ? undefined : Number(args.startLine);
            const endLine =
              args.endLine === undefined ? undefined : Number(args.endLine);
            const maxTokens =
              args.maxTokens === undefined
                ? ctx.config.maxReadTokens
                : Number(args.maxTokens);

            const { content, abs } = await ctx.fs.read(p);
            const rel = ctx.paths.relative(abs);
            const lines = splitLines(content);

            if (symbol !== undefined) {
              return await readSymbol(ctx, p, content, lines, rel, symbol);
            }
            if (startLine !== undefined || endLine !== undefined) {
              return readRange(lines, rel, startLine, endLine);
            }
            return await readWhole(ctx, p, content, lines, rel, maxTokens);
          } catch (err) {
            return fail(`code_read failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

async function readSymbol(
  ctx: CoreContext,
  filePath: string,
  content: string,
  lines: string[],
  rel: string,
  symbol: string,
): Promise<ToolResult> {
  const matches = await ctx.ast.findSymbol(filePath, content, symbol);
  if (matches === undefined) {
    return fail(
      `${rel} — no grammar for this file type; use a line range (startLine/endLine) instead.`,
    );
  }
  const target = matches[0];
  if (target === undefined) {
    // Reuses the parse from findSymbol above (AstService memoizes the outline).
    const all = await ctx.ast.outline(filePath, content);
    const names = (all ?? []).map((s) => s.name);
    const list = names.length
      ? `Defined symbols: ${names.join(", ")}`
      : "No symbols found in this file.";
    return fail(`${rel} — symbol "${symbol}" not found. ${list}`);
  }
  // Clamp to real file bounds so the header never claims lines that don't exist.
  const total = lines.length;
  const start = clamp(target.startLine, 1, total);
  const end = clamp(target.endLine, start, total);
  const slice = lines.slice(start - 1, end);
  const header = `${rel} — ${target.kind} ${target.name} (lines ${start}-${end} of ${total})`;
  const extra =
    matches.length > 1
      ? `\n(note: ${matches.length} symbols named "${symbol}"; showing the first)`
      : "";
  return ok(`${header}${extra}\n${numberLines(slice, start)}`);
}

function readRange(
  lines: string[],
  rel: string,
  startLine: number | undefined,
  endLine: number | undefined,
): ToolResult {
  const total = lines.length;
  const s = clamp(startLine ?? 1, 1, total);
  const e = clamp(endLine ?? total, s, total);
  const slice = lines.slice(s - 1, e);
  return ok(`${rel} — lines ${s}-${e} of ${total}\n${numberLines(slice, s)}`);
}

async function readWhole(
  ctx: CoreContext,
  filePath: string,
  content: string,
  lines: string[],
  rel: string,
  maxTokens: number,
): Promise<ToolResult> {
  if (ctx.budget.fits(content, maxTokens)) {
    return ok(`${rel} — ${lines.length} line(s)\n${numberLines(lines, 1)}`);
  }

  // Over budget: degrade to outline + a BOUNDED head, never a silent full dump.
  // Bound by line count AND per-line width AND total size, so a few very long
  // lines (minified JS/CSS, single-line JSON) cannot blow past the budget.
  const est = ctx.budget.estimate(content);
  const maxHeadChars = Math.max(2000, maxTokens * 4); // ~maxTokens tokens
  const maxLineChars = 400;
  const head: string[] = [];
  let used = 0;
  let truncatedAny = false;
  for (const line of lines) {
    if (head.length >= 40 || used >= maxHeadChars) break;
    const capped = truncate(line, maxLineChars);
    if (capped !== line) truncatedAny = true;
    head.push(capped);
    used += capped.length + 1;
  }
  const symbols = await ctx.ast.outline(filePath, content);
  const parts: string[] = [
    `${rel} — ${lines.length} line(s), ~${est} tokens exceeds budget ${maxTokens}. ` +
      `Returning an outline + the first ${head.length} line(s)` +
      `${truncatedAny ? " (long lines truncated)" : ""}.`,
    `Request a specific symbol (symbol=…) or line range (startLine/endLine) for the rest.`,
  ];
  if (symbols && symbols.length > 0) {
    parts.push("", "Outline:");
    for (const s of symbols) {
      const container = s.container ? `${s.container}.` : "";
      parts.push(`  L${s.startLine}-${s.endLine}  ${s.kind} ${container}${s.name}`);
    }
  }
  parts.push("", "First lines:", numberLines(head, 1));
  return ok(parts.join("\n"));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}
