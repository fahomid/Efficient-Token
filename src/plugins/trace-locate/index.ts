import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { locateInText } from "../../core/locate.js";
import { errMessage, fail, ok } from "../../core/result.js";

const DEFAULT_FRAMES = 10;
const MAX_FRAMES = 50;

/**
 * `trace_locate` — paste a stack trace / error output and get the source at each
 * `file:line` frame (a few context lines + enclosing symbol), instead of opening
 * each referenced file by hand. Same locator as check_locate, but on text YOU
 * supply (a runtime error, a CI log snippet). Read-only. Free tier.
 */
export function traceLocatePlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "trace-locate",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "trace_locate",
        title: "Locate a stack trace",
        description:
          "Resolve a pasted stack trace / error output to source: parse each file:line frame and return that code with a few lines of context and its enclosing symbol — instead of opening each file yourself. Only workspace files are shown (external/node_modules frames are skipped). Use this for a runtime error or CI log you have in hand; for running a check use check_locate. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          trace: z.string().min(1).describe("The stack trace or error text to resolve."),
          maxFrames: z.number().int().positive().optional().describe(`Max frames to resolve (default ${DEFAULT_FRAMES}, max ${MAX_FRAMES}).`),
          context: z.number().int().min(0).optional().describe("Lines of context around each frame (default 3)."),
        },
        handler: async (args) => {
          try {
            const trace = String(args.trace);
            const max = Math.min(args.maxFrames === undefined ? DEFAULT_FRAMES : Number(args.maxFrames), MAX_FRAMES);
            const context = args.context === undefined ? 3 : Number(args.context);

            const blocks = await locateInText(ctx, trace, { max, context, fromEnd: false, maxScanLines: 2000 });
            if (blocks.length === 0) {
              return ok("No workspace source locations found in the trace (frames may all be external, or paths don't match the workspace).");
            }
            return ok(`trace_locate — ${blocks.length} frame(s) resolved:\n\n${blocks.join("\n\n")}`);
          } catch (err) {
            return fail(`trace_locate failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}
