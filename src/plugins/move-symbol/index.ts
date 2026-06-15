import { promises as fsp } from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { CoreContext, Plugin } from "../../core/contract.js";
import { errMessage, fail, ok } from "../../core/result.js";
import { formatSyntaxIssues, type SymbolInfo } from "../../services/ast.js";
import { identifierBoundary } from "../../services/scan.js";

const JS_EXTS = ["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx"];
const MAX_SCAN_FILES = 10_000;
const ciFs = process.platform === "win32" || process.platform === "darwin";
// import|export [type] { names } from "spec"  — `[^}]*` spans multi-line braces.
const NAMED_FROM_RE = /(import|export)(\s+type)?\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g;

interface PlanFile {
  rel: string;
  original: string | null; // null = file to be created
  next: string;
}

/**
 * `move_symbol` — relocate a definition from one file to another atomically, and
 * rewrite the NAMED imports/re-exports of it across the workspace to point at the
 * new file (adding an import back into the source file if it still uses the
 * symbol). dryRun-able, syntax-guarded, all-or-nothing. Default/namespace
 * importers and the moved code's own dependencies are FLAGGED, not guessed.
 * Mutating. Free tier (JS/TS).
 */
export function moveSymbolPlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "move-symbol",
    version: "0.1.0",
    tier: "free",
    init(c) {
      ctx = c;
    },
    tools: [
      {
        name: "move_symbol",
        title: "Move a symbol",
        description:
          "Move a definition (function/class/type/const) between files in ONE atomic call, rewriting the NAMED imports/re-exports of it across the workspace (and importing it back into the source if still used). dryRun previews; all-or-nothing, syntax-guarded. Default/namespace imports and the moved code's own deps are reported, not guessed. JS/TS.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        inputSchema: {
          symbol: z.string().min(1).describe("Name of the symbol to move."),
          from: z.string().describe("Source file (relative)."),
          to: z.string().describe("Destination file (relative); created if missing."),
          container: z.string().optional().describe("Enclosing name to disambiguate same-named symbols."),
          dryRun: z.boolean().optional().describe("Preview the plan without writing anything."),
          validate: z.boolean().optional().describe("Reject if any file would gain a syntax error (default true)."),
        },
        handler: async (args) => {
          try {
            const symbol = String(args.symbol);
            const fromAbs = ctx.paths.resolve(String(args.from));
            const toAbs = ctx.paths.resolve(String(args.to));
            const fromRel = ctx.paths.relative(fromAbs);
            const toRel = ctx.paths.relative(toAbs);
            if (sameFile(fromAbs, toAbs)) return fail("`from` and `to` are the same file.");
            const container = args.container === undefined ? undefined : String(args.container);

            // 1) Locate + extract the definition from the source file.
            const { content: fromRaw } = await ctx.fs.readRaw(String(args.from));
            const fromBom = fromRaw.charCodeAt(0) === 0xfeff;
            const fromCode = fromBom ? fromRaw.slice(1) : fromRaw;
            const matches = await ctx.ast.findSymbol(String(args.from), fromCode, symbol);
            if (matches === undefined) return fail(`${fromRel} — no grammar for this file type.`);
            let cands = matches;
            if (container !== undefined) cands = cands.filter((s) => (s.container ?? "") === container);
            if (cands.length === 0) return fail(`${fromRel} — symbol "${symbol}"${container ? ` in ${container}` : ""} not found.`);
            if (cands.length > 1) {
              return fail(`${fromRel} — "${symbol}" is ambiguous (${cands.length}); pass container=. Candidates:\n${cands.map((s) => `  ${s.kind} ${s.container ? `${s.container}.` : ""}${s.name}`).join("\n")}`);
            }
            const target = cands[0] as SymbolInfo;
            const defSource = fromCode.slice(target.startIndex, target.endIndex);

            // 2) Source file with the definition removed (seam collapsed).
            const left = fromCode.slice(0, target.startIndex);
            let right = fromCode.slice(target.endIndex);
            if (left.endsWith("\n") && right.startsWith("\n")) right = right.replace(/^\n+/, "\n");
            let newFrom = left + right;

            // 3) Destination file with the definition appended (created if missing).
            let toRaw: string | null = null;
            try {
              toRaw = (await ctx.fs.readRaw(String(args.to))).content;
            } catch {
              toRaw = null;
            }
            const toBom = toRaw !== null && toRaw.charCodeAt(0) === 0xfeff;
            const toCode = toRaw === null ? null : toBom ? toRaw.slice(1) : toRaw;
            const newToBody = toCode === null || toCode.trim() === ""
              ? `${defSource}\n`
              : `${toCode.replace(/\s*$/, "")}\n\n${defSource}\n`;

            // 4) If the source still references the symbol, import it back from `to`.
            const isJs = JS_EXTS.includes(extOf(fromRel));
            let addedBackImport = false;
            if (isJs && identifierBoundary(symbol, "").test(newFrom)) {
              const spec = moduleSpecifier(fromAbs, toAbs, usesJsExt(fromCode));
              newFrom = `import { ${symbol} } from "${spec}";\n${newFrom}`;
              addedBackImport = true;
            }

            // 5) Rewrite named imports/re-exports of the symbol elsewhere: from -> to.
            const fromKey = moduleKey(fromAbs).toLowerCase();
            const rewrites: PlanFile[] = [];
            const flagged: string[] = [];
            const scan = await ctx.scan.files({ exts: JS_EXTS, maxFiles: MAX_SCAN_FILES });
            for (const f of scan.files) {
              if (sameFile(f.abs, fromAbs) || sameFile(f.abs, toAbs)) continue;
              let raw: string;
              try {
                raw = (await ctx.fs.readRaw(f.rel)).content;
              } catch {
                continue;
              }
              if (raw.includes(String.fromCharCode(0))) continue; // skip binary
              const bom = raw.charCodeAt(0) === 0xfeff;
              const content = bom ? raw.slice(1) : raw;
              if (!content.includes(symbol)) continue;
              const res = rewriteImports(content, symbol, f.abs, fromKey, toAbs);
              if (res.changed) {
                const lead = bom ? String.fromCharCode(0xfeff) : "";
                rewrites.push({ rel: f.rel, original: lead + content, next: lead + res.content });
              }
              if (res.flaggedNonNamed) flagged.push(f.rel);
            }

            // 6) Assemble the plan.
            const plan: PlanFile[] = [
              { rel: fromRel, original: fromRaw, next: (fromBom ? "" + String.fromCharCode(0xfeff) + "" : "") + newFrom },
              { rel: toRel, original: toRaw, next: (toBom ? "" + String.fromCharCode(0xfeff) + "" : "") + newToBody },
              ...rewrites.map((r) => ({ ...r })),
            ];

            // 7) Syntax-guard every touched (JS/TS) file.
            if (args.validate !== false) {
              for (const pf of plan) {
                const issues = await ctx.ast.introducedSyntaxErrors(pf.rel, pf.original ?? "", pf.next);
                if (issues.length > 0) {
                  return fail(`move_symbol aborted (nothing written): ${pf.rel} would gain ${issues.length} syntax error(s).\n${formatSyntaxIssues(issues)}\n(set validate=false to override)`);
                }
              }
            }

            const deps = movedDependencies(defSource, symbol);
            const report = buildReport(target, fromRel, toRel, plan, rewrites.length, addedBackImport, flagged, deps);

            if (args.dryRun === true) {
              return ok(`move_symbol DRY RUN — no files written.\n${report}`);
            }

            // 8) Write atomically with rollback.
            const written: PlanFile[] = [];
            try {
              for (const pf of plan) {
                if (pf.original !== null && pf.original === pf.next) continue;
                await ctx.fs.writeAtomic(pf.rel, pf.next);
                written.push(pf);
              }
            } catch (err) {
              const unrestored = await rollback(ctx, written);
              const tail = unrestored.length ? ` PARTIALLY APPLIED — could not restore: ${unrestored.join(", ")}.` : " Rolled back.";
              return fail(`move_symbol failed mid-write:${tail} (${errMessage(err)})`);
            }
            return ok(report);
          } catch (err) {
            return fail(`move_symbol failed: ${errMessage(err)}`);
          }
        },
      },
    ],
  };
}

