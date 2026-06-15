/**
 * The kernel contract. Every feature is a {@link Plugin} that receives a shared
 * {@link CoreContext} and exposes {@link ToolDef}s. The kernel knows nothing
 * about any specific feature. Plugins depend only on this file plus the services
 * reachable through `CoreContext`, never on each other.
 */
import type { ZodRawShape } from "zod";

import type { Config } from "./config.js";
import type { PathSandbox } from "../services/paths.js";
import type { SafeFs } from "../services/fs.js";
import type { AstService } from "../services/ast.js";
import type { TokenBudgeter } from "../services/budget.js";
import type { Entitlement } from "../services/license.js";
import type { Logger } from "../services/logger.js";
import type { SavingsLedger } from "../services/savings.js";
import type { Scanner } from "../services/scan.js";

export type Tier = "free" | "premium";

/** A single content block a tool can return: distilled text, or a real image. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }; // data = base64

/** The uniform envelope every tool returns. */
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/** Standard MCP behavioural hints so hosts can present a tool safely. */
export interface ToolAnnotations {
  title?: string;
  /** Tool only reads; it never mutates its environment. */
  readOnlyHint?: boolean;
  /** Same args produce the same effect (no additional effect on repeat). */
  idempotentHint?: boolean;
  /** Tool interacts with an open/external world (network, etc.). */
  openWorldHint?: boolean;
  /** Tool may perform destructive updates (only meaningful if not read-only). */
  destructiveHint?: boolean;
}

/** A single MCP tool. `description` ships to the model every turn, so keep it tight. */
export interface ToolDef {
  name: string;
  title?: string;
  /** Tight; says when to prefer this tool over a built-in. Recurring token cost. */
  description: string;
  /** A Zod raw shape (e.g. `{ path: z.string() }`), not `z.object(...)`. */
  inputSchema: ZodRawShape;
  /** Behavioural hints (readOnly/idempotent/openWorld) forwarded to the host. */
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/** Capabilities shared with every plugin. Read-only from a plugin's view. */
export interface CoreContext {
  config: Config;
  paths: PathSandbox;
  fs: SafeFs;
  ast: AstService;
  scan: Scanner;
  budget: TokenBudgeter;
  license: Entitlement;
  savings: SavingsLedger;
  log: Logger;
}

/** A feature module. Declares a tier + tools; captures `ctx` in `init`. */
export interface Plugin {
  name: string;
  version: string;
  tier: Tier;
  /**
   * Bundle this plugin belongs to (default "core"). The loader registers a
   * plugin only if its group is enabled (see {@link Config.groups}), so niche
   * bundles can be shed to cut the per-turn tool-description cost.
   */
  group?: string;
  tools: ToolDef[];
  /** Capture the context here. Run before any of this plugin's tools register. */
  init?(ctx: CoreContext): void | Promise<void>;
}
