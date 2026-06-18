import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { boundedTail, runNpmScript } from "../../core/run-script.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const SAFE_SCRIPT = /^[A-Za-z0-9:._-]+$/;

/**
 * Run one of the project's own npm scripts (build/test/lint/typecheck) and
 * return a tiny pass line on success, or bounded output on failure, instead of
 * the model running a command and reading the whole log.
 *
 * Allowlisted by construction: only scripts defined in the workspace
 * `package.json`, selected by name and validated, are run. Arbitrary commands
 * are never executed. Mutating, since it runs a process.
 */
export function codeCheckPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "code-check",
    version: "1.0.3",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "code_check",
        title: "Run a check",
        description:
          "Run one of the project's package.json scripts (e.g. test, build, lint, typecheck) and return only the result: a one-line pass on success, or bounded failure output (exit code plus tail) on failure. Use this to run checks without pulling the entire log into context. Only scripts defined in package.json can be run, never arbitrary commands.",
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          script: z.string().min(1).describe("Name of the package.json script to run (e.g. \"test\")."),
          maxTokens: z.number().int().positive().optional().describe("Bound the failure output (default: server read budget)."),
          timeoutMs: z.number().int().positive().optional().describe(`Kill the check after this long (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
        },
        handler: async (args) => {
          try {
            const script = String(args.script);
            if (!SAFE_SCRIPT.test(script)) {
              return fail(`invalid script name: ${JSON.stringify(script)} (allowed: letters, digits, : . _ -).`);
            }
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const timeoutMs = Math.min(
              args.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(args.timeoutMs),
              MAX_TIMEOUT_MS,
            );

            const scripts = await readScripts(ctx);
            if (scripts === undefined) {
              return fail("no package.json with a \"scripts\" section at the workspace root.");
            }
            if (!Object.prototype.hasOwnProperty.call(scripts, script)) {
              const names = Object.keys(scripts);
              return fail(
                `no npm script "${script}". Available: ${names.length ? names.join(", ") : "(none)"}.`,
              );
            }

            const started = Date.now();
            const run = await runNpmScript(ctx.config.root, script, timeoutMs);
            const secs = ((Date.now() - started) / 1000).toFixed(1);

            if (run.notFound) return fail("npm was not found on PATH.");
            if (run.timedOut) {
              return fail(`${script}: timed out after ${timeoutMs}ms (process tree killed).`);
            }
            const code = run.code;
            const combined = run.output;
            if (code === 0) {
              return ok(`✓ ${script}: passed (exit 0, ${secs}s)`);
            }
            return ok(
              `✗ ${script}: FAILED (exit ${code}, ${secs}s)\n\n${boundedTail(combined, maxTokens)}`,
            );
          } catch (err) {
            return fail(`code_check failed: ${errMessage(err)}`);
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
    if (pkg.scripts && typeof pkg.scripts === "object") {
      return pkg.scripts as Record<string, string>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

