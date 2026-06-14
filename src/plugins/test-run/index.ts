import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { locateInText } from "../../core/locate.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { boundedTail, runNpmScriptArgs } from "../../core/run-script.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const SAFE_SCRIPT = /^[A-Za-z0-9:._-]+$/;
// Shell-safe filter: letters/digits/space and a few path/name punctuation. No
// quotes, $, backtick, %, !, or shell metacharacters can escape the quoting in
// run-script — so a filter can never run an arbitrary command.
const SAFE_FILTER = /^[A-Za-z0-9 _.,:/@'=+-]+$/;

/**
 * `test_run` — run ONE test (or a subset) by passing a filter through to a
 * package.json test script, returning PASS or a bounded failure tail + the
 * failing source — instead of running the whole suite and reading the full log.
 * Only package.json scripts run; the filter is charset-restricted (no arbitrary
 * commands). Executes. Free tier.
 */
export function testRunPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "test-run",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "test_run",
        title: "Run a test",
        description:
          "Run a focused test by forwarding a filter to a package.json test script (e.g. `npm run test -- <filter>`) — returns PASS, or a bounded failure tail plus the failing source (file:line + enclosing symbol). Cheaper than running the whole suite. Only package.json scripts run; filter must be plain (names/paths, no shell metacharacters). The script must accept a `-- <filter>` (e.g. vitest/jest/mocha). Executes.",
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          script: z.string().min(1).describe('The package.json test script to run (e.g. "test").'),
          filter: z.string().optional().describe("Test name/file to focus on, forwarded after `--`. Plain text only (no shell metacharacters)."),
          maxTokens: z.number().int().positive().optional().describe("Bound the output tail (default: server read budget)."),
          timeoutMs: z.number().int().positive().optional().describe(`Kill after this long (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
        },
        handler: async (args) => {
          try {
            const script = String(args.script);
            if (!SAFE_SCRIPT.test(script)) return fail(`invalid script name: ${JSON.stringify(script)}.`);
            const filter = args.filter === undefined ? undefined : String(args.filter);
            if (filter !== undefined && (filter.trim() === "" || !SAFE_FILTER.test(filter))) {
              return fail(`invalid filter: ${JSON.stringify(filter)}. Use plain test names/paths (no shell metacharacters).`);
            }
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const timeoutMs = Math.min(args.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(args.timeoutMs), MAX_TIMEOUT_MS);

            const scripts = await readScripts(ctx);
            if (scripts === undefined) return fail('no package.json with a "scripts" section at the workspace root.');
            if (!Object.prototype.hasOwnProperty.call(scripts, script)) {
              return fail(`no npm script "${script}". Available: ${Object.keys(scripts).join(", ") || "(none)"}.`);
            }

            const started = Date.now();
            const run = await runNpmScriptArgs(ctx.config.root, script, filter === undefined ? [] : [filter], timeoutMs);
            const secs = ((Date.now() - started) / 1000).toFixed(1);
            if (run.notFound) return fail("npm was not found on PATH.");
            if (run.timedOut) return fail(`${script}: timed out after ${timeoutMs}ms (process tree killed).`);

            const what = `${script}${filter ? ` -- ${filter}` : ""}`;
            if (run.code === 0) return ok(`✓ ${what}: passed (exit 0, ${secs}s)`);

            const locations = await locateInText(ctx, run.output, { max: 5, context: 3 });
            const parts = [`✗ ${what}: FAILED (exit ${run.code}, ${secs}s)`];
            if (locations.length > 0) parts.push("", `Failing source (${locations.length}):`, locations.join("\n\n"));
            parts.push("", "Output (tail):", boundedTail(run.output, maxTokens));
            return ok(parts.join("\n"));
          } catch (err) {
            return fail(`test_run failed: ${errMessage(err)}`);
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
