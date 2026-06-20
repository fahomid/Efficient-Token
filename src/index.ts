#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { runEnforceCli } from "./cli/enforce.js";
import { runStatusCli } from "./cli/status.js";
import { loadConfig } from "./core/config.js";
import type { CoreContext, Plugin } from "./core/contract.js";
import { startHeartbeat } from "./core/heartbeat.js";
import { loadPlugins } from "./core/loader.js";
import { loadPremiumPlugins } from "./core/premium.js";
import { VERSION } from "./version.js";

// Public API for premium plugin authors: a premium package implements these
// against this package's contract (open-core seam).
export type { Plugin, CoreContext, ToolDef, ToolResult, ToolContent, ToolAnnotations, Tier } from "./core/contract.js";

import { AstService } from "./services/ast.js";
import { TokenBudgeter } from "./services/budget.js";
import { SafeFs } from "./services/fs.js";
import { createEntitlement } from "./services/license.js";
import { createLogger } from "./services/logger.js";
import { PathSandbox } from "./services/paths.js";
import { ReadCache } from "./services/read-cache.js";
import { SavingsLedger } from "./services/savings.js";
import { Scanner } from "./services/scan.js";

import { codeEditPlugin } from "./plugins/code-edit/index.js";
import { codeOutlinePlugin } from "./plugins/code-outline/index.js";
import { codeContextPlugin } from "./plugins/code-context/index.js";
import { codeReadPlugin } from "./plugins/code-read/index.js";
import { codeSearchPlugin } from "./plugins/code-search/index.js";
import { applyPatchPlugin } from "./plugins/apply-patch/index.js";
import { callHierarchyPlugin } from "./plugins/call-hierarchy/index.js";
import { callSitesPlugin } from "./plugins/call-sites/index.js";
import { changeCoveragePlugin } from "./plugins/change-coverage/index.js";
import { checkLocatePlugin } from "./plugins/check-locate/index.js";
import { codeCheckPlugin } from "./plugins/code-check/index.js";
import { codeWritePlugin } from "./plugins/code-write/index.js";
import { colorContrastPlugin } from "./plugins/color-contrast/index.js";
import { commitLogPlugin } from "./plugins/commit-log/index.js";
import { designTokensPlugin } from "./plugins/design-tokens/index.js";
import { conflictDigestPlugin } from "./plugins/conflict-digest/index.js";
import { diffDigestPlugin } from "./plugins/diff-digest/index.js";
import { findReferencesPlugin } from "./plugins/find-references/index.js";
import { fontInfoPlugin } from "./plugins/font-info/index.js";
import { globPlugin } from "./plugins/glob/index.js";
import { grepContextPlugin } from "./plugins/grep-context/index.js";
import { healthPlugin } from "./plugins/health/index.js";
import { importMapPlugin } from "./plugins/import-map/index.js";
import { jsonEditPlugin } from "./plugins/json-edit/index.js";
import { jsonQueryPlugin } from "./plugins/json-query/index.js";
import { lineBlamePlugin } from "./plugins/line-blame/index.js";
import { mediaInfoPlugin } from "./plugins/media-info/index.js";
import { markerInventoryPlugin } from "./plugins/marker-inventory/index.js";
import { moveSymbolPlugin } from "./plugins/move-symbol/index.js";
import { notePlugin } from "./plugins/note/index.js";
import { outlineDiffPlugin } from "./plugins/outline-diff/index.js";
import { projectRenamePlugin } from "./plugins/project-rename/index.js";
import { readAtRevPlugin } from "./plugins/read-at-rev/index.js";
import { readManyPlugin } from "./plugins/read-many/index.js";
import { replaceSymbolPlugin } from "./plugins/replace-symbol/index.js";
import { repoMapPlugin } from "./plugins/repo-map/index.js";
import { reviewBranchPlugin } from "./plugins/review-branch/index.js";
import { symbolFindPlugin } from "./plugins/symbol-find/index.js";
import { svgDigestPlugin } from "./plugins/svg-digest/index.js";
import { symbolHistoryPlugin } from "./plugins/symbol-history/index.js";
import { testRunPlugin } from "./plugins/test-run/index.js";
import { tokenUsagePlugin } from "./plugins/token-usage/index.js";
import { viewImagePlugin } from "./plugins/view-image/index.js";
import { traceLocatePlugin } from "./plugins/trace-locate/index.js";
import { typeClosurePlugin } from "./plugins/type-closure/index.js";

