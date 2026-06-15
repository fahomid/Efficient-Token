#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./core/config.js";
import type { CoreContext, Plugin } from "./core/contract.js";
import { loadPlugins } from "./core/loader.js";
import { loadPremiumPlugins } from "./core/premium.js";

// Public API for premium plugin authors: a premium package implements these
// against this package's contract (open-core seam).
export type { Plugin, CoreContext, ToolDef, ToolResult, ToolContent, ToolAnnotations, Tier } from "./core/contract.js";

import { AstService } from "./services/ast.js";
import { TokenBudgeter } from "./services/budget.js";
import { SafeFs } from "./services/fs.js";
import { createEntitlement } from "./services/license.js";
import { createLogger } from "./services/logger.js";
import { PathSandbox } from "./services/paths.js";
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

const VERSION = "1.0.2";

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
    log,
  };

  // Initialise the WASM runtime up front so the first tool call isn't slow.
  await ctx.ast.init();

  const server = new McpServer({ name: "efficient-token", version: VERSION });
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
}

/** True when this file is the process entry point (not imported by tooling). */
function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  const self = resolve(fileURLToPath(import.meta.url));
  const invoked = resolve(arg);
  return process.platform === "win32" ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

if (isEntryPoint()) {
  main().catch((err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[efficient-token] FATAL ${detail}\n`);
    process.exit(1);
  });
}
