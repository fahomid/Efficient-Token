import type { CoreContext } from "./contract.js";
import { enclosingSymbol } from "./diff.js";
import { splitLines, truncate } from "./text.js";

const MAX_LINE = 400;
const MAX_LINE_LEN = 2000; // skip pathologically long lines (ReDoS / minified frames)
// Path (optional drive prefix) — a colon-free run — then :line(:col)?. The body
// excludes ':' so there is no quantifier overlap: this is LINEAR (no ReDoS).
const LOCATION_RE = /((?:[A-Za-z]:)?[^\s:'"()]+):(\d+)(?::\d+)?/g;

export interface LocateOptions {
  /** Max distinct error sites to render. */
  max?: number;
  /** Context lines around each located line. */
  context?: number;
  /** Cap on lines scanned for locations. */
  maxScanLines?: number;
  /** Scan the END of the text (build logs — errors last) vs the START (stack traces). */
  fromEnd?: boolean;
}

/**
 * Parse `file:line[:col]` references out of arbitrary text (a build log, a stack
 * trace) and render each as the failing SOURCE: a few context lines (the target
 * marked `›`) plus its enclosing symbol. Sandbox-confined, dedup'd, bounded, and
 * ReDoS-safe. Shared by `check_locate` and `trace_locate`.
 */
export async function locateInText(ctx: CoreContext, text: string, opts: LocateOptions = {}): Promise<string[]> {
  const max = opts.max ?? 5;
  const context = opts.context ?? 3;
  const maxScanLines = opts.maxScanLines ?? 500;
  const fromEnd = opts.fromEnd ?? true;

  const all = text.split("\n");
  const scan = fromEnd ? all.slice(Math.max(0, all.length - maxScanLines)) : all.slice(0, maxScanLines);

  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const line of scan) {
    if (blocks.length >= max) break;
    if (line.length > MAX_LINE_LEN) continue;
    LOCATION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LOCATION_RE.exec(line)) !== null && blocks.length < max) {
      const rawPath = m[1]!;
      const lineNo = Number(m[2]);
      const base = rawPath.replace(/\\/g, "/").split("/").pop() ?? "";
      if (!base.includes(".")) continue; // require a file-ish path (has an extension)
      let rel: string;
      try {
        rel = ctx.paths.relative(ctx.paths.resolve(rawPath));
      } catch {
        continue; // escapes the workspace
      }
      const key = `${rel}:${lineNo}`;
      if (seen.has(key)) continue;
      const content = await readText(ctx, rel);
      if (content === undefined) continue;
      seen.add(key);

      const lines = splitLines(content);
      if (lineNo < 1 || lineNo > lines.length) continue;
      const sym = ctx.ast.supports(rel) ? enclosingSymbol((await ctx.ast.outline(rel, content)) ?? [], lineNo) : undefined;
      const where = sym ? `  (in ${sym.kind} ${sym.container ? `${sym.container}.` : ""}${sym.name})` : "";
      const from = Math.max(1, lineNo - context);
      const to = Math.min(lines.length, lineNo + context);
      const width = String(to).length;
      const body: string[] = [];
      for (let i = from; i <= to; i++) {
        const mark = i === lineNo ? "›" : " ";
        body.push(`${mark}${String(i).padStart(width)}| ${truncate(lines[i - 1]!, MAX_LINE)}`);
      }
      blocks.push(`${rel}:${lineNo}${where}\n${body.join("\n")}`);
    }
  }
  return blocks;
}

async function readText(ctx: CoreContext, rel: string): Promise<string | undefined> {
  try {
    const { content } = await ctx.fs.read(rel);
    return content.includes(String.fromCharCode(0)) ? undefined : content;
  } catch {
    return undefined;
  }
}
