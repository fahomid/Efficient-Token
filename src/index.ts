#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./core/config.js";
import type { CoreContext, Plugin } from "./core/contract.js";
import { loadPlugins } from "./core/loader.js";

import { AstService } from "./services/ast.js";
import { TokenBudgeter } from "./services/budget.js";
import { SafeFs } from "./services/fs.js";
import { createEntitlement } from "./services/license.js";
import { createLogger } from "./services/logger.js";
import { PathSandbox } from "./services/paths.js";
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
import { viewImagePlugin } from "./plugins/view-image/index.js";
import { traceLocatePlugin } from "./plugins/trace-locate/index.js";
import { typeClosurePlugin } from "./plugins/type-closure/index.js";

const VERSION = "0.1.0";

/**
 * The only place features are wired together. Premium plugins can be listed
 * here unconditionally — the loader skips them until the entitlement allows it.
 */
const plugins: Plugin[] = [
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
    log,
  };

  // Initialise the WASM runtime up front so the first tool call isn't slow.
  await ctx.ast.init();

  const server = new McpServer({ name: "efficient-token", version: VERSION });
  const result = await loadPlugins(server, ctx, plugins);

  log.info(`workspace root: ${config.root}`);
  log.info(`tier: ${ctx.license.tier}; tools: ${result.registeredTools.join(", ")}`);
  if (result.skipped.length > 0) {
    log.info(`skipped (not entitled): ${result.skipped.join(", ")}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("connected on stdio");
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[efficient-token] FATAL ${detail}\n`);
  process.exit(1);
});
