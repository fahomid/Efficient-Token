import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { boundedTail, runNpmScript } from "../../core/run-script.js";
import { splitLines, truncate } from "../../core/text.js";
import type { SymbolInfo } from "../../services/ast.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const SAFE_SCRIPT = /^[A-Za-z0-9:._-]+$/;
const DEFAULT_LOCATIONS = 5;
const MAX_LINE = 400;
const MAX_SCAN_LINES = 500; // only the last N lines (errors are at the end)
const MAX_LINE_LEN = 2000; // skip pathologically long lines (ReDoS / minified frames)
// Path (optional drive prefix) — a colon-free run — then :line(:col)?. The body
// excludes ':' so there is no quantifier overlap: this is LINEAR (no ReDoS).
const LOCATION_RE = /((?:[A-Za-z]:)?[^\s:'"()]+):(\d+)(?::\d+)?/g;

/**
 * `check_locate` — run a package.json script (like `code_check`) and, on FAILURE,
 * parse `file:line` references out of the output and show the failing source
 * (with its enclosing symbol) plus a bounded output tail. Turns "the check
 * failed" into "here's the code that failed" in one call. Executes. Free tier.
 */
export function checkLocatePlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "check-locate",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "check_locate",
        title: "Run a check and locate failures",
        description:
          "Run a package.json script (test/build/lint/typecheck) and, on failure, show the failing SOURCE: it parses file:line out of the output and returns each error site with a few lines of context and its enclosing symbol, plus a bounded output tail. Use this to go from a failing check to the offending code in one call. Only package.json scripts can be run.",
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          script: z.string().min(1).describe("Name of the package.json script to run."),
          maxTokens: z.number().int().positive().optional().describe("Bound the output tail (default: server read budget)."),
          timeoutMs: z.number().int().positive().optional().describe(`Kill after this long (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
          maxLocations: z.number().int().positive().optional().describe(`Max error sites to show (default ${DEFAULT_LOCATIONS}).`),
          context: z.number().int().min(0).optional().describe("Lines of context around each error line (default 3)."),
        },
        handler: async (args) => {
          try {
            const script = String(args.script);
            if (!SAFE_SCRIPT.test(script)) {
              return fail(`invalid script name: ${JSON.stringify(script)}.`);
            }
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const timeoutMs = Math.min(args.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(args.timeoutMs), MAX_TIMEOUT_MS);
            const maxLocations = args.maxLocations === undefined ? DEFAULT_LOCATIONS : Number(args.maxLocations);
            const context = args.context === undefined ? 3 : Number(args.context);

            const scripts = await readScripts(ctx);
            if (scripts === undefined) return fail('no package.json with a "scripts" section at the workspace root.');
            if (!Object.prototype.hasOwnProperty.call(scripts, script)) {
              return fail(`no npm script "${script}". Available: ${Object.keys(scripts).join(", ") || "(none)"}.`);
            }

            const started = Date.now();
            const run = await runNpmScript(ctx.config.root, script, timeoutMs);
            const secs = ((Date.now() - started) / 1000).toFixed(1);
            if (run.notFound) return fail("npm was not found on PATH.");
            if (run.timedOut) return fail(`${script}: timed out after ${timeoutMs}ms (process tree killed).`);
            if (run.code === 0) return ok(`✓ ${script}: passed (exit 0, ${secs}s)`);

            const locations = await locate(ctx, run.output, maxLocations, context);
            const parts = [`✗ ${script}: FAILED (exit ${run.code}, ${secs}s)`];
            if (locations.length > 0) {
              parts.push("", `Error locations (${locations.length}):`, locations.join("\n\n"));
            }
            parts.push("", "Output (tail):", boundedTail(run.output, maxTokens));
            return ok(parts.join("\n"));
          } catch (err) {
            return fail(`check_locate failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

async function locate(ctx: CoreContext, output: string, max: number, context: number): Promise<string[]> {
  const seen = new Set<string>();
  const blocks: string[] = [];
  const allLines = output.split("\n");
  const scanLines = allLines.slice(Math.max(0, allLines.length - MAX_SCAN_LINES));
  for (const line of scanLines) {
    if (blocks.length >= max) break;
    if (line.length > MAX_LINE_LEN) continue; // bound regex work per line
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
      if (content === undefined) continue; // not a real, readable workspace file
      seen.add(key);

      const lines = splitLines(content);
      if (lineNo < 1 || lineNo > lines.length) continue;
      const sym = ctx.ast.supports(rel) ? enclosing(await ctx.ast.outline(rel, content), lineNo) : undefined;
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

function enclosing(outline: SymbolInfo[] | undefined, lineNo: number): SymbolInfo | undefined {
  if (!outline) return undefined;
  let best: SymbolInfo | undefined;
  for (const s of outline) {
    if (s.startLine <= lineNo && lineNo <= s.endLine) {
      if (!best || s.startLine > best.startLine) best = s;
    }
  }
  return best;
}

async function readScripts(ctx: CoreContext): Promise<Record<string, string> | undefined> {
  try {
    const { content } = await ctx.fs.read("package.json");
    const pkg = JSON.parse(content) as { scripts?: unknown };
    if (pkg.scripts && typeof pkg.scripts === "object") return pkg.scripts as Record<string, string>;
    return undefined;
  } catch {
    return undefined;
  }
}

async function readText(ctx: CoreContext, rel: string): Promise<string | undefined> {
  try {
    const { content } = await ctx.fs.read(rel);
    return content.includes(String.fromCharCode(0)) ? undefined : content;
  } catch {
    return undefined;
  }
}
