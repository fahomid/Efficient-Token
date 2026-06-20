import { z } from "zod";

import type { CoreContext, Plugin, ToolResult } from "../../core/contract.js";
import { gitOk, runGit } from "../../core/git.js";
import { locateInText } from "../../core/locate.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { boundedTail, type RunResult, runNpmScriptArgs } from "../../core/run-script.js";
import { readScripts } from "../../core/scripts.js";
import { buildGenMatch, identifierBoundary } from "../../services/scan.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_TEST_FILES = 5000;
const SAFE_SCRIPT = /^[A-Za-z0-9:._-]+$/;
// Shell-safe filter: letters/digits/space and a few path/name punctuation. No
// quotes, $, backtick, %, !, or shell metacharacters can escape the quoting in
// run-script, so a filter can never run an arbitrary command.
const SAFE_FILTER = /^[A-Za-z0-9 _.,:/@'=+-]+$/;

/** Default globs identifying test files (overridable per call for changed mode). */
const DEFAULT_TEST_GLOBS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/test_*.*",
  "**/tests/**",
  "**/__tests__/**",
];

/**
 * Runs a test (or a subset) via a package.json test script. With `filter` it
 * forwards a name/path after `--`; with `changed:true` it runs only the test
 * files affected by the working-tree diff (changed tests plus tests that import a
 * changed source file). Returns a pass result or a bounded failure tail plus the
 * failing source, rather than running the whole suite and reading the full log.
 */
