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
          "Report efficient-token status: tier, workspace root, limits, and the estimated tokens saved this session by distilled reads. Use to confirm the server is connected and pointed at the right project.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {},
        handler: async () => {
          try {
            const s = ctx.savings.report();
            const byKind = Object.entries(s.byKind).map(([k, v]) => `${k} ${v.savedTokens}t/${v.calls}`).join(", ");
            const lines = [
              "efficient-token: ok",
              `tier: ${ctx.license.tier}`,
              `root: ${ctx.config.root}`,
              `maxReadTokens: ${ctx.config.maxReadTokens}`,
              `maxFileBytes: ${ctx.config.maxFileBytes}`,
              `savings (this session, estimate): ~${s.savedTokens} tokens over ${s.calls} distilled read(s) ` +
                `(returned ~${s.returnedTokens} vs ~${s.baselineTokens} whole-file)${byKind ? ` [${byKind}]` : ""}`,
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
