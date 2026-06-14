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
    return await renderRead(ctx, {
      filePath: t.path,
      content,
      displayRel: rel,
      symbol: t.symbol,
      startLine: t.startLine,
      endLine: t.endLine,
      maxTokens: t.maxTokens ?? ctx.config.maxReadTokens,
    });
  } catch (err) {
    return fail(`read failed (${t.path}): ${errMessage(err)}`);
  }
}

export interface RenderReadArgs {
  /** Real file path — used for grammar selection / AST parsing. */
  filePath: string;
  /** The source to slice (from disk, a git revision, etc.). */
  content: string;
  /** What to print in the header (e.g. `rel` or `rel @<ref>`). */
  displayRel: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  maxTokens: number;
}

/**
 * Render a symbol / range / whole-file view of ALREADY-LOADED content (not from
 * disk). Shared by `code_read`/`read_many` (disk) and `read_at_rev` (git). The
 * grammar is chosen from `filePath`; the content parsed/sliced is whatever the
 * caller provides.
 */
export async function renderRead(ctx: CoreContext, a: RenderReadArgs): Promise<ToolResult> {
  const lines = splitLines(a.content);
  if (a.symbol !== undefined) return await readSymbol(ctx, a.filePath, a.content, lines, a.displayRel, a.symbol, a.maxTokens);
  if (a.startLine !== undefined || a.endLine !== undefined) {
    return readRange(lines, a.displayRel, a.startLine, a.endLine, a.maxTokens);
  }
  return await readWhole(ctx, a.filePath, a.content, lines, a.displayRel, a.maxTokens);
}

async function readSymbol(
  ctx: CoreContext,
  filePath: string,
  content: string,
  lines: string[],
  rel: string,
  symbol: string,
  maxTokens: number,
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
  const b = boundLines(slice, start, maxTokens);
  const shownEnd = b.shown > 0 ? start + b.shown - 1 : end;
  const header = `${rel} — ${target.kind} ${target.name} (lines ${start}-${shownEnd} of ${total})`;
  const omitNote = b.omitted > 0 ? `\n(truncated; ${b.omitted} more line(s) of this symbol — raise maxTokens)` : "";
  const extra =
    matches.length > 1 ? `\n(note: ${matches.length} symbols named "${symbol}"; showing the first)` : "";
  return ok(`${header}${extra}${omitNote}\n${b.numbered}`);
}

function readRange(
  lines: string[],
  rel: string,
  startLine: number | undefined,
  endLine: number | undefined,
  maxTokens: number,
): ToolResult {
  const total = lines.length;
  const s = clamp(startLine ?? 1, 1, total);
  const e = clamp(endLine ?? total, s, total);
  const slice = lines.slice(s - 1, e);
  const b = boundLines(slice, s, maxTokens);
  const shownEnd = b.shown > 0 ? s + b.shown - 1 : e;
  const omitNote = b.omitted > 0 ? ` (truncated; ${b.omitted} more line(s) — narrow the range or raise maxTokens)` : "";
  return ok(`${rel} — lines ${s}-${shownEnd} of ${total}${omitNote}\n${b.numbered}`);
}

/**
 * Number a slice but stop once the token budget is reached — so an explicit
 * range or a huge symbol degrades to its head + an "omitted" note rather than
 * dumping a whole file. Lines are kept verbatim (faithful); only the COUNT is
 * bounded. The first line is always emitted so the result is never empty.
 */
function boundLines(
  slice: string[],
  startLineNo: number,
  maxTokens: number,
): { numbered: string; shown: number; omitted: number } {
  const budgetChars = Math.max(2000, maxTokens * 4);
  const out: string[] = [];
  let used = 0;
  for (const ln of slice) {
    if (out.length > 0 && used + ln.length + 1 > budgetChars) break;
    out.push(ln);
    used += ln.length + 1;
    if (used >= budgetChars) break;
  }
  return { numbered: numberLines(out, startLineNo), shown: out.length, omitted: slice.length - out.length };
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
