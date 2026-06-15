import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { splitLines } from "../../core/text.js";

const MAX_SCAN_FILES = 5000;
const DEF_RE = /(?:^|[;{,\s])--([A-Za-z0-9_-]+)\s*:/g;
const USE_RE = /var\(\s*--([A-Za-z0-9_-]+)/g;

interface Loc {
  file: string;
  line: number;
}

/**
 * `token_usage` — which CSS custom properties are DEFINED but never referenced
 * via var(), and which are USED via var() but never defined — across the
 * scanned stylesheets, instead of cross-checking by eye. Scoped to CSS custom
 * properties to stay false-positive-free. Read-only. Free tier.
 */
export function tokenUsagePlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "token-usage",
    version: "0.1.0",
    tier: "free",
    group: "design",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "token_usage",
        title: "Token usage",
        description:
          "Audit CSS custom properties across stylesheets: list ones DEFINED but never referenced via var(), and ones USED via var() but never defined — with a file:line for each — instead of cross-checking by hand. Pass paths or omit to scan .css/.scss/.less. Note: cross-file/JS/inline definitions outside the scanned files can't be seen, so treat results as scoped. Read-only.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          paths: z.array(z.string()).optional().describe("Stylesheets to scan. Omit to auto-discover .css/.scss/.less."),
          maxTokens: z.number().int().positive().optional().describe("Bound output size (default: server read budget)."),
        },
        handler: async (args) => {
          try {
            const maxTokens = args.maxTokens === undefined ? ctx.config.maxReadTokens : Number(args.maxTokens);
            const files = args.paths !== undefined
              ? (args.paths as unknown[]).map(String)
              : (await ctx.scan.files({ exts: ["css", "scss", "less"], maxFiles: MAX_SCAN_FILES })).files.map((f) => f.rel);
            if (files.length === 0) return ok("No stylesheets found (.css/.scss/.less). Pass paths to target specific files.");

            const defined = new Map<string, Loc>();
            const used = new Map<string, Loc>();
            for (const f of files) {
              let content: string;
              let rel: string;
              try {
                const r = await ctx.fs.read(f);
                content = r.content;
                rel = ctx.paths.relative(r.abs);
              } catch {
                continue;
              }
              const lines = splitLines(stripCssNoise(content));
              for (let i = 0; i < lines.length; i++) {
                collect(lines[i]!, DEF_RE, rel, i + 1, defined);
                collect(lines[i]!, USE_RE, rel, i + 1, used);
              }
            }

            const unused = [...defined.keys()].filter((n) => !used.has(n)).sort();
            const undef = [...used.keys()].filter((n) => !defined.has(n)).sort();

            const budget = maxTokens * 4;
            const out: string[] = [`token_usage — ${defined.size} defined, ${used.size} used (scanned ${files.length} file(s))`];
            let usedC = out[0]!.length;
            const section = (title: string, names: string[], where: Map<string, Loc>): void => {
              if (names.length === 0) return;
              const head = `\n${title} (${names.length}):`;
              if (usedC + head.length > budget) return;
              out.push(head);
              usedC += head.length;
              for (const n of names) {
                const loc = where.get(n)!;
                const row = `  --${n}  [${loc.file}:${loc.line}]`;
                if (usedC + row.length + 1 > budget) break;
                out.push(row);
                usedC += row.length + 1;
              }
            };
            section("defined but unused", unused, defined);
            section("used but undefined", undef, used);
            if (unused.length === 0 && undef.length === 0) out.push("  ✓ every defined custom property is referenced; no undefined references.");
            return ok(out.join("\n"));
          } catch (err) {
            return fail(`token_usage failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

/** Blank out CSS comment bodies and string-literal contents (keeping newlines so
 * line numbers stay accurate), so `--x:` inside a comment/string isn't counted. */
function stripCssNoise(s: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return s
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, blank);
}

function collect(line: string, re: RegExp, file: string, lineNo: number, into: Map<string, Loc>): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const name = m[1]!;
    if (!into.has(name)) into.set(name, { file, line: lineNo });
  }
}
