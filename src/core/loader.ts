import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";

import type { CoreContext, Plugin, ToolAnnotations, ToolResult } from "./contract.js";

/** What the loader registered (for logging / health). */
export interface LoadResult {
  registeredPlugins: string[];
  registeredTools: string[];
  skipped: string[];
}

/**
 * The single place that touches the SDK registration surface and performs tier
 * gating. Plugins merely declare a `tier` and a list of tools; premium plugins
 * are skipped until the entitlement says otherwise.
 */
export async function loadPlugins(
  server: McpServer,
  ctx: CoreContext,
  plugins: Plugin[],
): Promise<LoadResult> {
  const registeredPlugins: string[] = [];
  const registeredTools: string[] = [];
  const skipped: string[] = [];

  // Warn (don't fail) when EFFICIENT_TOKEN_GROUPS names a bundle that doesn't
  // exist. A typo would otherwise just silently load fewer optional tools.
  if (ctx.config.groups !== undefined) {
    const known = new Set(plugins.map((p) => p.group ?? "core"));
    for (const g of ctx.config.groups) {
      if (!known.has(g)) ctx.log.warn(`EFFICIENT_TOKEN_GROUPS: unknown bundle "${g}" (known: ${[...known].join(", ")})`);
    }
  }

  // `registerTool` is generic over the (runtime-only) Zod raw shape, so the
  // static handler type cannot be inferred here. Cast the method once to the
  // precise signature we use; every call below is then fully type-checked.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      title?: string;
      description: string;
      inputSchema: ZodRawShape;
      annotations?: ToolAnnotations;
    },
    handler: (args: Record<string, unknown>) => Promise<ToolResult>,
  ) => void;

  for (const plugin of plugins) {
    if (!ctx.license.isEntitled(plugin.tier)) {
      skipped.push(`${plugin.name} (${plugin.tier})`);
      ctx.log.info(`skip ${plugin.name}: tier "${plugin.tier}" not entitled`);
      continue;
    }

    // Bundle gate: when groups are configured, only enabled bundles register
    // (orthogonal to tier). The "core" baseline always loads, so an additive
    // value like EFFICIENT_TOKEN_GROUPS=design (or a typo) can never silently
    // shed the core toolset; it just adds or omits optional bundles.
    const group = plugin.group ?? "core";
    if (ctx.config.groups !== undefined && group !== "core" && !ctx.config.groups.has(group)) {
      skipped.push(`${plugin.name} (group:${group})`);
      ctx.log.info(`skip ${plugin.name}: group "${group}" not enabled`);
      continue;
    }

    await plugin.init?.(ctx);

    for (const t of plugin.tools) {
      register(
        t.name,
        {
          // `title` only exists in newer SDK versions; pass it only when present.
          ...(t.title !== undefined ? { title: t.title } : {}),
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
        },
        t.handler,
      );
      registeredTools.push(t.name);
    }

    registeredPlugins.push(plugin.name);
    ctx.log.info(
      `loaded ${plugin.name}@${plugin.version} (${plugin.tools.length} tool(s))`,
    );
  }

  return { registeredPlugins, registeredTools, skipped };
}