export function testRunPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "test-run",
    version: "1.0.5",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "test_run",
        title: "Run a test",
        description:
          "Run a focused test by forwarding a filter to a package.json test script (`npm run test -- <filter>`), or set changed:true to run only the test files affected by the working-tree diff (changed tests + tests referencing a changed source by basename) instead of the whole suite. Returns a pass result or a bounded failure tail plus the failing source (file:line + enclosing symbol). Only package.json scripts run; the filter must be plain text (no shell metacharacters, no leading '-'). The script must accept `-- <args>` (vitest/jest/mocha/pytest). Executes.",
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          script: z.string().min(1).describe('The package.json test script to run (e.g. "test").'),
          filter: z.string().optional().describe("Test name/file to focus on, forwarded after `--`. Plain text only (no shell metacharacters)."),
          changed: z.boolean().optional().describe("Run only the test files affected by the working-tree diff (changed tests + tests referencing a changed source by basename), not a filter."),
          testGlobs: z.array(z.string()).optional().describe("Override the globs that identify test files (changed mode only)."),
          maxTokens: z.number().int().positive().optional().describe("Bound the output tail (default: server read budget)."),
          timeoutMs: z.number().int().positive().optional().describe(`Kill after this long (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
        },
        handler: async (args) => {
          try {
            const script = String(args.script);
            if (!SAFE_SCRIPT.test(script)) return fail(`invalid script name: ${JSON.stringify(script)}.`);
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const timeoutMs = Math.min(args.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(args.timeoutMs), MAX_TIMEOUT_MS);

            const scripts = await readScripts(ctx);
            if (scripts === undefined) return fail('no package.json with a "scripts" section at the workspace root.');
            if (!Object.prototype.hasOwnProperty.call(scripts, script)) {
              return fail(`no npm script "${script}". Available: ${Object.keys(scripts).join(", ") || "(none)"}.`);
            }

            if (args.changed === true) {
              const testGlobs =
                Array.isArray(args.testGlobs) && args.testGlobs.length > 0 ? args.testGlobs.map(String) : DEFAULT_TEST_GLOBS;
              return await runChanged(ctx, script, testGlobs, maxTokens, timeoutMs);
            }

            const filter = args.filter === undefined ? undefined : String(args.filter);
            if (filter !== undefined && (filter.trim() === "" || filter.trim().startsWith("-") || !SAFE_FILTER.test(filter))) {
              // A leading "-" would be parsed as an option by the test runner
              // (e.g. --config/--require -> arbitrary code at load), so reject it.
              return fail(`invalid filter: ${JSON.stringify(filter)}. Use a plain test name/path (must not start with "-", no shell metacharacters).`);
            }

            const started = Date.now();
            const run = await runNpmScriptArgs(ctx.config.root, script, filter === undefined ? [] : [filter], timeoutMs);
            const secs = ((Date.now() - started) / 1000).toFixed(1);
            return await formatRun(ctx, `${script}${filter ? ` -- ${filter}` : ""}`, run, secs, maxTokens);
          } catch (err) {
            return fail(`test_run failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

/**
 * Run only the test files affected by the working-tree diff: the changed test
 * files, plus any test file that references a changed source file's basename (a
 * deterministic proxy for "imports it"). The selection — and anything that could
 * not be run — is reported, so a green pass never hides an un-run affected test.
 */
async function runChanged(
  ctx: CoreContext,
  script: string,
  testGlobs: readonly string[],
  maxTokens: number,
  timeoutMs: number,
): Promise<ToolResult> {
  const root = ctx.config.root;
  if (!(await gitOk(root, ["rev-parse", "--is-inside-work-tree"]))) {
    return fail("not a git repository (or git is unavailable) at the workspace root.");
  }
  const hasHead = await gitOk(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  let changedFiles: string[];
  if (hasHead) {
    const out = await runGit(root, ["-c", "core.quotePath=false", "diff", "--name-only", "HEAD"]);
    changedFiles = out.split("\n").map((s) => s.trim()).filter(Boolean);
  } else {
    // Fresh repo (no commits): `git diff` has no base, so use status, which lists
    // staged, unstaged, and untracked files. `-uall` lists each untracked file
    // individually rather than collapsing a directory to `?? src/`.
    const out = await runGit(root, ["-c", "core.quotePath=false", "status", "--porcelain", "-uall"]);
    changedFiles = parsePorcelain(out);
  }
  if (changedFiles.length === 0) return ok("test_run changed: no uncommitted changes; nothing to test.");

  const isTest = buildGenMatch(testGlobs);
  const affected = new Set<string>(changedFiles.filter(isTest));
  const changedSources = changedFiles.filter((f) => !isTest(f));

  // Pull in test files that reference a changed source file's basename. Reading
  // only test files; over-inclusion is safe (a few extra tests), under-inclusion
  // is the real risk, so the basename proxy errs toward including.
  let testScanTruncated = false;
  if (changedSources.length > 0) {
    const bases = [...new Set(changedSources.map(baseNoExt).filter((b) => b.length > 1))];
    if (bases.length > 0) {
      const refRes = bases.map((b) => identifierBoundary(b, ""));
      const scan = await ctx.scan.files({ maxFiles: MAX_TEST_FILES });
      testScanTruncated = scan.truncated;
      for (const f of scan.files) {
        if (affected.has(f.rel) || !isTest(f.rel)) continue;
        let content: string;
        try {
          content = (await ctx.fs.read(f.rel)).content;
        } catch {
          continue;
        }
        if (refRes.some((re) => re.test(content))) affected.add(f.rel);
      }
    }
  }

  if (affected.size === 0) {
    return ok(
      `test_run changed: ${changedFiles.length} changed file(s), but no affected test files found` +
        `${testScanTruncated ? ` (test-file scan truncated at ${MAX_TEST_FILES} files — an affected test may be unscanned)` : ""}. ` +
        `Run the full suite (omit changed) or pass an explicit filter.`,
    );
  }

  // Paths are forwarded to a shell test runner, so a path with shell-dangerous
  // characters can't be passed safely. Never drop one silently: run the rest and
  // report what was skipped, so a green pass can't hide an un-run affected test.
  const files = [...affected].filter(pathRunnable).sort();
  const dropped = [...affected].filter((p) => !pathRunnable(p)).sort();
  if (files.length === 0) {
    return ok(
      `test_run changed: ${affected.size} affected test file(s) all have shell-unsafe path characters and were not run: ` +
        `${dropped.join(", ")}. Run them directly.`,
    );
  }

  const started = Date.now();
  const run = await runNpmScriptArgs(root, script, files, timeoutMs);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const result = await formatRun(ctx, `${script} -- ${files.length} affected test file(s)`, run, secs, maxTokens);
  if (result.isError) return result;
  const headerLines: string[] = [];
  if (testScanTruncated) {
    headerLines.push(`! test-file scan truncated at ${MAX_TEST_FILES} files — some affected tests may be missing; narrow with path or run the full suite.`);
  }
  if (dropped.length > 0) {
    headerLines.push(`! ${dropped.length} affected test(s) NOT run (shell-unsafe path chars): ${dropped.join(", ")} — run them directly.`);
  }
  headerLines.push(`affected tests (${files.length} of changed diff):`, ...files.map((f) => `  ${f}`));
  return ok(`${headerLines.join("\n")}\n\n${result.content.map((c) => (c.type === "text" ? c.text : "")).join("")}`);
}

/** Parse `git status --porcelain` output into changed/added file paths. */
export function parsePorcelain(out: string): string[] {
  const files: string[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    let p = line.slice(3).trim();
    const arrow = p.indexOf(" -> "); // rename: "old -> new"
    if (arrow !== -1) p = p.slice(arrow + 4);
    if (p) files.push(p);
  }
  return files;
}

/**
 * A path safe to forward as a double-quoted shell argument. Blocks only the
 * characters that can break out of or expand inside double quotes on bash or cmd
 * (" $ ` \ % !); ordinary path punctuation that is glob-special but inert inside
 * quotes — spaces, parentheses, brackets, & — is allowed so real paths still run.
 */
function pathRunnable(p: string): boolean {
  return p.length > 0 && !p.startsWith("-") && !/["$`\\%!]/.test(p);
}

/** Format a finished run as a pass line or a bounded failure tail + failing source. */
async function formatRun(ctx: CoreContext, what: string, run: RunResult, secs: string, maxTokens: number): Promise<ToolResult> {
  if (run.notFound) return fail("npm was not found on PATH.");
  if (run.timedOut) return fail(`${what}: timed out (process tree killed).`);
  if (run.code === 0) return ok(`✓ ${what}: passed (exit 0, ${secs}s)`);

  const { blocks: locations, capped } = await locateInText(ctx, run.output, { max: 5, context: 3 });
  const parts = [`✗ ${what}: FAILED (exit ${run.code}, ${secs}s)`];
  if (locations.length > 0) parts.push("", `Failing source (${locations.length}${capped ? "+, more in the output below" : ""}):`, locations.join("\n\n"));
  parts.push("", "Output (tail):", boundedTail(run.output, maxTokens));
  return ok(parts.join("\n"));
}

/** Basename without any extension(s): "src/foo.config.ts" -> "foo". */
function baseNoExt(p: string): string {
  const base = p.split("/").pop() ?? p;
  const dot = base.indexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}