/**
 * Surfaced to the model in the MCP initialize result (≤2KB). A soft, fail-open
 * preference: it can only influence, never enforce — the model still chooses.
 */
const INSTRUCTIONS = [
  "efficient-token: token-efficient drop-in replacements for the host's built-in file tools.",
  "PREFER these over Bash/Read/Grep/Glob for ALL code work:",
  "  code_read    instead of Read, and Bash cat/head/tail/sed",
  "  code_search  instead of Grep, and Bash grep/rg",
  "  glob         instead of Glob, and Bash find/ls",
  "  apply_patch  instead of Edit/Write for code (atomic, multi-file)",
  "  code_edit    instead of Edit (single exact replace)",
  "They return the same source/data, distilled to ~10% the tokens.",
  "Use the built-ins only for non-code files (PDFs, notebooks, images).",
].join("\n");

/**
 * The only place features are wired together. Premium and grouped plugins can be
 * listed here unconditionally: the loader skips them until the entitlement and
 * the enabled bundle (group) allow it. Exported so dev tooling (e.g. the
 * tool-cost reporter) can introspect the registry without starting the server.
 */
export const plugins: Plugin[] = [
  healthPlugin(),
  codeOutlinePlugin(),
  codeReadPlugin(),
  readManyPlugin(),
  readAtRevPlugin(),
  viewImagePlugin(),
  mediaInfoPlugin(),
  designTokensPlugin(),
  colorContrastPlugin(),
  svgDigestPlugin(),
  fontInfoPlugin(),
  tokenUsagePlugin(),
  globPlugin(),
  jsonQueryPlugin(),
  jsonEditPlugin(),
  codeSearchPlugin(),
  grepContextPlugin(),
  findReferencesPlugin(),
  symbolFindPlugin(),
  callSitesPlugin(),
  callHierarchyPlugin(),
  markerInventoryPlugin(),
  importMapPlugin(),
  typeClosurePlugin(),
  codeContextPlugin(),
  repoMapPlugin(),
  diffDigestPlugin(),
  reviewBranchPlugin(),
  symbolHistoryPlugin(),
  outlineDiffPlugin(),
  conflictDigestPlugin(),
  changeCoveragePlugin(),
  commitLogPlugin(),
  lineBlamePlugin(),
  codeCheckPlugin(),
  checkLocatePlugin(),
  traceLocatePlugin(),
  testRunPlugin(),
  codeEditPlugin(),
  codeWritePlugin(),
  replaceSymbolPlugin(),
  applyPatchPlugin(),
  moveSymbolPlugin(),
  projectRenamePlugin(),
  notePlugin(),
];

