import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { readTarget } from "../../core/read.js";

/** Read source faithfully but minimally. */
export function codeReadPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "code-read",
    version: "1.0.5",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "code_read",
        title: "Read code",
        description:
          "Use INSTEAD of the built-in Read tool and Bash cat/head/tail/sed — returns the same file content distilled to ~10% the tokens. Like Claude's Read (same file_path/offset/limit, cat-n output) but minimal: it can also extract a single named symbol, and a whole-file read over budget returns the first page of content with how to continue (offset), like Read, instead of dumping it (use code_outline for a symbol map). Prefer symbol or offset/limit over whole-file. Output is real source, never summarized.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          file_path: z.string().describe("File path (absolute, or relative to the workspace root), like Claude's Read."),
          offset: z.number().int().positive().optional().describe("1-based line to start reading from (like Read)."),
          limit: z.number().int().positive().optional().describe("Number of lines to read from offset (like Read)."),
          symbol: z.string().optional().describe("Extract a single symbol (function/class/method/type) by name; a superset of Read."),
          maxTokens: z.number().int().positive().optional().describe("Output token budget (before a whole-file read degrades)."),
          elideIfUnchanged: z.boolean().optional().describe("If this exact target was already read unchanged this session, return a short 'unchanged' marker instead of the source (saves tokens when re-orienting in an edit loop). Read again without this flag to get the source back."),
        },
        handler: async (args) => {
          const offset = args.offset === undefined ? undefined : Number(args.offset);
          const limit = args.limit === undefined ? undefined : Number(args.limit);
          // Map Read's offset/limit onto an inclusive line range.
          const ranged = offset !== undefined || limit !== undefined;
          const startLine = ranged ? offset ?? 1 : undefined;
          const endLine = ranged && limit !== undefined ? (startLine ?? 1) + limit - 1 : undefined;
          return readTarget(ctx, {
            path: String(args.file_path),
            symbol: args.symbol === undefined ? undefined : String(args.symbol),
            startLine,
            endLine,
            maxTokens: args.maxTokens === undefined ? undefined : Number(args.maxTokens),
            elide: args.elideIfUnchanged === true,
          });
        },
      },
    ],
  };
}
