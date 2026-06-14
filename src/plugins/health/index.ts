import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";

/** Built-in liveness/config probe. Free tier. */
export function healthPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "health",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "health",
        title: "Server health",
        description:
          "Report efficient-token status: entitlement tier, workspace root, and limits. Use to confirm the server is connected and pointed at the right project before using other tools.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {},
        handler: async () => {
          try {
            const lines = [
              "efficient-token: ok",
              `tier: ${ctx.license.tier}`,
              `root: ${ctx.config.root}`,
              `maxReadTokens: ${ctx.config.maxReadTokens}`,
              `maxFileBytes: ${ctx.config.maxFileBytes}`,
            ];
            return ok(lines.join("\n"));
          } catch (err) {
            return fail(`health failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}
