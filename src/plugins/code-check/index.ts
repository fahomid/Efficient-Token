import { spawn } from "node:child_process";

import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";

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

interface RunResult {
  code: number;
  output: string;
  timedOut: boolean;
  notFound: boolean;
}

/**
 * Run `npm run <script>` and, on timeout, kill the WHOLE process tree (not just
 * the shell) so a hung script can't be orphaned: a process group + SIGKILL on
 * POSIX, `taskkill /T /F` on Windows. Output (stdout+stderr) is byte-capped.
 */
function runNpmScript(cwd: string, script: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn("npm", ["run", script], {
      cwd,
      shell: true, // needed for npm(.cmd); script name is validated upstream
      windowsHide: true,
      detached: !isWin, // own process group on POSIX, so we can kill the tree
    });

    let output = "";
    let bytes = 0;
    const cap = 16 * 1024 * 1024;
    const onData = (d: Buffer): void => {
      if (bytes >= cap) return;
      const s = d.toString("utf8");
      output += s;
      bytes += s.length;
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let timedOut = false;
    let settled = false;
    const finish = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, isWin);
    }, timeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ code: 1, output, timedOut, notFound: err.code === "ENOENT" });
    });
    child.on("close", (code) => {
      finish({ code: code ?? 1, output, timedOut, notFound: false });
    });
  });
}

function killTree(pid: number | undefined, isWin: boolean): void {
  if (pid === undefined) return;
  try {
    if (isWin) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGKILL"); // kill the whole process group
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* best-effort */
  }
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
