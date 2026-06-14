import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";

const execFileP = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const SAFE_SCRIPT = /^[A-Za-z0-9:._-]+$/;

/**
 * `code_check` — run one of the project's OWN npm scripts (build/test/lint/
 * typecheck) and return a tiny pass line on success, or BOUNDED failure output
 * on failure — instead of the model running a command and reading the whole log.
 *
 * Allowlisted by construction: only scripts defined in the workspace
 * `package.json` (selected by name, validated) are run — never arbitrary
 * commands. Mutating (executes a process). Free tier.
 */
export function codeCheckPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "code-check",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "code_check",
        title: "Run a check",
        description:
          "Run one of the project's package.json scripts (e.g. test, build, lint, typecheck) and return only the result: a one-line PASS on success, or BOUNDED failure output (exit code + tail) on failure. Use this to run checks without pulling the entire log into context. Only scripts defined in package.json can be run (no arbitrary commands).",
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
            let code = 0;
            let combined = "";
            let timedOut = false;
            try {
              const { stdout, stderr } = await execFileP("npm", ["run", script], {
                cwd: ctx.config.root,
                timeout: timeoutMs,
                maxBuffer: 16 * 1024 * 1024,
                shell: true, // required for npm(.cmd) on Windows; script name is validated
                windowsHide: true,
                encoding: "utf8",
              });
              combined = join(stdout, stderr);
            } catch (e) {
              const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string };
              if (err.code === "ENOENT") return fail("npm was not found on PATH.");
              if (err.killed || err.signal === "SIGTERM") timedOut = true;
              combined = join(err.stdout ?? "", err.stderr ?? "");
              code = typeof err.code === "number" ? err.code : 1;
            }
            const secs = ((Date.now() - started) / 1000).toFixed(1);

            if (timedOut) {
              return fail(`${script}: timed out after ${timeoutMs}ms.`);
            }
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

function join(a: string, b: string): string {
  return b.trim() === "" ? a : a.trim() === "" ? b : `${a}\n${b}`;
}

/** Keep the LAST lines that fit in ~maxTokens (errors/summaries are at the end). */
function boundedTail(text: string, maxTokens: number): string {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed === "") return "(no output)";
  const budget = maxTokens * 4;
  if (trimmed.length <= budget) return trimmed;
  const lines = trimmed.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  kept.reverse();
  return `[showing last ${kept.length} of ${lines.length} output lines]\n${kept.join("\n")}`;
}
