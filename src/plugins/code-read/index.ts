import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { readTarget } from "../../core/read.js";

/** `code_read` — read source faithfully but minimally. Free tier. */
export function codeReadPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "code-read",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "code_read",
        title: "Read code",
        description:
          "Read source faithfully but minimally: a single named symbol (symbol), a line range (startLine/endLine), or a whole file that degrades to an outline + head when it exceeds the token budget. Prefer symbol/range over whole-file. Output is line-numbered real source — never summarized.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          path: z.string().describe("File path relative to the workspace root."),
          symbol: z.string().optional().describe("Extract a single symbol (function/class/method/type) by name."),
          startLine: z.number().int().positive().optional().describe("1-based start line for a range read."),
          endLine: z.number().int().positive().optional().describe("1-based end line for a range read."),
          maxTokens: z.number().int().positive().optional().describe("Override the whole-file token budget before it degrades."),
        },
        handler: async (args) =>
          readTarget(ctx, {
            path: String(args.path),
            symbol: args.symbol === undefined ? undefined : String(args.symbol),
            startLine: args.startLine === undefined ? undefined : Number(args.startLine),
            endLine: args.endLine === undefined ? undefined : Number(args.endLine),
            maxTokens: args.maxTokens === undefined ? undefined : Number(args.maxTokens),
          }),
      },
    ],
  };
}
