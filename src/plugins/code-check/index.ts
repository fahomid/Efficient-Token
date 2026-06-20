import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { DEFAULT_CHECK_TIMEOUT_MS, MAX_CHECK_TIMEOUT_MS, runProjectScript } from "../../core/scripts.js";

const DEFAULT_TIMEOUT_MS = DEFAULT_CHECK_TIMEOUT_MS;
const MAX_TIMEOUT_MS = MAX_CHECK_TIMEOUT_MS;

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
    version: "1.0.5",
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
            const outcome = await runProjectScript(ctx, String(args.script), {
              maxTokens: args.maxTokens === undefined ? undefined : Number(args.maxTokens),
              timeoutMs: args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
            });
            return outcome.kind === "error" ? fail(outcome.text) : ok(outcome.text);
          } catch (err) {
            return fail(`code_check failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

