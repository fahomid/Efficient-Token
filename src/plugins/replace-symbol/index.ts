import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { numberLines, splitLines } from "../../core/text.js";
import { formatSyntaxIssues, type SymbolInfo } from "../../services/ast.js";

/**
 * Replaces a named symbol's entire definition by name, so the model never has to
 * send the old body back as a match anchor the way code_edit requires. The model
 * authors only the new source; the tool resolves where via the AST (the same
 * span code_read uses), splices on exact char offsets (line-ending and BOM
 * faithful), runs the syntax-recovery guard, and writes atomically.
 */
export function replaceSymbolPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "replace-symbol",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "replace_symbol",
        title: "Replace a symbol",
        description:
          "Replace a whole function, class, or method definition by name: pass newSource (the full new definition) instead of pasting the old body as a match anchor like code_edit needs. Refuses ambiguous names (pass container/occurrence). Same syntax guard as code_edit (validate=false to override); atomic. Use code_edit for partial edits.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          path: z.string().describe("File path relative to the workspace root."),
          symbol: z.string().min(1).describe("Name of the symbol whose definition to replace."),
          newSource: z.string().describe("The complete new definition (signature + body). May be empty to delete the symbol."),
          container: z.string().optional().describe('Enclosing class/module name, to disambiguate same-named symbols (e.g. "Greeter").'),
          occurrence: z.number().int().positive().optional().describe("1-based index when several definitions share the name."),
          validate: z.boolean().optional().describe("Reject a change that would introduce a syntax error into a clean file (default true)."),
        },
        handler: async (args) => {
          try {
            const p = String(args.path);
            const symbol = String(args.symbol);
            const newSource = String(args.newSource);
            const container = args.container === undefined ? undefined : String(args.container);
            const occurrence = args.occurrence === undefined ? undefined : Number(args.occurrence);

            const { content: raw, abs } = await ctx.fs.readRaw(p);
            const rel = ctx.paths.relative(abs);
            const hasBom = raw.charCodeAt(0) === 0xfeff;
            const code = hasBom ? raw.slice(1) : raw;

            const matches = await ctx.ast.findSymbol(p, code, symbol);
            if (matches === undefined) {
              return fail(`${rel} — no grammar for this file type; use code_edit instead.`);
            }
            if (matches.length === 0) {
              const all = await ctx.ast.outline(p, code);
              const names = (all ?? []).map((s) => s.name);
              const list = names.length ? `Defined symbols: ${names.join(", ")}` : "No symbols found in this file.";
              return fail(`${rel} — symbol "${symbol}" not found. ${list}`);
            }

            let candidates = matches;
            if (container !== undefined) {
              candidates = candidates.filter((s) => (s.container ?? "") === container);
              if (candidates.length === 0) {
                return fail(`${rel} — no symbol "${symbol}" with container "${container}". Candidates:\n${listCandidates(matches)}`);
              }
            }

            let target: SymbolInfo | undefined;
            if (occurrence !== undefined) {
              target = candidates[occurrence - 1];
              if (target === undefined) {
                return fail(`${rel} — occurrence ${occurrence} out of range (${candidates.length} match(es)). Candidates:\n${listCandidates(candidates)}`);
              }
            } else if (candidates.length === 1) {
              target = candidates[0];
            } else {
              return fail(
                `${rel} — "${symbol}" is ambiguous (${candidates.length} definitions). Pass container=… or occurrence=… :\n${listCandidates(candidates)}`,
              );
            }
            if (target === undefined) return fail(`${rel} — could not resolve symbol "${symbol}".`);

            const newCode = code.slice(0, target.startIndex) + newSource + code.slice(target.endIndex);

            if (args.validate !== false) {
              const introduced = await ctx.ast.introducedSyntaxErrors(p, code, newCode);
              if (introduced.length > 0) {
                return fail(
                  `replace_symbol refused: this change would introduce ${introduced.length} syntax error(s) in ${rel}. ` +
                    `Fix newSource and retry, or set validate=false to override.\n${formatSyntaxIssues(introduced)}`,
                );
              }
            }

            await ctx.fs.writeAtomic(p, (hasBom ? String.fromCharCode(0xfeff) : "") + newCode);

            const startLine = newlineCount(newCode.slice(0, target.startIndex)) + 1;
            const span = Math.max(0, splitLines(newSource).length);
            const preview = previewWindow(newCode, startLine, span);
            return ok(`Replaced ${target.kind} ${target.container ? `${target.container}.` : ""}${target.name} in ${rel} (now lines ${startLine}-${startLine + Math.max(0, span - 1)}).\n${preview}`);
          } catch (err) {
            return fail(`replace_symbol failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

function listCandidates(syms: readonly SymbolInfo[]): string {
  return syms
    .map((s, i) => `  #${i + 1}  line ${s.startLine}  ${s.kind} ${s.container ? `${s.container}.` : ""}${s.name}`)
    .join("\n");
}

/** Line-numbered window around the replaced region so the model can verify it. */
function previewWindow(newContent: string, startLine: number, span: number): string {
  const lines = splitLines(newContent);
  if (lines.length === 0) return "(file is now empty)";
  const from = Math.max(1, startLine - 2);
  const to = Math.min(lines.length, startLine + Math.max(1, span) + 1);
  return numberLines(lines.slice(from - 1, to), from);
}

function newlineCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}