/** Rewrite named import/re-export of `symbol` whose spec resolves to fromKey -> toAbs. */
function rewriteImports(
  content: string,
  symbol: string,
  importerAbs: string,
  fromKey: string,
  toAbs: string,
): { content: string; changed: boolean; flaggedNonNamed: boolean } {
  let changed = false;
  const out = content.replace(NAMED_FROM_RE, (full, kw: string, typeKw: string | undefined, names: string, spec: string) => {
    if (!isRelative(spec)) return full;
    if (moduleKey(path.resolve(path.dirname(importerAbs), spec)).toLowerCase() !== fromKey) return full;
    const parts = names.split(",").map((s) => s.trim()).filter(Boolean);
    const idx = parts.findIndex((p) => importedName(p) === symbol);
    if (idx === -1) return full;
    const moved = parts[idx]!;
    const remaining = parts.filter((_, i) => i !== idx);
    const newSpec = moduleSpecifier(importerAbs, toAbs, /\.[mc]?js$/.test(spec));
    const tk = typeKw ? typeKw : " ";
    const movedStmt = `${kw}${tk}{ ${moved} } from "${newSpec}";`;
    changed = true;
    return remaining.length === 0 ? movedStmt : `${kw}${tk}{ ${remaining.join(", ")} } from "${spec}";\n${movedStmt}`;
  });
  // A default/namespace import of the symbol from the source can't be auto-rewritten.
  const flaggedNonNamed = new RegExp(`import\\s+(?:${symbol}\\b|\\*\\s+as\\s+${symbol}\\b)`).test(content);
  return { content: out, changed, flaggedNonNamed };
}

