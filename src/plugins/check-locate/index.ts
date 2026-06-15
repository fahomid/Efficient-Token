import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { locateInText } from "../../core/locate.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { boundedTail, runNpmScript } from "../../core/run-script.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const SAFE_SCRIPT = /^[A-Za-z0-9:._-]+$/;
const DEFAULT_LOCATIONS = 5;

/**
 * Run a package.json script (like `code_check`) and, on failure, parse
 * `file:line` references out of the output and show the failing source with its
 * enclosing symbol, plus a bounded output tail. This turns "the check failed"
 * into "here's the code that failed" in one call.
 */
export function checkLocatePlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "check-locate",
    version: "1.0.1",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "check_locate",
        title: "Run a check and locate failures",
        description:
          "Run a package.json script (test/build/lint/typecheck) and, on failure, show the failing source: it parses file:line out of the output and returns each error site with a few lines of context and its enclosing symbol, plus a bounded output tail. Use this to go from a failing check to the offending code in one call. Only package.json scripts can be run.",
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

            const locations = await locateInText(ctx, run.output, { max: maxLocations, context });
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
