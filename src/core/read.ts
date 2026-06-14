import { errMessage, fail, ok } from "./result.js";
import { numberLines, splitLines, truncate } from "./text.js";
import type { CoreContext, ToolResult } from "./contract.js";

export interface ReadTarget {
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  maxTokens?: number;
}

/**
 * Read one target faithfully but minimally — a single symbol, a line range, or a
 * whole file that degrades to an outline + bounded head over budget. Shared by
 * `code_read` (one target) and `read_many` (a batch). Always returns a
 * ToolResult (errors are caught and returned as `fail`, scoped to the path).
 */
export async function readTarget(ctx: CoreContext, t: ReadTarget): Promise<ToolResult> {
  try {
    const { content, abs } = await ctx.fs.read(t.path);
    const rel = ctx.paths.relative(abs);
    const lines = splitLines(content);
    if (t.symbol !== undefined) return await readSymbol(ctx, t.path, content, lines, rel, t.symbol);
    if (t.startLine !== undefined || t.endLine !== undefined) {
      return readRange(lines, rel, t.startLine, t.endLine);
    }
    return await readWhole(ctx, t.path, content, lines, rel, t.maxTokens ?? ctx.config.maxReadTokens);
  } catch (err) {
    return fail(`read failed (${t.path}): ${errMessage(err)}`);
  }
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
    return fail(`${rel} — no grammar for this file type; use a line range (startLine/endLine) instead.`);
  }
  const target = matches[0];
  if (target === undefined) {
    const all = await ctx.ast.outline(filePath, content);
    const names = (all ?? []).map((s) => s.name);
    const list = names.length ? `Defined symbols: ${names.join(", ")}` : "No symbols found in this file.";
    return fail(`${rel} — symbol "${symbol}" not found. ${list}`);
  }
  const total = lines.length;
  const start = clamp(target.startLine, 1, total);
  const end = clamp(target.endLine, start, total);
  const slice = lines.slice(start - 1, end);
  const header = `${rel} — ${target.kind} ${target.name} (lines ${start}-${end} of ${total})`;
  const extra =
    matches.length > 1 ? `\n(note: ${matches.length} symbols named "${symbol}"; showing the first)` : "";
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
  const est = ctx.budget.estimate(content);
  const maxHeadChars = Math.max(2000, maxTokens * 4);
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
      `Returning an outline + the first ${head.length} line(s)${truncatedAny ? " (long lines truncated)" : ""}.`,
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