function importedName(part: string): string {
  // "X" or "X as Y" -> X ; "type X" -> X
  return part.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
}

/** Identifiers the moved code references that may need importing in `to`. */
function movedDependencies(defSource: string, symbol: string): string[] {
  const ids = new Set(defSource.match(/[A-Za-z_$][\w$]*/g) ?? []);
  ids.delete(symbol);
  const KEYWORDS = new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "interface", "type", "export", "import", "new", "this", "true", "false", "null", "undefined", "void", "string", "number", "boolean", "async", "await", "extends", "implements", "public", "private", "readonly", "static", "of", "in", "typeof", "as"]);
  return [...ids].filter((id) => !KEYWORDS.has(id) && /[A-Z_]/.test(id)).slice(0, 25);
}

function buildReport(target: SymbolInfo, fromRel: string, toRel: string, plan: PlanFile[], rewriteCount: number, addedBack: boolean, flagged: string[], deps: string[]): string {
  const lines = [
    `Moved ${target.kind} ${target.name}: ${fromRel} -> ${toRel}`,
    `  files affected: ${plan.length} (source, destination${rewriteCount ? `, ${rewriteCount} importer(s)` : ""})`,
  ];
  if (addedBack) lines.push(`  + added an import of ${target.name} back into ${fromRel} (still used there)`);
  if (rewriteCount) lines.push(`  ~ rewrote named imports/re-exports in ${rewriteCount} file(s)`);
  if (flagged.length) lines.push(`  ! manual: default/namespace import of ${target.name} in: ${[...new Set(flagged)].join(", ")}`);
  if (deps.length) lines.push(`  ! verify ${toRel} imports what ${target.name} uses: ${deps.join(", ")}`);
  return lines.join("\n");
}

function moduleSpecifier(fromFileAbs: string, toFileAbs: string, withJsExt: boolean): string {
  let rel = path.relative(path.dirname(fromFileAbs), stripExt(toFileAbs)).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return withJsExt ? `${rel}.js` : rel;
}

function usesJsExt(code: string): boolean {
  return /from\s*['"]\.[^'"]*\.[mc]?js['"]/.test(code);
}

function isRelative(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/");
}

function extOf(rel: string): string {
  const dot = rel.lastIndexOf(".");
  return dot === -1 ? "" : rel.slice(dot + 1).toLowerCase();
}

function stripExt(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  const dot = norm.lastIndexOf(".");
  return dot > slash ? norm.slice(0, dot) : norm;
}

const JS_EXT_RE = /\.(?:m|c)?[jt]sx?$/i;

/**
 * Module IDENTITY key: strip ONLY a real JS/TS extension (not any trailing dot
 * segment), so `./config` and `./config.ts` unify but `./config.local` stays a
 * DISTINCT module — preventing a rewrite of an unrelated same-named import.
 */
function moduleKey(p: string): string {
  return p.replace(/\\/g, "/").replace(JS_EXT_RE, "");
}

function sameFile(a: string, b: string): boolean {
  const na = a.replace(/\\/g, "/");
  const nb = b.replace(/\\/g, "/");
  return ciFs ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

async function rollback(ctx: CoreContext, written: PlanFile[]): Promise<string[]> {
  const failed: string[] = [];
  for (const pf of written) {
    try {
      if (pf.original === null) {
        // A file THIS operation created — delete it to honor all-or-nothing.
        await fsp.rm(ctx.paths.resolve(pf.rel), { force: true });
      } else {
        await ctx.fs.writeAtomic(pf.rel, pf.original);
      }
    } catch {
      failed.push(pf.rel);
    }
  }
  return failed;
}
