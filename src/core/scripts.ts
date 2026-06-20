import type { CoreContext } from "./contract.js";
import { boundedTail, runNpmScript } from "./run-script.js";

export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
export const MAX_CHECK_TIMEOUT_MS = 300_000;

/** Script names are run via a shell, so restrict to a safe character set. */
const SAFE_SCRIPT = /^[A-Za-z0-9:._-]+$/;

/** Outcome of an allowlisted script run. `error` = it could not run (guard fail). */
export interface CheckOutcome {
  kind: "pass" | "failed" | "error";
  text: string;
}

/** Read the workspace package.json `scripts` map (undefined if absent/invalid). */
export async function readScripts(ctx: CoreContext): Promise<Record<string, string> | undefined> {
  try {
    const { content } = await ctx.fs.read("package.json");
    const pkg = JSON.parse(content) as { scripts?: unknown };
    if (pkg.scripts && typeof pkg.scripts === "object") return pkg.scripts as Record<string, string>;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run one allowlisted package.json script and format the result: a one-line pass,
 * or the exit code plus a bounded failure tail. Shared by code_check and
 * apply_patch's optional post-edit check, so the "only package.json scripts, ever"
 * guarantee and the failures-only formatting live in one place. Guard failures
 * (bad name, missing script, npm absent, timeout) return kind "error".
 */
export async function runProjectScript(
  ctx: CoreContext,
  script: string,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<CheckOutcome> {
  if (!SAFE_SCRIPT.test(script)) {
    return { kind: "error", text: `invalid script name: ${JSON.stringify(script)} (allowed: letters, digits, : . _ -).` };
  }
  const maxTokens = opts.maxTokens ?? ctx.config.maxReadTokens;
  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS, MAX_CHECK_TIMEOUT_MS);

  const scripts = await readScripts(ctx);
  if (scripts === undefined) {
    return { kind: "error", text: 'no package.json with a "scripts" section at the workspace root.' };
  }
  if (!Object.prototype.hasOwnProperty.call(scripts, script)) {
    const names = Object.keys(scripts);
    return { kind: "error", text: `no npm script "${script}". Available: ${names.length ? names.join(", ") : "(none)"}.` };
  }

  const started = Date.now();
  const run = await runNpmScript(ctx.config.root, script, timeoutMs);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (run.notFound) return { kind: "error", text: "npm was not found on PATH." };
  if (run.timedOut) return { kind: "error", text: `${script}: timed out after ${timeoutMs}ms (process tree killed).` };
  if (run.code === 0) return { kind: "pass", text: `✓ ${script}: passed (exit 0, ${secs}s)` };
  return { kind: "failed", text: `✗ ${script}: FAILED (exit ${run.code}, ${secs}s)\n\n${boundedTail(run.output, maxTokens)}` };
}