async function main(): Promise<void> {
  const log = createLogger();

  // Last-resort guards. Every tool handler wraps its work in try/catch and returns
  // a fail() envelope, and the SDK catches tool-call rejections, so anything that
  // reaches here is an unexpected stray — e.g. an async event from a best-effort
  // child process. Log it to stderr (never stdout) and keep serving rather than
  // crashing and disconnecting the stdio transport.
  process.on("uncaughtException", (err) => log.error("uncaughtException (server kept alive)", err));
  process.on("unhandledRejection", (reason) => log.error("unhandledRejection (server kept alive)", reason));

  const config = loadConfig();
  const paths = new PathSandbox(config.root);

  const ctx: CoreContext = {
    config,
    paths,
    fs: new SafeFs(paths, config.maxFileBytes),
    ast: new AstService(log),
    scan: new Scanner(paths),
    budget: new TokenBudgeter(),
    license: createEntitlement(),
    savings: new SavingsLedger(),
    cache: new ReadCache(),
    log,
  };

  // Initialise the WASM runtime up front so the first tool call isn't slow.
  await ctx.ast.init();

  const server = new McpServer({ name: "efficient-token", version: VERSION }, { instructions: INSTRUCTIONS });
  // Open-core: append any optionally-installed premium plugins. The loader's tier
  // gate decides whether they actually register (they stay dark until entitled).
  const premium = await loadPremiumPlugins(log);
  const result = await loadPlugins(server, ctx, [...plugins, ...premium]);

  log.info(`workspace root: ${config.root}`);
  log.info(`tier: ${ctx.license.tier}; tools: ${result.registeredTools.join(", ")}`);
  if (result.skipped.length > 0) {
    // Each entry carries its own reason suffix: "(tier)" or "(group:…)".
    log.info(`skipped: ${result.skipped.join(", ")}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("connected on stdio");

  // Opt-in enforcement heartbeat (best-effort, fail-open). It also publishes a
  // small status JSON so `efficient-token status` / a status line can show health
  // without an API call. Clean up on exit.
  const heartbeat = startHeartbeat(process.env.CLAUDE_PROJECT_DIR?.trim() || config.root, log, () => {
    const s = ctx.savings.report();
    return {
      v: VERSION,
      pid: process.pid,
      ts: Date.now(),
      tier: ctx.license.tier,
      root: config.root,
      maxReadTokens: config.maxReadTokens,
      maxFileBytes: config.maxFileBytes,
      calls: s.calls,
      returnedTokens: s.returnedTokens,
      baselineTokens: s.baselineTokens,
      savedTokens: s.savedTokens,
    };
  });
  // Flush the heartbeat right after each distilled read so the status line reflects
  // current savings between liveness ticks (coalesced; the read path is unaffected).
  ctx.savings.onRecord(heartbeat.flush);
  process.once("exit", heartbeat.stop);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      heartbeat.stop();
      process.exit(0);
    });
  }
}

/** True when this file is the process entry point (not imported by tooling). */
function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  const self = resolve(fileURLToPath(import.meta.url));
  const invoked = resolve(arg);
  return process.platform === "win32" ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

/** Top-level CLI usage (each subcommand handles its own --help). */
const USAGE = [
  "efficient-token — token-efficient MCP server for Claude Code.",
  "",
  "Usage:",
  "  efficient-token                            run the MCP server over stdio (how MCP hosts launch it)",
  "  efficient-token setup [--scope user] [--no-hook] [--no-statusline]",
  "                                             install the Bash->MCP redirect hook + health status line",
  "  efficient-token uninstall [--scope user]   remove exactly what setup added",
  "  efficient-token status [--line] [--json]   print server health (no API call)",
  "  efficient-token --version                  print the version",
  "",
  'Run "efficient-token <command> --help" for command options.',
].join("\n");

if (isEntryPoint()) {
  const sub = process.argv[2];
  if (sub === "setup" || sub === "uninstall") {
    // CLI mode: manage the opt-in enforcement hook, then exit (no server).
    runEnforceCli(sub, process.argv.slice(3)).then(
      (code) => process.exit(code),
      (err: unknown) => {
        process.stderr.write(`[efficient-token] ${sub} error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      },
    );
  } else if (sub === "status") {
    // Read-only health for a status line — no server, no API call.
    process.exit(runStatusCli(process.argv.slice(3)));
  } else if (sub === "--help" || sub === "-h" || sub === "help") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (sub === "--version" || sub === "-v") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  } else if (sub !== undefined) {
    // An unrecognized argument: don't silently boot the stdio server (which looks
    // like a hang to someone typing at a shell). MCP hosts launch with no args.
    process.stderr.write(`efficient-token: unknown command ${JSON.stringify(sub)}\n${USAGE}\n`);
    process.exit(1);
  } else {
    main().catch((err: unknown) => {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`[efficient-token] FATAL ${detail}\n`);
      process.exit(1);
    });
  }
}
