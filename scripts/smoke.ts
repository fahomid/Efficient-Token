/**
 * Self-test for efficient-token. Exercises every core service and the three
 * free-tier plugins against a throwaway workspace, without starting the MCP
 * transport. Prints `ALL PASS` and exits 0 on success; exits 1 otherwise.
 *
 * Run: `npm run smoke`  (tsx scripts/smoke.ts)
 */
import { execFile, spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

import { LANG_CASES } from "./langcases.js";

import { deepMergeSetup, isManagedEntry, isManagedStatusLine, matchDrainer, removeManaged, removeManagedStatusLine, runSetup, runUninstall, setManagedStatusLine, unknownArgs } from "../src/cli/enforce.js";
import { formatDetailed, formatStatus, readStatus } from "../src/cli/status.js";
import { loadConfig } from "../src/core/config.js";
import { VERSION } from "../src/version.js";
import { boundedTail, killTree } from "../src/core/run-script.js";
import type { CoreContext, Plugin, ToolResult } from "../src/core/contract.js";
import { splitLines, truncate } from "../src/core/text.js";
import { AstService } from "../src/services/ast.js";
import { TokenBudgeter } from "../src/services/budget.js";
import { SafeFs } from "../src/services/fs.js";
import { createEntitlement } from "../src/services/license.js";
import { createLogger } from "../src/services/logger.js";
import { loadPlugins } from "../src/core/loader.js";
import { loadPremiumPlugins } from "../src/core/premium.js";
import { PathSandbox } from "../src/services/paths.js";
import { ReadCache } from "../src/services/read-cache.js";
import { SavingsLedger } from "../src/services/savings.js";
import { Scanner } from "../src/services/scan.js";
import { codeEditPlugin } from "../src/plugins/code-edit/index.js";
import { codeOutlinePlugin } from "../src/plugins/code-outline/index.js";
import { codeReadPlugin } from "../src/plugins/code-read/index.js";
import { codeSearchPlugin } from "../src/plugins/code-search/index.js";
import { codeWritePlugin } from "../src/plugins/code-write/index.js";
import { applyPatchPlugin } from "../src/plugins/apply-patch/index.js";
import { callHierarchyPlugin } from "../src/plugins/call-hierarchy/index.js";
import { callSitesPlugin } from "../src/plugins/call-sites/index.js";
import { checkLocatePlugin } from "../src/plugins/check-locate/index.js";
import { changeCoveragePlugin } from "../src/plugins/change-coverage/index.js";
import { codeCheckPlugin } from "../src/plugins/code-check/index.js";
import { codeContextPlugin } from "../src/plugins/code-context/index.js";
import { colorContrastPlugin } from "../src/plugins/color-contrast/index.js";
import { commitLogPlugin } from "../src/plugins/commit-log/index.js";
import { conflictDigestPlugin } from "../src/plugins/conflict-digest/index.js";
import { designTokensPlugin } from "../src/plugins/design-tokens/index.js";
import { diffDigestPlugin } from "../src/plugins/diff-digest/index.js";
import { findReferencesPlugin } from "../src/plugins/find-references/index.js";
import { fontInfoPlugin } from "../src/plugins/font-info/index.js";
import { globPlugin } from "../src/plugins/glob/index.js";
import { grepContextPlugin } from "../src/plugins/grep-context/index.js";
import { healthPlugin } from "../src/plugins/health/index.js";
import { importMapPlugin } from "../src/plugins/import-map/index.js";
import { jsonEditPlugin } from "../src/plugins/json-edit/index.js";
import { jsonQueryPlugin } from "../src/plugins/json-query/index.js";
import { lineBlamePlugin } from "../src/plugins/line-blame/index.js";
import { markerInventoryPlugin } from "../src/plugins/marker-inventory/index.js";
import { mediaInfoPlugin } from "../src/plugins/media-info/index.js";
import { moveSymbolPlugin } from "../src/plugins/move-symbol/index.js";
import { notePlugin } from "../src/plugins/note/index.js";
import { outlineDiffPlugin } from "../src/plugins/outline-diff/index.js";
import { projectRenamePlugin } from "../src/plugins/project-rename/index.js";
import { readAtRevPlugin } from "../src/plugins/read-at-rev/index.js";
import { readManyPlugin } from "../src/plugins/read-many/index.js";
import { replaceSymbolPlugin } from "../src/plugins/replace-symbol/index.js";
import { repoMapPlugin } from "../src/plugins/repo-map/index.js";
import { reviewBranchPlugin } from "../src/plugins/review-branch/index.js";
import { svgDigestPlugin } from "../src/plugins/svg-digest/index.js";
import { symbolFindPlugin } from "../src/plugins/symbol-find/index.js";
import { symbolHistoryPlugin } from "../src/plugins/symbol-history/index.js";
import { parsePorcelain, testRunPlugin } from "../src/plugins/test-run/index.js";
import { tokenUsagePlugin } from "../src/plugins/token-usage/index.js";
import { traceLocatePlugin } from "../src/plugins/trace-locate/index.js";
import { viewImagePlugin } from "../src/plugins/view-image/index.js";
import { typeClosurePlugin } from "../src/plugins/type-closure/index.js";

const SAMPLE_TS = `/** A greeter. */
export class Greeter {
  constructor(private readonly name: string) {}
  greet(): string {
    return "hi " + this.name;
  }
}

export function add(a: number, b: number): number {
  return a + b;
}

export const mul = (a: number, b: number): number => a * b;

export interface Point {
  x: number;
  y: number;
}
`;

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function expectThrows(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(name, false, "expected an error but none was thrown");
  } catch {
    check(name, true);
  }
}

function tool(plugin: Plugin, name: string) {
  const t = plugin.tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

function textOf(res: ToolResult): string {
  return res.content.map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`)).join("\n");
}

/**
 * Make a temp dir and return its realpath. SafeFs realpath-checks every target
 * against the workspace root, so a non-canonical temp dir (the CI Windows
 * runner's tmpdir has an 8.3 short component, e.g. RUNNER~1) would make in-root
 * files look like they escape. Every test root goes through here.
 */
async function mkTmp(prefix: string): Promise<string> {
  return fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
}

/** Run a generated hook script as a subprocess, feeding `stdin`, for fail-open tests. */
function runHook(scriptPath: string, stdin: string, env: Record<string, string>): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", () => resolve({ code: 1, stdout: out }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout: out }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** Best-effort existence check for a path outside the sandbox (test temp dirs). */
function fileThere(p: string): Promise<boolean> {
  return fsp.access(p).then(() => true).catch(() => false);
}

async function main(): Promise<void> {
  const root = await mkTmp("efficient-token-smoke-");
  try {
    const samplePath = path.join(root, "sample.ts");
    await fsp.writeFile(samplePath, SAMPLE_TS, "utf8");
    await fsp.writeFile(path.join(root, "notes.txt"), "plain text, no grammar\n", "utf8");

    // --- config ---------------------------------------------------------
    process.env.EFFICIENT_TOKEN_ROOT = root;
    process.env.EFFICIENT_TOKEN_MAX_READ_TOKENS = "6000";
    const config = loadConfig();
    check("config.root resolves to workspace", config.root === path.resolve(root));
    check("config.maxReadTokens from env", config.maxReadTokens === 6000);

    // --- core services context ------------------------------------------
    const log = createLogger();
    const paths = new PathSandbox(config.root);
    const ctx: CoreContext = {
      config,
      paths,
      fs: new SafeFs(paths, config.maxFileBytes),
      ast: new AstService(log),
      scan: new Scanner(paths),
      budget: new TokenBudgeter(),
      license: createEntitlement(),
      savings: new SavingsLedger(),
      cache: new ReadCache(),
      log,
    };
    await ctx.ast.init();

    // --- PathSandbox -----------------------------------------------------
    await expectThrows("paths.resolve rejects ../ escape", () => paths.resolve("../escape.txt"));
    await expectThrows("paths.resolve rejects empty path", () => paths.resolve(""));
    check("paths.relative is forward-slashed", paths.relative(samplePath) === "sample.ts");

    // --- SafeFs ----------------------------------------------------------
    const read = await ctx.fs.read("sample.ts");
    check("fs.read returns content", read.content === SAMPLE_TS);
    check("fs.read lineCount matches split", read.lineCount === SAMPLE_TS.split("\n").length);
    await expectThrows("fs.read rejects missing file", () => ctx.fs.read("nope.ts"));
    const tinyFs = new SafeFs(paths, 10);
    await expectThrows("fs.read rejects oversized file", () => tinyFs.read("sample.ts"));

    const writtenAbs = await ctx.fs.writeAtomic("out/written.txt", "hello atomic");
    check("fs.writeAtomic returns in-root abs path", writtenAbs.endsWith(path.join("out", "written.txt")) && paths.relative(writtenAbs) === "out/written.txt");
    const back = await ctx.fs.read("out/written.txt");
    check("fs.writeAtomic round-trips", back.content === "hello atomic");

    // writeAtomic should not follow a symlink that escapes the workspace root.
    const outsideDir = await mkTmp("efficient-token-outside-");
    try {
      let linkCreated = false;
      try {
        await fsp.symlink(outsideDir, path.join(root, "escape-link"), "dir");
        linkCreated = true;
      } catch {
        console.log("  SKIP  fs.writeAtomic blocks symlink escape (no symlink privilege)");
      }
      if (linkCreated) {
        await expectThrows("fs.writeAtomic blocks symlink escape", () =>
          ctx.fs.writeAtomic("escape-link/evil.txt", "should not land outside"),
        );
        check("fs.writeAtomic leaked nothing outside root", (await fsp.readdir(outsideDir)).length === 0);
      }
    } finally {
      await fsp.rm(outsideDir, { recursive: true, force: true });
    }

    // --- TokenBudgeter ---------------------------------------------------
    check("budget.estimate ~ len/4", ctx.budget.estimate("aaaa") === 1);
    check("budget.fits true under cap", ctx.budget.fits("aaaa", 2));
    check("budget.fits false over cap", !ctx.budget.fits("aaaaaaaa", 1));

    // --- Entitlement -----------------------------------------------------
    check("license entitles free", ctx.license.isEntitled("free"));
    check("license blocks premium", !ctx.license.isEntitled("premium"));

    // --- AstService.outline ---------------------------------------------
    const outline = await ctx.ast.outline("sample.ts", SAMPLE_TS);
    check("ast.outline returns symbols", Array.isArray(outline) && outline!.length >= 5);
    const names = new Set((outline ?? []).map((s) => s.name));
    check("ast finds class/fn/arrow/interface", ["Greeter", "add", "mul", "Point"].every((n) => names.has(n)));
    const greeter = (outline ?? []).find((s) => s.name === "Greeter");
    check("ast kind=class for Greeter", greeter?.kind === "class");
    check("ast detects doc comment", greeter?.hasDoc === true);
    const greet = (outline ?? []).find((s) => s.name === "greet");
    check("ast nests method under class", greet?.container === "Greeter");
    const mul = (outline ?? []).find((s) => s.name === "mul");
    check("ast treats arrow const as function", mul?.kind === "function");
    const noGrammar = await ctx.ast.outline("notes.txt", "plain text\n");
    check("ast.outline undefined when no grammar", noGrammar === undefined);

    // --- multi-language outline coverage (LANG_CASES) -------------------
    // Run in-process. Loading every grammar into web-tree-sitter's WASM heap can
    // exhaust V8's "Zone" memory while compiling the large grammars (swift, scala)
    // under Node 24; the `smoke` npm script passes low-memory WASM flags
    // (--liftoff-only, --wasm-num-compilation-tasks=1, --wasm-lazy-validation) so
    // it completes there too.
    for (const { ext, code, expect } of LANG_CASES) {
      const out = await ctx.ast.outline(`sample.${ext}`, code);
      const names = new Set((out ?? []).map((s) => s.name));
      if (expect) {
        const missing = expect.filter((n) => !names.has(n));
        check(`lang ${ext} outlines [${expect.join(",")}]`, Array.isArray(out) && missing.length === 0, `missing [${missing.join(",")}], got [${[...names].join(",")}]`);
      } else {
        check(`lang ${ext} parses (Tier B)`, Array.isArray(out), `got ${out === undefined ? "undefined" : "array"}`);
      }
    }

    // kind correctness: "constructor" contains "struct", so it should not mislabel.
    const javaKinds = (await ctx.ast.outline("K.java", "class K { K() {} void m() {} }")) ?? [];
    const ctor = javaKinds.find((s) => s.name === "K" && s.kind !== "class");
    check("constructor kind not mislabeled as struct", ctor?.kind === "constructor", `got ${ctor?.kind}`);

    // Grammars excluded for incompatibility/crashes are not mapped.
    for (const ext of ["elm", "ql", "yaml", "yml"]) {
      check(`lang ${ext} not mapped`, ctx.ast.grammarIdFor(`x.${ext}`) === undefined);
    }

    // Alias extensions resolve to their base grammar.
    const aliases: Record<string, string> = {
      "x.h": "c", "x.hpp": "cpp", "x.cc": "cpp", "x.cxx": "cpp", "x.hh": "cpp", "x.hxx": "cpp",
      "x.mts": "typescript", "x.cts": "typescript", "x.mjs": "javascript", "x.cjs": "javascript", "x.jsx": "javascript",
      "x.kts": "kotlin", "x.sc": "scala", "x.mli": "ocaml", "x.resi": "rescript",
      "x.bash": "bash", "x.zsh": "bash", "x.exs": "elixir", "x.htm": "html", "x.ejs": "embedded_template",
    };
    const aliasMiss = Object.entries(aliases).filter(([f, g]) => ctx.ast.grammarIdFor(f) !== g).map(([f]) => f);
    check("alias extensions map to base grammars", aliasMiss.length === 0, `wrong: [${aliasMiss.join(",")}]`);

    // --- health plugin ---------------------------------------------------
    const health = healthPlugin();
    await health.init?.(ctx);
    const hRes = await tool(health, "health").handler({});
    check("health ok + tier", !hRes.isError && textOf(hRes).includes("efficient-token: ok") && textOf(hRes).includes("tier: free"));
    check("health reports server version", textOf(hRes).includes(`version: ${VERSION}`));

    // --- code_outline plugin --------------------------------------------
    const outlinePlugin = codeOutlinePlugin();
    await outlinePlugin.init?.(ctx);
    const oRes = await tool(outlinePlugin, "code_outline").handler({ path: "sample.ts" });
    check("code_outline lists symbols", !oRes.isError && textOf(oRes).includes("symbol(s)") && textOf(oRes).includes("class Greeter"));
    await ctx.fs.writeAtomic("outline/many.ts", Array.from({ length: 60 }, (_, i) => `export function fn${i}() {\n  return ${i};\n}`).join("\n\n") + "\n");
    const oBig = textOf(await tool(outlinePlugin, "code_outline").handler({ path: "outline/many.ts", maxTokens: 1 }));
    check("code_outline bounds a huge outline and discloses the count", oBig.includes("60 symbol(s)") && oBig.includes("more — raise maxTokens"));
    const oTxt = await tool(outlinePlugin, "code_outline").handler({ path: "notes.txt" });
    check("code_outline handles no-grammar", textOf(oTxt).includes("no grammar"));

    // --- code_read plugin ------------------------------------------------
    const readPlugin = codeReadPlugin();
    await readPlugin.init?.(ctx);
    const cr = tool(readPlugin, "code_read");

    const symRes = await cr.handler({ file_path:"sample.ts", symbol: "add" });
    check("code_read symbol mode", !symRes.isError && textOf(symRes).includes("function add") && textOf(symRes).includes("return a + b;"));

    const missRes = await cr.handler({ file_path:"sample.ts", symbol: "doesNotExist" });
    check("code_read missing symbol lists names", missRes.isError === true && textOf(missRes).includes("not found") && textOf(missRes).includes("add"));

    const rangeRes = await cr.handler({ file_path: "sample.ts", offset: 1, limit: 2 });
    check("code_read range mode (offset/limit, cat-n)", !rangeRes.isError && textOf(rangeRes).includes("lines 1-2") && /(^|\n)\s*1\t/.test(textOf(rangeRes)));

    // Golden sameness: a code_read slice is the exact source bytes, not summarized.
    await ctx.fs.writeAtomic("gold/g.txt", "L1\nL2\nL3\nL4\nL5\n");
    const goldOut = textOf(await cr.handler({ file_path: "gold/g.txt", offset: 2, limit: 2 }));
    const goldSlice = goldOut.split("\n").filter((l) => l.includes("\t")).map((l) => l.slice(l.indexOf("\t") + 1));
    check("code_read is byte-faithful (slice == source lines)", goldSlice.length === 2 && goldSlice[0] === "L2" && goldSlice[1] === "L3");
    // Parity with native Read: an offset past EOF signals end-of-file with no content,
    // rather than clamping to and re-returning the last line (which breaks pagination).
    const eofRes = textOf(await cr.handler({ file_path: "gold/g.txt", offset: 100, limit: 5 }));
    check("code_read offset past EOF signals end-of-file (no clamped content)", eofRes.includes("past the end of file") && eofRes.includes("(5 line(s))") && !eofRes.includes("\tL5"));
    // Large-file paging: a whole-file read over budget returns the first page of
    // real content (like native Read) with how to continue — not an outline; a RANGE
    // read (offset/limit) always returns exactly the requested slice.
    const bigSrc = Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";
    await ctx.fs.writeAtomic("big/large.ts", bigSrc);
    const wholeBig = textOf(await cr.handler({ file_path: "big/large.ts" }));
    check("code_read over-budget whole file returns a first content page + how to continue", wholeBig.includes("exceeds budget") && wholeBig.includes("const v0 = 0;") && wholeBig.includes("continue with offset=") && !wholeBig.includes("const v2999 = 2999;") && !wholeBig.includes("Outline:"));
    const pagedBig = textOf(await cr.handler({ file_path: "big/large.ts", offset: 1500, limit: 20 }));
    check("code_read pages a large file by range (slice, not outline)", pagedBig.includes("lines 1500-1519") && pagedBig.includes("const v1499 = 1499;") && !pagedBig.includes("Outline:") && !pagedBig.includes("exceeds budget"));
    const offsetOnlyBig = textOf(await cr.handler({ file_path: "big/large.ts", offset: 2990 }));
    check("code_read pages from offset to EOF (bounded slice, not outline)", offsetOnlyBig.includes("lines 2990-") && offsetOnlyBig.includes("const v2989 = 2989;") && !offsetOnlyBig.includes("Outline:"));

    const wholeRes = await cr.handler({ file_path:"sample.ts" });
    check("code_read whole-file fits", !wholeRes.isError && textOf(wholeRes).includes("class Greeter") && textOf(wholeRes).includes("interface Point"));

    const degradeRes = await cr.handler({ file_path:"sample.ts", maxTokens: 1 });
    const dTxt = textOf(degradeRes);
    check("code_read degrades over budget to a first content page", !degradeRes.isError && dTxt.includes("exceeds budget 1") && /\n\s*1\t/.test(dTxt) && !dTxt.includes("Outline:"));

    // A wide explicit range over a large file should bound output, not dump it
    // (adversarial-review fix: readRange now honours maxTokens).
    await ctx.fs.writeAtomic("bigrange.ts", Array.from({ length: 800 }, (_, i) => `const v${i} = ${i}; // ${"y".repeat(40)}`).join("\n") + "\n");
    const wideRange = await cr.handler({ file_path: "bigrange.ts", offset: 1, limit: 800, maxTokens: 50 });
    const wrTxt = textOf(wideRange);
    check("code_read bounds a wide range", !wideRange.isError && wrTxt.includes("more line(s)") && wrTxt.length < 3500, `len=${wrTxt.length}`);

    // --- round-3 edge-case hardening ------------------------------------
    // Degrade should stay bounded even when the file is one giant line.
    const longLine = `const data = "${"x".repeat(60000)}";`;
    await ctx.fs.writeAtomic("minified.js", longLine);
    const minRes = await cr.handler({ file_path:"minified.js" });
    const minTxt = textOf(minRes);
    check("code_read bounds degrade of one long line", !minRes.isError && minTxt.length < 5000 && minTxt.includes("long lines truncated"), `len=${minTxt.length}`);

    // A trailing newline should not produce a phantom numbered line or off-by-one.
    await ctx.fs.writeAtomic("nl.txt", "l1\nl2\nl3\n");
    const nlTxt = textOf(await cr.handler({ file_path:"nl.txt" }));
    check("code_read no phantom trailing line", nlTxt.includes("3 line(s)") && !/\n\s*4\t/.test(nlTxt), nlTxt);

    // Lone-CR line endings split correctly and leave no stray CR in output.
    await ctx.fs.writeAtomic("cr.txt", "a\rb\rc");
    const crTxt = textOf(await cr.handler({ file_path:"cr.txt" }));
    check("code_read splits lone-CR with no stray CR", crTxt.includes("3 line(s)") && !crTxt.includes("\r"), JSON.stringify(crTxt));

    // splitLines / truncate helpers.
    check("splitLines strips one trailing newline", JSON.stringify(splitLines("a\nb\n")) === JSON.stringify(["a", "b"]));
    check("splitLines splits lone CR and CRLF", JSON.stringify(splitLines("a\rb\r\nc")) === JSON.stringify(["a", "b", "c"]));
    check("splitLines empty -> []", splitLines("").length === 0);
    const wellFormed = (s: string): boolean =>
      Array.from(s).every((ch) => { const cp = ch.codePointAt(0) ?? 0; return cp < 0xd800 || cp > 0xdfff; });
    const trunc = truncate("a".repeat(150) + "😀".repeat(20), 160);
    check("truncate is surrogate-safe", trunc.endsWith("…") && wellFormed(trunc));

    // Mixed declarators: a sibling binding should not leak into a symbol's signature.
    const md = (await ctx.ast.outline("md.ts", "const a = () => 1, x = 5;\n")) ?? [];
    const aSym = md.find((s) => s.name === "a");
    check("mixed declarator scopes signature", aSym !== undefined && !aSym.signature.includes("x = 5"), `sig=${aSym?.signature}`);
    check("mixed declarator excludes non-definitional sibling", md.find((s) => s.name === "x") === undefined);

    // Leading UTF-8 BOM is stripped on read.
    await ctx.fs.writeAtomic("bom.ts", "﻿export const z = 1;\n");
    const bomRead = await ctx.fs.read("bom.ts");
    check("fs.read strips leading BOM", bomRead.content.charCodeAt(0) !== 0xfeff && bomRead.content.startsWith("export"));

    // NTFS alternate data streams rejected (Windows only).
    if (process.platform === "win32") {
      await expectThrows("paths.resolve rejects NTFS ADS", () => paths.resolve("sample.ts::$DATA"));
    } else {
      check("paths.resolve ADS guard (skipped: not win32)", true);
    }

    // --- code_write plugin (Write semantics) ----------------------------
    const writePlugin = codeWritePlugin();
    await writePlugin.init?.(ctx);
    const cw = tool(writePlugin, "code_write");

    const created = await cw.handler({ file_path:"w/new.txt", content: "hello\nworld\n" });
    check("code_write creates file", !created.isError && textOf(created).includes("Created") && (await ctx.fs.read("w/new.txt")).content === "hello\nworld\n");
    const overwritten = await cw.handler({ file_path:"w/new.txt", content: "changed\n" });
    check("code_write overwrites file", !overwritten.isError && textOf(overwritten).includes("Overwrote") && (await ctx.fs.read("w/new.txt")).content === "changed\n");
    check("code_write rejects path escape", (await cw.handler({ file_path:"../escape.txt", content: "x" })).isError === true);

    // --- code_edit plugin (Edit semantics) ------------------------------
    const editPlugin = codeEditPlugin();
    await editPlugin.init?.(ctx);
    const ce = tool(editPlugin, "code_edit");

    await ctx.fs.writeAtomic("e/edit.txt", "alpha\nbeta\nalpha\n");
    const uniqueEdit = await ce.handler({ file_path:"e/edit.txt", old_string:"beta", new_string:"BETA" });
    check("code_edit replaces unique match", !uniqueEdit.isError && (await ctx.fs.read("e/edit.txt")).content === "alpha\nBETA\nalpha\n");

    const ambiguous = await ce.handler({ file_path:"e/edit.txt", old_string:"alpha", new_string:"X" });
    check("code_edit refuses ambiguous match", ambiguous.isError === true && textOf(ambiguous).includes("not unique (2 matches)"));
    check("code_edit ambiguous left file unchanged", (await ctx.fs.read("e/edit.txt")).content === "alpha\nBETA\nalpha\n");

    const all = await ce.handler({ file_path:"e/edit.txt", old_string:"alpha", new_string:"X", replace_all:true });
    check("code_edit replaceAll replaces every match", !all.isError && textOf(all).includes("2 replacement(s)") && (await ctx.fs.read("e/edit.txt")).content === "X\nBETA\nX\n");

    const notFound = await ce.handler({ file_path:"e/edit.txt", old_string:"zzz", new_string:"y" });
    check("code_edit reports missing oldString", notFound.isError === true && textOf(notFound).includes("not found"));

    // newString with `$` patterns is inserted literally (no String.replace).
    await ctx.fs.writeAtomic("e/dollar.txt", "value = HERE;\n");
    await ce.handler({ file_path:"e/dollar.txt", old_string:"HERE", new_string:"$&$1$$x" });
    check("code_edit inserts $ patterns literally", (await ctx.fs.read("e/dollar.txt")).content === "value = $&$1$$x;\n", (await ctx.fs.read("e/dollar.txt")).content);
    await ctx.fs.writeAtomic("e/dollar2.txt", "a HERE b HERE c\n");
    await ce.handler({ file_path:"e/dollar2.txt", old_string:"HERE", new_string:"$&", replace_all:true });
    check("code_edit replaceAll inserts $ literally", (await ctx.fs.read("e/dollar2.txt")).content === "a $& b $& c\n");

    const identical = await ce.handler({ file_path:"e/edit.txt", old_string:"X", new_string:"X" });
    check("code_edit rejects identical old/new", identical.isError === true && textOf(identical).includes("identical"));

    check("code_edit rejects path escape", (await ce.handler({ file_path:"../escape.txt", old_string:"a", new_string:"b" })).isError === true);

    // code_edit preserves a BOM (uses raw read, not BOM-stripped read).
    const BOM = String.fromCharCode(0xfeff);
    await ctx.fs.writeAtomic("e/bom.ts", `${BOM}const k = 1;\n`);
    await ce.handler({ file_path:"e/bom.ts", old_string:"const k = 1;", new_string:"const k = 2;" });
    check("code_edit preserves BOM via raw read", (await ctx.fs.readRaw("e/bom.ts")).content === `${BOM}const k = 2;\n`);

    // code_edit tolerates a newline-style mismatch (Claude Edit parity): a
    // multi-line LF anchor matches a CRLF-saved file, the file keeps its CRLF
    // endings, and inserted lines are written CRLF too.
    await ctx.fs.writeAtomic("e/crlf.dart", "import 'a.dart';\r\nimport 'b.dart';\r\nclass X {}\r\n");
    const crlfEdit = await ce.handler({ file_path: "e/crlf.dart", old_string: "import 'a.dart';\nimport 'b.dart';", new_string: "import 'a.dart';\nimport 'c.dart';\nimport 'b.dart';" });
    check("code_edit matches LF anchor against CRLF file (preserves+inserts CRLF)",
      !crlfEdit.isError && (await ctx.fs.readRaw("e/crlf.dart")).content === "import 'a.dart';\r\nimport 'c.dart';\r\nimport 'b.dart';\r\nclass X {}\r\n", textOf(crlfEdit));
    // Reverse: a CRLF anchor still matches an LF file, and LF is preserved.
    await ctx.fs.writeAtomic("e/lf.dart", "import 'a.dart';\nimport 'b.dart';\nclass X {}\n");
    const lfEdit = await ce.handler({ file_path: "e/lf.dart", old_string: "import 'a.dart';\r\nimport 'b.dart';", new_string: "import 'a.dart';\r\nimport 'z.dart';\r\nimport 'b.dart';" });
    check("code_edit matches CRLF anchor against LF file (preserves LF)",
      !lfEdit.isError && (await ctx.fs.readRaw("e/lf.dart")).content === "import 'a.dart';\nimport 'z.dart';\nimport 'b.dart';\nclass X {}\n", textOf(lfEdit));

    // --- syntax recovery guard (code_edit + code_write) -----------------
    const GOOD = "export function f() {\n  return 1;\n}\n";
    await ctx.fs.writeAtomic("syn/f.ts", GOOD);
    const broke = await ce.handler({ file_path:"syn/f.ts", old_string:"  return 1;\n}", new_string:"  return 1;" });
    check("code_edit refuses syntax-breaking edit", broke.isError === true && textOf(broke).includes("syntax error"));
    check("code_edit left file unchanged after refusal", (await ctx.fs.read("syn/f.ts")).content === GOOD);
    const forced = await ce.handler({ file_path:"syn/f.ts", old_string:"  return 1;\n}", new_string:"  return 1;", validate: false });
    check("code_edit validate:false overrides guard", !forced.isError && !(await ctx.fs.read("syn/f.ts")).content.includes("}"));

    await ctx.fs.writeAtomic("syn/g.ts", "export const x = 1;\n");
    const validEdit = await ce.handler({ file_path:"syn/g.ts", old_string:"= 1", new_string:"= 2" });
    check("code_edit allows syntactically-valid edit", !validEdit.isError && (await ctx.fs.read("syn/g.ts")).content.includes("= 2"));

    await ctx.fs.writeAtomic("syn/broken.ts", "export function h() {\n  return 1;\n"); // already missing }
    const fixBroken = await ce.handler({ file_path:"syn/broken.ts", old_string:"return 1;\n", new_string:"return 1;\n}\n" });
    check("code_edit allows edits to an already-broken file", !fixBroken.isError);

    await ctx.fs.writeAtomic("syn/n.txt", "hello\n");
    const txtEdit = await ce.handler({ file_path:"syn/n.txt", old_string:"hello", new_string:"((( unbalanced" });
    check("code_edit skips validation for non-grammar files", !txtEdit.isError && (await ctx.fs.read("syn/n.txt")).content.includes("((("));

    const cwBroke = await cw.handler({ file_path:"syn/w.ts", content: "export function w() {\n  return 1;\n" });
    check("code_write refuses syntactically-broken content", cwBroke.isError === true && textOf(cwBroke).includes("syntax error"));
    check("code_write did not create the broken file", !(await ctx.fs.exists("syn/w.ts")));
    const cwForced = await cw.handler({ file_path:"syn/w.ts", content: "export function w() {\n  return 1;\n", validate: false });
    check("code_write validate:false overrides", !cwForced.isError && (await ctx.fs.exists("syn/w.ts")));
    const cwOk = await cw.handler({ file_path:"syn/ok.ts", content: "export const y = 2;\n" });
    check("code_write allows valid content", !cwOk.isError && (await ctx.fs.read("syn/ok.ts")).content.includes("y = 2"));

    // Valid-but-newer TS should not be falsely blocked (grammar emits ERROR, not MISSING).
    await ctx.fs.writeAtomic("syn/modern.ts", "class C {\n  x = 1;\n}\n");
    const accessorEdit = await ce.handler({ file_path:"syn/modern.ts", old_string:"  x = 1;", new_string:"  accessor x = 1;" });
    check("code_edit allows valid `accessor` field (no false positive)", !accessorEdit.isError && (await ctx.fs.read("syn/modern.ts")).content.includes("accessor x = 1"));
    await ctx.fs.writeAtomic("syn/variance.ts", "export interface Box<T> { v: T }\n");
    const varianceEdit = await ce.handler({ file_path:"syn/variance.ts", old_string:"Box<T>", new_string:"Box<out T>" });
    check("code_edit allows valid in/out variance (no false positive)", !varianceEdit.isError && (await ctx.fs.read("syn/variance.ts")).content.includes("Box<out T>"));

    // code_write: an unreadable (oversize) existing baseline should not be faked clean.
    await ctx.fs.writeAtomic("syn/big.ts", "export function big( {\n"); // already broken
    const tinyCtx: CoreContext = { ...ctx, fs: new SafeFs(new PathSandbox(root), 5) }; // 5-byte read cap
    const tinyWrite = codeWritePlugin();
    await tinyWrite.init?.(tinyCtx);
    const oversize = await tool(tinyWrite, "code_write").handler({ path: "syn/big.ts", content: "export function big( {\n  still broken\n" });
    check("code_write skips guard when existing baseline is unreadable", !oversize.isError);

    // --- replace_symbol plugin ------------------------------------------
    const rsPlugin = replaceSymbolPlugin();
    await rsPlugin.init?.(ctx);
    const rs = tool(rsPlugin, "replace_symbol");
    const RS_SRC = "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n";
    await ctx.fs.writeAtomic("rs/m.ts", RS_SRC);
    const rsOk = await rs.handler({ path: "rs/m.ts", symbol: "add", newSource: "export function add(a: number, b: number): number {\n  return a + b + 0;\n}" });
    check("replace_symbol replaces a whole definition",
      !rsOk.isError && (await ctx.fs.read("rs/m.ts")).content === "export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n",
      (await ctx.fs.read("rs/m.ts")).content);
    const rsMiss = await rs.handler({ path: "rs/m.ts", symbol: "nope", newSource: "x" });
    check("replace_symbol reports missing symbol + lists names", rsMiss.isError === true && textOf(rsMiss).includes("not found") && textOf(rsMiss).includes("add"));
    const rsBreak = await rs.handler({ path: "rs/m.ts", symbol: "sub", newSource: "export function sub(a: number, b: number): number {\n  return a - b;" });
    check("replace_symbol refuses syntax-breaking newSource", rsBreak.isError === true && textOf(rsBreak).includes("syntax error"));
    await ctx.fs.writeAtomic("rs/amb.ts", "class A {\n  run() { return 1; }\n}\nclass B {\n  run() { return 2; }\n}\n");
    const rsAmb = await rs.handler({ path: "rs/amb.ts", symbol: "run", newSource: "run() { return 9; }" });
    check("replace_symbol refuses ambiguous name", rsAmb.isError === true && textOf(rsAmb).includes("ambiguous"));
    const rsByContainer = await rs.handler({ path: "rs/amb.ts", symbol: "run", container: "B", newSource: "run() { return 9; }" });
    const rsAmbContent = (await ctx.fs.read("rs/amb.ts")).content;
    check("replace_symbol disambiguates by container", !rsByContainer.isError && rsAmbContent.includes("return 9") && rsAmbContent.includes("return 1"));
    const BOM2 = String.fromCharCode(0xfeff);
    await ctx.fs.writeAtomic("rs/bom.ts", `${BOM2}export function z() {\n  return 1;\n}\n`);
    await rs.handler({ path: "rs/bom.ts", symbol: "z", newSource: "export function z() {\n  return 2;\n}" });
    check("replace_symbol preserves BOM", (await ctx.fs.readRaw("rs/bom.ts")).content === `${BOM2}export function z() {\n  return 2;\n}\n`, (await ctx.fs.readRaw("rs/bom.ts")).content);
    await ctx.fs.writeAtomic("rs/plain.txt", "hello\n");
    check("replace_symbol rejects non-grammar file", (await rs.handler({ path: "rs/plain.txt", symbol: "x", newSource: "y" })).isError === true);

    // --- apply_patch plugin (atomic multi-edit) -------------------------
    const apPlugin = applyPatchPlugin();
    await apPlugin.init?.(ctx);
    const ap = tool(apPlugin, "apply_patch");

    await ctx.fs.writeAtomic("ap/a.ts", "export const a = 1;\nexport const b = 2;\n");
    await ctx.fs.writeAtomic("ap/b.ts", "export const c = 3;\n");
    const ap1 = await ap.handler({ edits: [
      { file_path: "ap/a.ts", old_string:"a = 1", new_string:"a = 10" },
      { file_path: "ap/a.ts", old_string:"b = 2", new_string:"b = 20" },
      { file_path: "ap/b.ts", old_string:"c = 3", new_string:"c = 30" },
    ] });
    check("apply_patch applies across files", !ap1.isError && (await ctx.fs.read("ap/a.ts")).content === "export const a = 10;\nexport const b = 20;\n" && (await ctx.fs.read("ap/b.ts")).content === "export const c = 30;\n");

    await ctx.fs.writeAtomic("ap/seq.ts", "let x = 0;\n");
    const apSeq = await ap.handler({ edits: [
      { file_path: "ap/seq.ts", old_string:"= 0", new_string:"= 1" },
      { file_path: "ap/seq.ts", old_string:"= 1", new_string:"= 2" },
    ] });
    check("apply_patch sequential edits compound", !apSeq.isError && (await ctx.fs.read("ap/seq.ts")).content === "let x = 2;\n");

    // apply_patch shares the matcher, so it is newline-tolerant too: an LF anchor
    // matches a CRLF file and the file keeps its CRLF endings.
    await ctx.fs.writeAtomic("ap/crlf.ts", "const a = 1;\r\nconst b = 2;\r\n");
    const apCrlf = await ap.handler({ edits: [
      { file_path: "ap/crlf.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 1;\nconst z = 9;\nconst b = 2;" },
    ] });
    check("apply_patch matches LF anchor against CRLF file (preserves CRLF)",
      !apCrlf.isError && (await ctx.fs.readRaw("ap/crlf.ts")).content === "const a = 1;\r\nconst z = 9;\r\nconst b = 2;\r\n", textOf(apCrlf));

    await ctx.fs.writeAtomic("ap/x.ts", "export const p = 1;\n");
    await ctx.fs.writeAtomic("ap/y.ts", "export const q = 2;\n");
    const apAbort = await ap.handler({ edits: [
      { file_path: "ap/x.ts", old_string:"p = 1", new_string:"p = 11" },
      { file_path: "ap/y.ts", old_string:"NOTHERE", new_string:"z" },
    ] });
    check("apply_patch aborts atomically on a bad edit", apAbort.isError === true && textOf(apAbort).includes("aborted") && (await ctx.fs.read("ap/x.ts")).content === "export const p = 1;\n");

    await ctx.fs.writeAtomic("ap/g.ts", "export function g() {\n  return 1;\n}\n");
    const apSyn = await ap.handler({ edits: [{ file_path: "ap/g.ts", old_string:"  return 1;\n}", new_string:"  return 1;" }] });
    check("apply_patch enforces syntax guard", apSyn.isError === true && (await ctx.fs.read("ap/g.ts")).content.includes("}"));
    const apForced = await ap.handler({ validate: false, edits: [{ file_path: "ap/g.ts", old_string:"  return 1;\n}", new_string:"  return 1;" }] });
    check("apply_patch validate:false overrides", !apForced.isError && !(await ctx.fs.read("ap/g.ts")).content.includes("}"));

    await ctx.fs.writeAtomic("ap/amb.ts", "const dup = 1; const x = dup + dup;\n");
    const apAmb = await ap.handler({ edits: [{ file_path: "ap/amb.ts", old_string:"dup", new_string:"D" }] });
    check("apply_patch rejects ambiguous edit", apAmb.isError === true && textOf(apAmb).includes("not unique"));

    const apEscape = await ap.handler({ edits: [{ file_path: "../escape.ts", old_string: "a", new_string: "b" }] });
    check("apply_patch blocks path escape", apEscape.isError === true);

    // Case-variant paths to the same file coalesce (no lost edit) on a
    // case-insensitive filesystem.
    if (process.platform === "win32" || process.platform === "darwin") {
      await ctx.fs.writeAtomic("ap/cv.ts", "const A = 1;\nconst C = 2;\n");
      const apCv = await ap.handler({ edits: [
        { file_path: "ap/cv.ts", old_string:"A = 1", new_string:"A = 11" },
        { file_path: "ap/CV.ts", old_string:"C = 2", new_string:"C = 22" },
      ] });
      check("apply_patch coalesces case-variant paths", !apCv.isError && (await ctx.fs.read("ap/cv.ts")).content === "const A = 11;\nconst C = 22;\n");
    } else {
      check("apply_patch case-variant coalescing (skipped: case-sensitive FS)", true);
    }

    // --- note plugin (scratchpad) ---------------------------------------
    const notePl = notePlugin();
    await notePl.init?.(ctx);
    const nw = tool(notePl, "note_write");
    const nr = tool(notePl, "note_read");

    const nWrite = await nw.handler({ name: "plan", content: "step 1\nstep 2\n" });
    check("note_write writes a note", !nWrite.isError && (await ctx.fs.read(".efficient-token/notes/plan.md")).content === "step 1\nstep 2\n");
    check("note_read reads a note", textOf(await nr.handler({ name: "plan" })).includes("step 1"));
    const nApp = await nw.handler({ name: "plan", content: "step 3\n", append: true });
    check("note_write appends", !nApp.isError && (await ctx.fs.read(".efficient-token/notes/plan.md")).content === "step 1\nstep 2\nstep 3\n");
    check("note_read lists notes", textOf(await nr.handler({})).includes("plan"));
    check("note_read missing note", (await nr.handler({ name: "nope" })).isError === true);
    check("note_write rejects unsafe name", (await nw.handler({ name: "../evil", content: "x" })).isError === true);
    check("note_read rejects unsafe name", (await nr.handler({ name: "../evil" })).isError === true);

    // --- project_rename plugin ------------------------------------------
    await ctx.fs.writeAtomic("pr/a.ts", "export function widget() { return 1; }\nexport const w = widget();\n");
    await ctx.fs.writeAtomic("pr/b.ts", "import { widget } from './a';\nconst x = widget() + widget();\nconst widgetage = 5;\n");
    const prPlugin = projectRenamePlugin();
    await prPlugin.init?.(ctx);
    const pr = tool(prPlugin, "project_rename");

    const dry = textOf(await pr.handler({ oldName: "widget", newName: "gadget", path: "pr", dryRun: true }));
    check("project_rename dry run reports without writing", dry.includes("[dry run]") && dry.includes("pr/a.ts: 2") && dry.includes("pr/b.ts: 3") && (await ctx.fs.read("pr/a.ts")).content.includes("widget"));

    const ren = await pr.handler({ oldName: "widget", newName: "gadget", path: "pr" });
    check("project_rename renames across files", !ren.isError
      && (await ctx.fs.read("pr/a.ts")).content === "export function gadget() { return 1; }\nexport const w = gadget();\n"
      && (await ctx.fs.read("pr/b.ts")).content === "import { gadget } from './a';\nconst x = gadget() + gadget();\nconst widgetage = 5;\n");
    check("project_rename preserves identifier boundaries", (await ctx.fs.read("pr/b.ts")).content.includes("widgetage = 5"));
    check("project_rename rejects invalid newName", (await pr.handler({ oldName: "gadget", newName: "1bad", path: "pr" })).isError === true);
    check("project_rename rejects identical names", (await pr.handler({ oldName: "x", newName: "x", path: "pr" })).isError === true);
    check("project_rename handles no occurrences", textOf(await pr.handler({ oldName: "nonexistentZZZ", newName: "y", path: "pr" })).includes("No occurrences"));
    // Unicode identifier boundary: renaming "caf" should not corrupt "café".
    await ctx.fs.writeAtomic("pr/uni.ts", "const caf = 1;\nconst café = 2;\n");
    const uni = await pr.handler({ oldName: "caf", newName: "X", path: "pr" });
    check("project_rename respects Unicode identifier boundaries", !uni.isError && (await ctx.fs.read("pr/uni.ts")).content === "const X = 1;\nconst café = 2;\n");

    // --- code_search plugin (Grep semantics) ----------------------------
    await ctx.fs.writeAtomic("srch/a.ts", "export function alpha() {}\nconst beta = 1;\n");
    await ctx.fs.writeAtomic("srch/b.ts", "export class Gamma {}\n");
    await ctx.fs.writeAtomic("srch/c.txt", "alpha plain text\n");
    const searchPlugin = codeSearchPlugin();
    await searchPlugin.init?.(ctx);
    const cs = tool(searchPlugin, "code_search");

    const fwm = await cs.handler({ pattern: "alpha", path: "srch" });
    check("code_search files_with_matches", !fwm.isError && textOf(fwm).includes("srch/a.ts") && textOf(fwm).includes("srch/c.txt") && !textOf(fwm).includes("srch/b.ts"));

    const globbed = await cs.handler({ pattern: "alpha", path: "srch", glob: "*.ts" });
    check("code_search glob filter", textOf(globbed).includes("srch/a.ts") && !textOf(globbed).includes("srch/c.txt"));

    const typed = await cs.handler({ pattern: "class", path: "srch", type: "ts" });
    check("code_search type filter", textOf(typed).includes("srch/b.ts") && !textOf(typed).includes(".txt"));

    const contentRes = await cs.handler({ pattern: "beta", path: "srch", output_mode: "content" });
    check("code_search content mode", textOf(contentRes).includes("srch/a.ts:2:const beta = 1;"));

    const countRes = await cs.handler({ pattern: "alpha", path: "srch", output_mode: "count" });
    check("code_search count mode", textOf(countRes).includes("srch/a.ts: 1") && textOf(countRes).includes("srch/c.txt: 1"));

    const ci = await cs.handler({ pattern: "ALPHA", path: "srch", "-i": true });
    check("code_search case-insensitive", textOf(ci).includes("srch/a.ts"));

    const ctxRes = await cs.handler({ pattern: "beta", path: "srch", output_mode: "content", "-C": 1 });
    check("code_search context lines", textOf(ctxRes).includes("srch/a.ts-1-") && textOf(ctxRes).includes("srch/a.ts:2:"));

    // Grep-parity flags: -o (only matching) and -n (toggle line numbers).
    const oOnly = textOf(await cs.handler({ pattern: "alpha", path: "srch", output_mode: "content", "-o": true }));
    check("code_search -o returns only the matched text", oOnly.includes("srch/a.ts:1:alpha") && !oOnly.includes("function"));
    const noNum = textOf(await cs.handler({ pattern: "beta", path: "srch", output_mode: "content", "-n": false }));
    check("code_search -n false omits line numbers", noNum.includes("srch/a.ts:const beta") && !/srch\/a\.ts:\d+:/.test(noNum));

    const none = await cs.handler({ pattern: "zzzznope", path: "srch" });
    check("code_search no match", textOf(none).includes("No matches"));

    const badRe = await cs.handler({ pattern: "(", path: "srch" });
    check("code_search invalid regex", badRe.isError === true && textOf(badRe).includes("invalid regex"));

    check("code_search skips node_modules implicitly", !textOf(await cs.handler({ pattern: "alpha" })).includes("node_modules"));

    // Zero-width regex in count+multiline terminates (no infinite loop).
    const zw = await cs.handler({ pattern: "\\w*", path: "srch", output_mode: "count", multiline: true });
    check("code_search zero-width regex terminates", !zw.isError);

    // multiline content mode must surface a cross-newline match (was a false-negative
    // where content mode returned nothing while files/count modes found the match).
    const mlPat = "alpha\\(\\) \\{\\}\\nconst beta";
    const mlContent = textOf(await cs.handler({ pattern: mlPat, path: "srch", output_mode: "content", multiline: true }));
    check("code_search multiline content returns the spanned lines", mlContent.includes("srch/a.ts:1:") && mlContent.includes("srch/a.ts:2:const beta") && !mlContent.includes("No matches"));
    const mlFiles = textOf(await cs.handler({ pattern: mlPat, path: "srch", output_mode: "files_with_matches", multiline: true }));
    const mlCount = textOf(await cs.handler({ pattern: mlPat, path: "srch", output_mode: "count", multiline: true }));
    check("code_search multiline content is consistent with files/count modes", mlFiles.includes("srch/a.ts") && mlCount.includes("srch/a.ts: 1"));

    // Scanner should not follow a symlinked scope out of the workspace root.
    const scanOut = await mkTmp("efficient-token-scanout-");
    await fsp.writeFile(path.join(scanOut, "secret.ts"), "export const secret = 1;\n");
    try {
      let linked = false;
      try {
        await fsp.symlink(scanOut, path.join(root, "scanlink"), "dir");
        linked = true;
      } catch {
        console.log("  SKIP  code_search blocks symlinked scope (no symlink privilege)");
      }
      if (linked) {
        const esc = await cs.handler({ pattern: "secret", path: "scanlink" });
        check("code_search blocks symlinked scope", esc.isError === true || !textOf(esc).includes("secret.ts"));
      }
    } finally {
      await fsp.rm(scanOut, { recursive: true, force: true });
    }

    // --- glob plugin ----------------------------------------------------
    const globPl = globPlugin();
    await globPl.init?.(ctx);
    const gl = tool(globPl, "glob");
    const globTs = textOf(await gl.handler({ pattern: "*.ts", path: "srch" }));
    check("glob lists matching files", globTs.includes("srch/a.ts") && globTs.includes("srch/b.ts") && !globTs.includes("srch/c.txt"));
    check("glob type filter excludes others", !textOf(await gl.handler({ type: "ts", path: "srch" })).includes(".txt"));
    check("glob no match", textOf(await gl.handler({ pattern: "*.zzz", path: "srch" })).includes("No files"));
    check("glob headLimit caps output", textOf(await gl.handler({ path: "srch", headLimit: 1 })).includes("1+ file(s)"));
    // A glob explicitly rooted at an ignored dir is honored (was silently empty);
    // a plain wildcard walk still skips ignored dirs.
    await ctx.fs.writeAtomic("dist/built.js", "console.log(1);\n");
    check("glob honors an explicitly-named ignored dir", textOf(await gl.handler({ pattern: "dist/**/*.js" })).includes("dist/built.js"));
    check("glob still skips ignored dirs on a plain wildcard", !textOf(await gl.handler({ pattern: "**/*.js" })).includes("dist/built.js"));
    // glob adversarial-review regressions: negation, invalid class, scoped slash-glob, token bound, case
    await ctx.fs.writeAtomic("srch/sub/d.ts", "export const d = 1;\n");
    const globNeg = textOf(await gl.handler({ pattern: "[!a]*.ts", path: "srch" }));
    check("glob negated class [!a]", globNeg.includes("srch/b.ts") && !globNeg.includes("srch/a.ts"));
    const globBad = await gl.handler({ pattern: "[z-a].ts", path: "srch" });
    check("glob invalid class -> clean error", globBad.isError === true && textOf(globBad).includes("invalid glob pattern") && !textOf(globBad).includes("Invalid regular expression"));
    check("glob slash-glob is scoped to path", textOf(await gl.handler({ path: "srch", pattern: "sub/*.ts" })).includes("srch/sub/d.ts"));
    check("glob output respects maxTokens budget", textOf(await gl.handler({ path: "srch", maxTokens: 1 })).includes("showing first"));
    if (process.platform === "win32" || process.platform === "darwin") {
      check("glob case-insensitive on case-insensitive FS", textOf(await gl.handler({ pattern: "*.TS", path: "srch" })).includes("srch/a.ts"));
    }

    // --- read_many plugin -----------------------------------------------
    const rmManyPlugin = readManyPlugin();
    await rmManyPlugin.init?.(ctx);
    const rmm = tool(rmManyPlugin, "read_many");
    const many = await rmm.handler({ reads: [
      { path: "sample.ts", symbol: "add" },
      { path: "sample.ts", startLine: 1, endLine: 1 },
      { path: "srch/a.ts" },
    ] });
    const manyT = textOf(many);
    check("read_many batches symbol + range + whole", !many.isError
      && manyT.includes("### sample.ts symbol=add") && manyT.includes("return a + b;")
      && manyT.includes("### sample.ts:1-1")
      && manyT.includes("### srch/a.ts") && manyT.includes("alpha"));
    const mixed = await rmm.handler({ reads: [
      { path: "sample.ts", symbol: "add" },
      { path: "does/not/exist.ts" },
    ] });
    const mixedT = textOf(mixed);
    check("read_many handles a bad target gracefully", !mixed.isError && mixedT.includes("return a + b;") && mixedT.includes("(error)"));
    // adversarial-review fix: an oversized first target is bounded, not dumped whole.
    await ctx.fs.writeAtomic("rm/big.txt", Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(50)}`).join("\n") + "\n");
    const rmBudget = await rmm.handler({ maxTokens: 5, reads: [{ path: "rm/big.txt" }] });
    const rmBudgetT = textOf(rmBudget);
    check("read_many bounds an oversized first target", !rmBudget.isError && rmBudgetT.length < 2000 && rmBudgetT.includes("truncated"), `len=${rmBudgetT.length}`);
    // adversarial-review fix: read_many does not credit savings per-target (a file
    // hit by several targets would inflate the baseline). It opts out entirely.
    const rmLedger = new SavingsLedger();
    const rmIsoPlugin = readManyPlugin();
    await rmIsoPlugin.init?.({ ...ctx, savings: rmLedger });
    await tool(rmIsoPlugin, "read_many").handler({ reads: [
      { path: "sample.ts", symbol: "add" },
      { path: "sample.ts", symbol: "add" },
    ] });
    check("read_many does not record savings (no double-count)", rmLedger.report().calls === 0);

    // F3: several symbols from one file in a single target
    const multiSym = textOf(await rmm.handler({ reads: [{ path: "sample.ts", symbols: ["add", "Greeter"] }] }));
    check("read_many reads multiple symbols from one file", multiSym.includes("### sample.ts symbol=add") && multiSym.includes("return a + b;") && multiSym.includes("### sample.ts symbol=Greeter") && multiSym.includes("class Greeter"));
    // F3: deduped symbols collapse to one read
    const dedupSym = textOf(await rmm.handler({ reads: [{ path: "sample.ts", symbols: ["add", "add"] }] }));
    check("read_many dedupes repeated symbols", dedupSym.includes("read_many: 1/1") && (dedupSym.match(/symbol=add/g) ?? []).length === 1);
    // F3: symbol + its same-file direct callees
    await ctx.fs.writeAtomic("rm/calls.ts", "export function helper(n: number): number {\n  return n * 2;\n}\n\nexport function compute(n: number): number {\n  return helper(n) + helper(n + 1);\n}\n");
    const callees = textOf(await rmm.handler({ reads: [{ path: "rm/calls.ts", symbol: "compute", withCallees: true }] }));
    check("read_many withCallees pulls same-file callees", callees.includes("symbol=compute") && callees.includes("symbol=helper (callee of compute)") && callees.includes("return n * 2;"));
    // F3: a callee already named explicitly is not duplicated
    const noDup = textOf(await rmm.handler({ reads: [{ path: "rm/calls.ts", symbols: ["compute", "helper"], withCallees: true }] }));
    check("read_many withCallees does not duplicate an explicit symbol", noDup.includes("read_many: 2/2") && (noDup.match(/symbol=helper/g) ?? []).length === 1);
    // F3: the SAME symbol named in two separate targets must not be read (or budgeted) twice.
    const crossDup = textOf(await rmm.handler({ reads: [{ path: "sample.ts", symbol: "add" }, { path: "sample.ts", symbol: "add" }] }));
    check("read_many dedupes the same symbol across separate targets", crossDup.includes("read_many: 1/1") && crossDup.includes("duplicate target(s) merged") && (crossDup.match(/symbol=add/g) ?? []).length === 1);
    // F3: a callee pulled by one target, then named explicitly by another, appears once.
    const crossCallee = textOf(await rmm.handler({ reads: [{ path: "rm/calls.ts", symbol: "compute", withCallees: true }, { path: "rm/calls.ts", symbol: "helper" }] }));
    check("read_many dedupes a callee that another target names explicitly", crossCallee.includes("duplicate target(s) merged") && (crossCallee.match(/symbol=helper/g) ?? []).length === 1);
    // adversarial-review fix: a method call (db.save()) must not pull in a same-named top-level function.
    await ctx.fs.writeAtomic("rm/repo.ts", "export function save() {\n  return 1;\n}\nexport function run(db: { save: () => void }) {\n  db.save();\n}\n");
    const memberCallees = textOf(await rmm.handler({ reads: [{ path: "rm/repo.ts", symbol: "run", withCallees: true }] }));
    check("read_many withCallees ignores method calls (no false callee)", memberCallees.includes("symbol=run") && !memberCallees.includes("callee of run"));

    // --- F1: opt-in re-read elision (code_read elideIfUnchanged) ---------
    await ctx.fs.writeAtomic("reread/mod.ts", "export function thing() {\n  return 1;\n}\n");
    const crEi = codeReadPlugin();
    await crEi.init?.(ctx);
    const cre = tool(crEi, "code_read");
    const reFirst = textOf(await cre.handler({ file_path: "reread/mod.ts", symbol: "thing", elideIfUnchanged: true }));
    check("code_read first elide call returns full source", reFirst.includes("return 1;") && !reFirst.includes("elided"));
    const reSecond = textOf(await cre.handler({ file_path: "reread/mod.ts", symbol: "thing", elideIfUnchanged: true }));
    check("code_read elides an unchanged repeat read", reSecond.includes("elided") && !reSecond.includes("return 1;") && reSecond.includes("reread/mod.ts"));
    const reForced = textOf(await cre.handler({ file_path: "reread/mod.ts", symbol: "thing" }));
    check("code_read without the flag returns full source again", reForced.includes("return 1;") && !reForced.includes("elided"));
    await ctx.fs.writeAtomic("reread/mod.ts", "export function thing() {\n  return 2;\n}\n");
    const reChanged = textOf(await cre.handler({ file_path: "reread/mod.ts", symbol: "thing", elideIfUnchanged: true }));
    check("code_read elide returns full bytes after a change", reChanged.includes("return 2;") && !reChanged.includes("elided"));
    // adversarial-review fix: a lossy/degraded over-budget read must never elide
    // (its rendered text can't safely stand in for the bytes).
    await ctx.fs.writeAtomic("reread/big.ts", `${Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`);
    await cre.handler({ file_path: "reread/big.ts", maxTokens: 200, elideIfUnchanged: true });
    const big2 = textOf(await cre.handler({ file_path: "reread/big.ts", maxTokens: 200, elideIfUnchanged: true }));
    check("code_read never elides a degraded over-budget read", !big2.includes("elided") && big2.includes("exceeds budget"));

    // --- enforcement (opt-in, fail-open) --------------------------------
    // drainer matching: only read-only Bash commands with an MCP equivalent
    check("enforce: bare grep -> code_search", matchDrainer("grep -n foo src") === "code_search");
    check("enforce: bare rg -> code_search", matchDrainer("rg foo") === "code_search");
    check("enforce: bare cat -> code_read", matchDrainer("cat package.json") === "code_read");
    check("enforce: bare head -> code_read", matchDrainer("head -50 file.ts") === "code_read");
    check("enforce: bare find -> glob", matchDrainer("find . -name '*.ts'") === "glob");
    check("enforce: bare ls -> glob", matchDrainer("ls src") === "glob");
    check("enforce: git not matched", matchDrainer("git status") === null);
    check("enforce: flutter not matched", matchDrainer("flutter test") === null && matchDrainer("flutter analyze") === null);
    check("enforce: npm not matched", matchDrainer("npm install") === null);
    check("enforce: unknown first token not matched", matchDrainer("catalog build") === null);
    // adversarial-review fixes: never redirect pipelines, chains, mutations, redirects, or quoted drainers
    check("enforce: pipeline with a protected head not matched", matchDrainer("npm test | grep PASS") === null && matchDrainer("git log --oneline | head -20") === null);
    check("enforce: chained command not matched", matchDrainer("yarn build && ls dist") === null);
    check("enforce: in-place sed not matched", matchDrainer("sed -i 's/a/b/' f.txt") === null && matchDrainer("sed --in-place s/a/b/ f") === null);
    check("enforce: destructive find not matched", matchDrainer("find . -delete") === null && matchDrainer("find . -name '*.tmp' -exec rm {} +") === null);
    check("enforce: output redirection not matched", matchDrainer("cat > out.txt") === null && matchDrainer("cat a >> out.txt") === null);
    check("enforce: tail -f not matched", matchDrainer("tail -f server.log") === null);
    check("enforce: quoted drainer inside another command not matched", matchDrainer('git commit -m "refactor; grep helper"') === null);

    // CLI must never run a writing action on an unrecognized flag
    check("enforce: unknownArgs rejects unknown flags", unknownArgs(["--help"]).length === 1 && unknownArgs(["--bogus"]).length === 1 && unknownArgs(["--scope", "nope"]).includes("nope"));
    check("enforce: unknownArgs accepts valid scope flags", unknownArgs([]).length === 0 && unknownArgs(["--scope", "user"]).length === 0 && unknownArgs(["--scope=user"]).length === 0 && unknownArgs(["--user"]).length === 0);

    // settings deep-merge idempotency + preserving unrelated config
    const ecmd = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/efficient-token-redirect.mjs"`;
    const em1 = deepMergeSetup({}, ecmd);
    check("enforce: merge adds one managed entry", (em1.hooks?.PreToolUse?.length ?? 0) === 1 && isManagedEntry(em1.hooks!.PreToolUse![0]!));
    check("enforce: merge is idempotent", (deepMergeSetup(em1, ecmd).hooks?.PreToolUse?.length ?? 0) === 1);
    const ebase = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node other.mjs" }] }], PostToolUse: [{ matcher: "Edit", hooks: [] }] }, permissions: { allow: ["x"] } };
    const em3 = deepMergeSetup(ebase, ecmd) as Record<string, any>;
    check(
      "enforce: merge preserves unrelated settings",
      em3.permissions.allow[0] === "x" &&
        em3.hooks.PostToolUse.length === 1 &&
        em3.hooks.PreToolUse.some((e: any) => e.hooks[0].command === "node other.mjs") &&
        em3.hooks.PreToolUse.filter(isManagedEntry).length === 1,
    );
    const eback = removeManaged(em3) as Record<string, any>;
    check(
      "enforce: removeManaged restores (managed gone, others kept)",
      eback.hooks.PreToolUse.length === 1 && !eback.hooks.PreToolUse.some(isManagedEntry) && eback.permissions.allow[0] === "x",
    );
    check("enforce: removeManaged prunes empty hooks", removeManaged(deepMergeSetup({}, ecmd)).hooks === undefined);
    // adversarial-review fix: a non-object `hooks` is coerced, never silently dropped
    const emArr = deepMergeSetup({ hooks: ["weird"] } as never, ecmd) as Record<string, any>;
    check("enforce: merge coerces non-object hooks and still installs", Array.isArray(emArr.hooks.PreToolUse) && emArr.hooks.PreToolUse.filter(isManagedEntry).length === 1);

    // setup / uninstall on disk (isolated temp project)
    const enfRoot = await mkTmp("efficient-token-enforce-");
    const enfSettings = path.join(enfRoot, ".claude", "settings.local.json");
    const enfScript = path.join(enfRoot, ".claude", "hooks", "efficient-token-redirect.mjs");
    runSetup({ scope: "project", projectRoot: enfRoot });
    const es1 = JSON.parse(await fsp.readFile(enfSettings, "utf8"));
    check("enforce: setup writes a managed Bash hook", es1.hooks.PreToolUse.length === 1 && es1.hooks.PreToolUse[0].matcher === "Bash");
    check("enforce: setup writes the redirect script", await fileThere(enfScript));
    runSetup({ scope: "project", projectRoot: enfRoot });
    check("enforce: setup is idempotent on disk", JSON.parse(await fsp.readFile(enfSettings, "utf8")).hooks.PreToolUse.length === 1);
    runUninstall({ scope: "project", projectRoot: enfRoot });
    const es3 = JSON.parse(await fsp.readFile(enfSettings, "utf8"));
    check("enforce: uninstall removes the managed hook", es3.hooks === undefined || (es3.hooks.PreToolUse ?? []).length === 0);
    check("enforce: uninstall removes the redirect script", !(await fileThere(enfScript)));

    // adversarial-review fix: the pristine backup survives a second setup run
    const bakRoot = await mkTmp("efficient-token-bak-");
    await fsp.mkdir(path.join(bakRoot, ".claude"), { recursive: true });
    await fsp.writeFile(path.join(bakRoot, ".claude", "settings.local.json"), '{"userKey":"original"}\n');
    runSetup({ scope: "project", projectRoot: bakRoot });
    runSetup({ scope: "project", projectRoot: bakRoot });
    const bakJson = JSON.parse(await fsp.readFile(path.join(bakRoot, ".claude", "settings.local.json.bak"), "utf8"));
    check("enforce: pristine backup preserved across re-runs", bakJson.userKey === "original" && bakJson.hooks === undefined);

    // --- status line setup (setup also installs the always-visible status) ---
    check("enforce: isManagedStatusLine recognizes ours vs foreign", isManagedStatusLine({ type: "command", command: "node x/efficient-token-status.mjs" }) && !isManagedStatusLine({ type: "command", command: "node mine.js" }) && !isManagedStatusLine(undefined));
    const slSetLog: string[] = [];
    const slSet = setManagedStatusLine({ statusLine: { type: "command", command: "node foreign.js" } }, "node a/efficient-token-status.mjs", slSetLog) as Record<string, any>;
    check("enforce: setManagedStatusLine never clobbers a foreign statusLine", slSet.statusLine.command === "node foreign.js");
    const slRm = removeManagedStatusLine({ statusLine: { type: "command", command: "node foreign.js" } }, []) as Record<string, any>;
    check("enforce: removeManagedStatusLine leaves a foreign statusLine intact", slRm.statusLine.command === "node foreign.js");

    // on disk: setup installs a managed statusLine + script; uninstall removes them
    const slRoot = await mkTmp("efficient-token-sl-");
    runSetup({ scope: "project", projectRoot: slRoot });
    const slSettings = JSON.parse(await fsp.readFile(path.join(slRoot, ".claude", "settings.local.json"), "utf8"));
    const slScriptPath = path.join(slRoot, ".claude", "hooks", "efficient-token-status.mjs");
    check("enforce: setup installs a managed statusLine + script", isManagedStatusLine(slSettings.statusLine) && (await fileThere(slScriptPath)));
    runUninstall({ scope: "project", projectRoot: slRoot });
    const slAfter = JSON.parse(await fsp.readFile(path.join(slRoot, ".claude", "settings.local.json"), "utf8"));
    check("enforce: uninstall removes the managed statusLine + script", slAfter.statusLine === undefined && !(await fileThere(slScriptPath)));

    // setup must not clobber a user's own statusLine, on disk
    const fgRoot = await mkTmp("efficient-token-slfg-");
    await fsp.mkdir(path.join(fgRoot, ".claude"), { recursive: true });
    await fsp.writeFile(path.join(fgRoot, ".claude", "settings.local.json"), JSON.stringify({ statusLine: { type: "command", command: "node my-own-status.js" } }));
    runSetup({ scope: "project", projectRoot: fgRoot });
    check("enforce: setup keeps a user's own statusLine (on disk)", JSON.parse(await fsp.readFile(path.join(fgRoot, ".claude", "settings.local.json"), "utf8")).statusLine.command === "node my-own-status.js");
    runUninstall({ scope: "project", projectRoot: fgRoot });
    check("enforce: uninstall leaves a user's own statusLine (on disk)", JSON.parse(await fsp.readFile(path.join(fgRoot, ".claude", "settings.local.json"), "utf8")).statusLine.command === "node my-own-status.js");

    // --no-statusline / --no-hook scope the setup
    const nsRoot = await mkTmp("efficient-token-nosl-");
    runSetup({ scope: "project", projectRoot: nsRoot, statusLine: false });
    const nsSettings = JSON.parse(await fsp.readFile(path.join(nsRoot, ".claude", "settings.local.json"), "utf8"));
    check("enforce: --no-statusline keeps the hook, skips the status line", nsSettings.statusLine === undefined && nsSettings.hooks.PreToolUse.length === 1 && !(await fileThere(path.join(nsRoot, ".claude", "hooks", "efficient-token-status.mjs"))));
    const nhRoot = await mkTmp("efficient-token-nohook-");
    runSetup({ scope: "project", projectRoot: nhRoot, hook: false });
    const nhSettings = JSON.parse(await fsp.readFile(path.join(nhRoot, ".claude", "settings.local.json"), "utf8"));
    check("enforce: --no-hook installs only the status line", isManagedStatusLine(nhSettings.statusLine) && (nhSettings.hooks === undefined || (nhSettings.hooks.PreToolUse ?? []).length === 0) && !(await fileThere(path.join(nhRoot, ".claude", "hooks", "efficient-token-redirect.mjs"))));

    // the generated status-line script prints health from the heartbeat (subprocess)
    const slGen = path.join(nhRoot, ".claude", "hooks", "efficient-token-status.mjs");
    await fsp.writeFile(path.join(nhRoot, ".claude", ".efficient-token.alive"), JSON.stringify({ v: "1.2.3", tier: "free", calls: 5, savedTokens: 4096, baselineTokens: 51200, returnedTokens: 47104 }));
    let slHk = await runHook(slGen, "", { CLAUDE_PROJECT_DIR: nhRoot });
    check("enforce: status-line script prints processed->passed + percent when up", slHk.code === 0 && slHk.stdout.includes("v1.2.3") && slHk.stdout.includes("(free)") && slHk.stdout.includes("51.2k token read and passed 47.1k token to Claude") && slHk.stdout.includes("~8% less"));
    await fsp.rm(path.join(nhRoot, ".claude", ".efficient-token.alive"), { force: true });
    slHk = await runHook(slGen, "", { CLAUDE_PROJECT_DIR: nhRoot });
    check("enforce: status-line script prints not running when down", slHk.code === 0 && slHk.stdout.includes("not running"));

    // redirect script fail-open behavior, exercised as a real subprocess
    runSetup({ scope: "project", projectRoot: enfRoot }); // recreate the script
    const beatFile = path.join(enfRoot, ".claude", ".efficient-token.alive");
    const grepIn = JSON.stringify({ tool_input: { command: "grep foo" } });
    const env = { CLAUDE_PROJECT_DIR: enfRoot };
    let hk = await runHook(enfScript, "not json", env);
    check("enforce: unparseable stdin allows", hk.code === 0 && hk.stdout.trim() === "");
    hk = await runHook(enfScript, JSON.stringify({ tool_input: { command: "git status" } }), env);
    check("enforce: non-drainer allows", hk.code === 0 && hk.stdout.trim() === "");
    try { await fsp.rm(beatFile, { force: true }); } catch { /* ignore */ }
    hk = await runHook(enfScript, grepIn, env);
    check("enforce: drainer + missing heartbeat allows (fail-open)", hk.code === 0 && hk.stdout.trim() === "");
    await fsp.writeFile(beatFile, "x");
    hk = await runHook(enfScript, grepIn, env);
    check("enforce: drainer + live heartbeat denies with redirect", hk.code === 0 && hk.stdout.includes('"permissionDecision":"deny"') && hk.stdout.includes("code_search"));
    // even with a live heartbeat, the hook must never block pipelines/mutations
    hk = await runHook(enfScript, JSON.stringify({ tool_input: { command: "npm test | grep PASS" } }), env);
    check("enforce: protected command in a pipeline never denied (live)", hk.code === 0 && hk.stdout.trim() === "");
    hk = await runHook(enfScript, JSON.stringify({ tool_input: { command: "sed -i 's/a/b/' f.txt" } }), env);
    check("enforce: in-place sed never denied (live)", hk.code === 0 && hk.stdout.trim() === "");
    hk = await runHook(enfScript, JSON.stringify({ tool_input: { command: "find . -delete" } }), env);
    check("enforce: destructive find never denied (live)", hk.code === 0 && hk.stdout.trim() === "");
    const staleSecs = Date.now() / 1000 - 600;
    await fsp.utimes(beatFile, staleSecs, staleSecs);
    hk = await runHook(enfScript, grepIn, env);
    check("enforce: drainer + stale heartbeat allows (fail-open)", hk.code === 0 && hk.stdout.trim() === "");
    await fsp.writeFile(beatFile, "x"); // fresh again
    hk = await runHook(enfScript, JSON.stringify({ tool_input: { command: "flutter test" } }), env);
    check("enforce: flutter test never denied (live heartbeat)", hk.code === 0 && hk.stdout.trim() === "");

    // --- status (health shown in-session without an API call) -----------
    const stRoot = await mkTmp("efficient-token-status-");
    const stBeat = path.join(stRoot, ".claude", ".efficient-token.alive");
    await fsp.mkdir(path.join(stRoot, ".claude"), { recursive: true });
    check("status: down when no heartbeat", readStatus(stRoot).up === false && formatStatus(readStatus(stRoot)).includes("not running") && formatDetailed(readStatus(stRoot)).includes("not running"));
    await fsp.writeFile(stBeat, JSON.stringify({ v: "9.9.9", pid: 1, ts: Date.now(), tier: "free", root: "/proj", maxReadTokens: 6000, maxFileBytes: 2000000, calls: 3, returnedTokens: 10, baselineTokens: 130, savedTokens: 120 }));
    const stUp = readStatus(stRoot);
    check("status: up parses version/tier/root/limits/savings", stUp.up === true && stUp.version === "9.9.9" && stUp.tier === "free" && stUp.root === "/proj" && stUp.maxReadTokens === 6000 && stUp.maxFileBytes === 2000000 && stUp.savedTokens === 120 && stUp.baselineTokens === 130 && stUp.calls === 3);
    const stDet = formatDetailed(stUp);
    check("status: detailed report mirrors health", stDet.includes("efficient-token: up") && stDet.includes("version: 9.9.9") && stDet.includes("tier: free") && stDet.includes("root: /proj") && stDet.includes("maxReadTokens: 6000") && stDet.includes("savings this session") && stDet.includes("read ~130 tokens of source and passed ~10 to Claude") && stDet.includes("~92% fewer") && stDet.includes("saved ~120 tokens"));
    check("status: compact one-liner shows processed->passed + percent", formatStatus(stUp).includes("v9.9.9") && formatStatus(stUp).includes("(free)") && formatStatus(stUp).includes("up") && formatStatus(stUp).includes("130 token read and passed 10 token to Claude") && formatStatus(stUp).includes("~92% less"));
    const stStale = Date.now() / 1000 - 600;
    await fsp.utimes(stBeat, stStale, stStale);
    check("status: stale heartbeat -> not running", readStatus(stRoot).up === false);
    await fsp.writeFile(stBeat, String(Date.now())); // legacy plain-timestamp heartbeat
    const stPlain = readStatus(stRoot);
    check("status: plain heartbeat is up without detail", stPlain.up === true && stPlain.version === undefined);

    // --- json_query plugin ----------------------------------------------
    await ctx.fs.writeAtomic("jq/data.json", JSON.stringify({ name: "pkg", scripts: { build: "tsc", test: "vitest" }, deps: ["a", "b", "c"], nested: { deep: { value: 42 } } }, null, 2));
    const jqPlugin = jsonQueryPlugin();
    await jqPlugin.init?.(ctx);
    const jq = tool(jqPlugin, "json_query");
    check("json_query dotted path", textOf(await jq.handler({ path: "jq/data.json", query: "scripts.build" })).includes("tsc"));
    check("json_query array index", textOf(await jq.handler({ path: "jq/data.json", query: "deps[1]" })).includes('"b"'));
    check("json_query nested path", textOf(await jq.handler({ path: "jq/data.json", query: "nested.deep.value" })).includes("42"));
    const jqObj = textOf(await jq.handler({ path: "jq/data.json", query: "scripts" }));
    check("json_query object slice", jqObj.includes("build") && jqObj.includes("test"));
    const jqOv = textOf(await jq.handler({ path: "jq/data.json" }));
    check("json_query overview", jqOv.includes("top-level") && jqOv.includes("scripts: object") && jqOv.includes("deps: array"));
    const jqMiss = await jq.handler({ path: "jq/data.json", query: "nope" });
    check("json_query missing key lists available", jqMiss.isError === true && textOf(jqMiss).includes("Available"));
    check("json_query out-of-range index", (await jq.handler({ path: "jq/data.json", query: "deps[99]" })).isError === true);
    await ctx.fs.writeAtomic("jq/bad.json", "{ not valid json ");
    check("json_query rejects invalid JSON", textOf(await jq.handler({ path: "jq/bad.json" })).includes("not valid JSON"));
    // adversarial-review fix: overview path is token-bounded (was unbounded).
    const bigObj: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) bigObj["key" + i] = i;
    await ctx.fs.writeAtomic("jq/big.json", JSON.stringify(bigObj));
    const jqBig = textOf(await jq.handler({ path: "jq/big.json", maxTokens: 50 }));
    check("json_query overview is token-bounded", jqBig.length < 1000 && jqBig.includes("truncated"), `len=${jqBig.length}`);
    // adversarial-review fix: truncation never splits a surrogate pair.
    await ctx.fs.writeAtomic("jq/emoji.json", JSON.stringify({ s: "\u{1F600}".repeat(300) }));
    const jqEmoji = textOf(await jq.handler({ path: "jq/emoji.json", query: "s", maxTokens: 7 }));
    let loneSurrogate = false;
    for (let i = 0; i < jqEmoji.length; i++) {
      const c = jqEmoji.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const n = jqEmoji.charCodeAt(i + 1);
        if (n >= 0xdc00 && n <= 0xdfff) i++;
        else { loneSurrogate = true; break; }
      } else if (c >= 0xdc00 && c <= 0xdfff) { loneSurrogate = true; break; }
    }
    check("json_query render is surrogate-safe", jqEmoji.includes("truncated") && !loneSurrogate);

    // --- json_edit plugin (json_get / json_set) -------------------------
    const arb = {
      "@@locale": "en",
      greeting: "Hello",
      "@greeting": { description: "A greeting" },
      farewell: "Goodbye",
    };
    await ctx.fs.writeAtomic("je/app_en.json", `${JSON.stringify(arb, null, 2)}\n`);
    const jePlugin = jsonEditPlugin();
    await jePlugin.init?.(ctx);
    const jget = tool(jePlugin, "json_get");
    const jset = tool(jePlugin, "json_set");

    const got = textOf(await jget.handler({ path: "je/app_en.json", key: "greeting" }));
    check("json_get returns value + sibling metadata", got.includes("Hello") && got.includes("A greeting") && got.includes("@greeting"));
    const getMiss = await jget.handler({ path: "je/app_en.json", key: "nope" });
    check("json_get missing key lists available (no @ keys)", getMiss.isError === true && textOf(getMiss).includes("greeting") && !textOf(getMiss).includes("@greeting"));

    // update an existing key in place; the rest of the file must be preserved
    const jeBefore = (await ctx.fs.read("je/app_en.json")).content;
    const jeUpd = await jset.handler({ path: "je/app_en.json", key: "greeting", value: "Hi there" });
    check("json_set updates a key", !jeUpd.isError && textOf(jeUpd).includes("updated"));
    const jeAfter = (await ctx.fs.read("je/app_en.json")).content;
    const jeObj = JSON.parse(jeAfter);
    check(
      "json_set update is correct + faithful",
      jeObj.greeting === "Hi there" && jeObj.farewell === "Goodbye" && jeObj["@@locale"] === "en" && JSON.stringify(jeObj["@greeting"]) === JSON.stringify({ description: "A greeting" }),
    );
    check("json_set leaves preceding bytes intact", jeBefore.slice(0, jeBefore.indexOf('"greeting"')) === jeAfter.slice(0, jeAfter.indexOf('"greeting"')));

    // upsert a new key + metadata with placeholders (multi-line object value)
    const jeIns = await jset.handler({ path: "je/app_en.json", key: "welcome", value: "Welcome {name}", metadata: { description: "Welcome msg", placeholders: { name: {} } } });
    check("json_set inserts a new key + metadata", !jeIns.isError && textOf(jeIns).includes("created"));
    const jeIns2 = JSON.parse((await ctx.fs.read("je/app_en.json")).content);
    check("json_set insert is correct", jeIns2.welcome === "Welcome {name}" && jeIns2["@welcome"]?.placeholders?.name !== undefined && jeIns2.greeting === "Hi there");

    // values with structural chars must not corrupt the surgical scan
    await jset.handler({ path: "je/app_en.json", key: "tricky", value: 'a {x}, "b" : [c]' });
    const jeTricky = JSON.parse((await ctx.fs.read("je/app_en.json")).content);
    check("json_set handles structural chars in values", jeTricky.tricky === 'a {x}, "b" : [c]' && jeTricky.welcome === "Welcome {name}");

    // insert into an empty object
    await ctx.fs.writeAtomic("je/empty.json", "{}\n");
    await jset.handler({ path: "je/empty.json", key: "first", value: 1 });
    check("json_set inserts into an empty object", JSON.parse((await ctx.fs.read("je/empty.json")).content).first === 1);

    // metadata-only update of an existing sibling
    await jset.handler({ path: "je/app_en.json", key: "greeting", metadata: { description: "Updated desc" } });
    const jeMeta = JSON.parse((await ctx.fs.read("je/app_en.json")).content);
    check("json_set metadata-only update", jeMeta["@greeting"].description === "Updated desc" && jeMeta.greeting === "Hi there");

    // a CRLF file keeps CRLF in inserted/updated regions (no mixed line endings)
    await ctx.fs.writeAtomic("je/crlf.json", '{\r\n  "a": "1"\r\n}\r\n');
    await jset.handler({ path: "je/crlf.json", key: "b", value: "two", metadata: { description: "d" } });
    const crlfOut = (await ctx.fs.read("je/crlf.json")).content;
    check("json_set preserves CRLF line endings", JSON.parse(crlfOut).b === "two" && !/(?<!\r)\n/.test(crlfOut));

    // guards
    await ctx.fs.writeAtomic("je/arr.json", "[1,2,3]\n");
    check("json_set rejects a non-object root", (await jset.handler({ path: "je/arr.json", key: "x", value: 1 })).isError === true);
    check("json_set requires value or metadata", (await jset.handler({ path: "je/app_en.json", key: "greeting" })).isError === true);
    check("json_set rejects an invalid JSON file", (await jset.handler({ path: "jq/bad.json", key: "x", value: 1 })).isError === true);
    check("json_set rejects empty metaPrefix with metadata", (await jset.handler({ path: "je/app_en.json", key: "greeting", value: "x", metadata: {}, metaPrefix: "" })).isError === true);

    // adversarial-review fix: a leading BOM is preserved, not rejected as invalid JSON
    await ctx.fs.writeAtomic("je/bom.json", `﻿{\n  "a": 1\n}\n`);
    const bomRes = await jset.handler({ path: "je/bom.json", key: "b", value: 2 });
    const bomOut = (await ctx.fs.readRaw("je/bom.json")).content;
    check("json_set preserves a leading BOM", !bomRes.isError && bomOut.charCodeAt(0) === 0xfeff && JSON.parse(bomOut.slice(1)).b === 2 && JSON.parse(bomOut.slice(1)).a === 1);

    // adversarial-review fix: duplicate top-level key edits the effective (last) one
    await ctx.fs.writeAtomic("je/dup.json", '{\n  "a": 1,\n  "a": 2\n}\n');
    await jset.handler({ path: "je/dup.json", key: "a", value: 99 });
    check("json_set updates the effective duplicate key", JSON.parse((await ctx.fs.read("je/dup.json")).content).a === 99);

    // adversarial-review fix: insert adopts the file's real indent even when the first member is inline with {
    await ctx.fs.writeAtomic("je/indent.json", '{"a": 1,\n    "b": 2\n}\n');
    await jset.handler({ path: "je/indent.json", key: "c", value: 3 });
    const indentOut = (await ctx.fs.read("je/indent.json")).content;
    check("json_set inserts with the file's actual indent", indentOut.includes('\n    "c": 3') && JSON.parse(indentOut).c === 3);

    // --- view_image plugin ----------------------------------------------
    const viPlugin = viewImagePlugin();
    await viPlugin.init?.(ctx);
    const vi = tool(viPlugin, "view_image");
    await fsp.mkdir(path.join(root, "img"), { recursive: true });
    const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    await fsp.writeFile(path.join(root, "img/pixel.png"), PNG_1x1);
    await fsp.writeFile(path.join(root, "img/icon.svg"), '<svg viewBox="0 0 10 10"></svg>\n');
    const viRes = await vi.handler({ paths: ["img/pixel.png"] });
    check("view_image returns an image block", !viRes.isError && viRes.content.some((c) => c.type === "image" && c.mimeType === "image/png" && c.data.length > 0));
    check("view_image refuses oversized images", (await vi.handler({ paths: ["img/pixel.png"], maxBytes: 1 })).isError === true);
    const viMix = await vi.handler({ paths: ["img/pixel.png", "img/icon.svg"] });
    const viMixNote = viMix.content.find((c) => c.type === "text");
    check("view_image skips non-raster (svg) but keeps the raster", viMix.content.filter((c) => c.type === "image").length === 1 && !!viMixNote && viMixNote.type === "text" && viMixNote.text.includes("svg"));
    check("view_image all-unsupported is an error", (await vi.handler({ paths: ["img/icon.svg"] })).isError === true);
    // adversarial-review fix: output is bounded by path count and an aggregate byte budget
    check("view_image caps the path count", (await vi.handler({ paths: Array.from({ length: 10 }, () => "img/pixel.png") })).content.filter((c) => c.type === "image").length <= 8);
    const bigImg = Buffer.alloc(6_500_000);
    await fsp.writeFile(path.join(root, "img/big1.png"), bigImg);
    await fsp.writeFile(path.join(root, "img/big2.png"), bigImg);
    const viAgg = await vi.handler({ paths: ["img/big1.png", "img/big2.png"], maxBytes: 7_000_000 });
    const viAggNote = viAgg.content.find((c) => c.type === "text");
    check("view_image enforces an aggregate byte budget", viAgg.content.filter((c) => c.type === "image").length === 1 && !!viAggNote && viAggNote.type === "text" && viAggNote.text.includes("aggregate"));

    // --- media_info plugin ----------------------------------------------
    const miPlugin = mediaInfoPlugin();
    await miPlugin.init?.(ctx);
    const mi = tool(miPlugin, "media_info");
    const miPng = textOf(await mi.handler({ paths: ["img/pixel.png"] }));
    check("media_info reports image dimensions zero-dep", miPng.includes("png 1x1") && miPng.includes("1:1"));
    await fsp.writeFile(path.join(root, "img/clip.mp4"), Buffer.from("not a real mp4"));
    const miMp4 = textOf(await mi.handler({ paths: ["img/clip.mp4"] }));
    check("media_info handles A/V path gracefully", miMp4.includes("clip.mp4") && (miMp4.includes("ffprobe") || miMp4.includes("probe failed") || miMp4.includes("mp4")));
    // adversarial-review fix: malformed headers report "dimensions unavailable", not garbage
    await fsp.writeFile(path.join(root, "img/fake.gif"), Buffer.from("GIF rocks!!"));
    check("media_info rejects a non-GIF with a GIF prefix", textOf(await mi.handler({ paths: ["img/fake.gif"] })).includes("dimensions unavailable"));
    const badBmp = Buffer.alloc(26);
    badBmp[0] = 0x42;
    badBmp[1] = 0x4d;
    badBmp.writeInt32LE(-5, 18);
    badBmp.writeInt32LE(10, 22);
    await fsp.writeFile(path.join(root, "img/bad.bmp"), badBmp);
    check("media_info rejects BMP negative width", textOf(await mi.handler({ paths: ["img/bad.bmp"] })).includes("dimensions unavailable"));

    // --- design_tokens plugin -------------------------------------------
    await ctx.fs.writeAtomic("dt/theme.css", ":root {\n  --color-primary: #3366ff;\n  --space-4: 16px;\n  --font-family-base: 'Inter', sans-serif;\n  --radius: 8px;\n}\n");
    await ctx.fs.writeAtomic("dt/tokens.json", JSON.stringify({ color: { brand: { value: "#ff0000" } }, space: { sm: { $value: "4px" } } }));
    const dtPlugin = designTokensPlugin();
    await dtPlugin.init?.(ctx);
    const dt = tool(dtPlugin, "design_tokens");
    const dtAll = textOf(await dt.handler({ paths: ["dt/theme.css", "dt/tokens.json"] }));
    check("design_tokens extracts CSS vars + JSON tokens, classified",
      dtAll.includes("color (") && dtAll.includes("--color-primary = #3366ff") && dtAll.includes("size (") && dtAll.includes("16px") && dtAll.includes("color-brand = #ff0000") && dtAll.includes("space-sm = 4px"));
    const dtColor = textOf(await dt.handler({ paths: ["dt/theme.css"], category: "color" }));
    check("design_tokens category filter", dtColor.includes("color-primary") && !dtColor.includes("space-4"));
    check("design_tokens classifies fonts by name", textOf(await dt.handler({ paths: ["dt/theme.css"], category: "font" })).includes("font-family-base"));
    await ctx.fs.writeAtomic("dt/arr.json", JSON.stringify({ stack: ["alpha", "beta"] }));
    const dtArr = textOf(await dt.handler({ paths: ["dt/arr.json"] }));
    check("design_tokens descends into JSON arrays (no silent drop)", dtArr.includes("stack-0 = alpha") && dtArr.includes("stack-1 = beta"));

    // --- color_contrast plugin ------------------------------------------
    const colPlugin = colorContrastPlugin();
    await colPlugin.init?.(ctx);
    const col = tool(colPlugin, "color_contrast");
    const colMax = textOf(await col.handler({ color: "#ffffff", against: "#000000" }));
    check("color_contrast computes WCAG ratio + verdicts", colMax.includes("21:1") && colMax.includes("AAA normal (>=7.0): PASS"));
    const colConv = textOf(await col.handler({ color: "rgb(51, 102, 255)" }));
    check("color_contrast converts formats", colConv.includes("#3366ff") && colConv.includes("hsl("));
    check("color_contrast parses named + hsl to the same hex", textOf(await col.handler({ color: "red" })).includes("#ff0000") && textOf(await col.handler({ color: "hsl(0, 100%, 50%)" })).includes("#ff0000"));
    check("color_contrast rejects a bad color", (await col.handler({ color: "notacolor" })).isError === true);
    check("color_contrast resolves full CSS names", textOf(await col.handler({ color: "rebeccapurple" })).includes("#663399") && textOf(await col.handler({ color: "aliceblue" })).includes("#f0f8ff"));

    // --- svg_digest plugin ----------------------------------------------
    await ctx.fs.writeAtomic("svg/icon.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">\n  <defs><linearGradient id="grad1"/></defs>\n  <g id="layer1"><path d="M0 0L10 10"/><path d="M2 2"/><circle id="dot" cx="5" cy="5" r="2"/></g>\n  <rect x="0" y="0" width="24" height="24"/>\n</svg>\n');
    const svgPlugin = svgDigestPlugin();
    await svgPlugin.init?.(ctx);
    const svg = tool(svgPlugin, "svg_digest");
    const svgRes = textOf(await svg.handler({ path: "svg/icon.svg" }));
    check("svg_digest reports structure without dumping markup",
      svgRes.includes("viewBox: 0 0 24 24") && svgRes.includes("path×2") && svgRes.includes("ids (3)") && svgRes.includes("grad1") && !svgRes.includes("M0 0L10 10"));
    check("svg_digest rejects non-svg", (await svg.handler({ path: "sample.ts" })).isError === true);
    // adversarial-review fix: a hostile all-word-char <svg> tag should not stall (was O(n²))
    await ctx.fs.writeAtomic("svg/huge.svg", `<svg ${"a".repeat(300000)}></svg>`);
    const svgT0 = Date.now();
    const svgHuge = await svg.handler({ path: "svg/huge.svg" });
    check("svg_digest is time-bounded on a hostile tag", !svgHuge.isError && Date.now() - svgT0 < 3000, `${Date.now() - svgT0}ms`);
    // adversarial-review fix: truncation slices on code points (no lone surrogate)
    await ctx.fs.writeAtomic("svg/emoji.svg", `<svg viewBox="0 0 1 1"><g id="${"\u{1F600}".repeat(50)}"/></svg>`);
    const svgEmoji = textOf(await svg.handler({ path: "svg/emoji.svg", maxTokens: 10 }));
    let svgLone = false;
    for (let i = 0; i < svgEmoji.length; i++) {
      const c = svgEmoji.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        if (svgEmoji.charCodeAt(i + 1) >= 0xdc00 && svgEmoji.charCodeAt(i + 1) <= 0xdfff) i++;
        else { svgLone = true; break; }
      } else if (c >= 0xdc00 && c <= 0xdfff) { svgLone = true; break; }
    }
    check("svg_digest truncation is surrogate-safe", !svgLone);

    // --- font_info plugin -----------------------------------------------
    const fontPlugin = fontInfoPlugin();
    await fontPlugin.init?.(ctx);
    const fi = tool(fontPlugin, "font_info");
    const enc16 = (s: string): Buffer => {
      const b = Buffer.alloc(s.length * 2);
      for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2);
      return b;
    };
    const nb = enc16("Inter");
    const nameTable = Buffer.concat([
      Buffer.from([0, 0, 0, 1, 0, 18]), // format 0, count 1, stringOffset 18
      Buffer.from([0, 3, 0, 1, 0x04, 0x09, 0, 1, (nb.length >> 8) & 0xff, nb.length & 0xff, 0, 0]), // platform3/enc1/lang/nameID1/len/off0
      nb,
    ]);
    const fhdr = Buffer.alloc(12);
    fhdr.writeUInt32BE(0x00010000, 0);
    fhdr.writeUInt16BE(1, 4);
    const fdir = Buffer.alloc(16);
    fdir.write("name", 0, "ascii");
    fdir.writeUInt32BE(28, 8);
    fdir.writeUInt32BE(nameTable.length, 12);
    await fsp.mkdir(path.join(root, "fonts"), { recursive: true });
    await fsp.writeFile(path.join(root, "fonts/Inter.ttf"), Buffer.concat([fhdr, fdir, nameTable]));
    check("font_info reads TTF family from the name table", textOf(await fi.handler({ paths: ["fonts/Inter.ttf"] })).includes('family "Inter"'));
    await ctx.fs.writeAtomic("fonts/faces.css", "@font-face {\n  font-family: 'Inter';\n  font-weight: 400;\n  font-style: normal;\n  src: url('Inter.woff2') format('woff2');\n}\n");
    const fiCss = textOf(await fi.handler({ paths: ["fonts/faces.css"] }));
    check("font_info extracts @font-face", fiCss.includes('family "Inter"') && fiCss.includes("weight 400"));
    check("font_info notes woff2 binary", textOf(await fi.handler({ paths: ["fonts/Inter.woff2"] })).includes("woff2"));

    // --- token_usage plugin ---------------------------------------------
    await ctx.fs.writeAtomic("tu/style.css", ":root {\n  --used: #fff;\n  --unused: 4px;\n}\n.a {\n  color: var(--used);\n  background: var(--missing);\n}\n");
    const tuPlugin = tokenUsagePlugin();
    await tuPlugin.init?.(ctx);
    const tu = tool(tuPlugin, "token_usage");
    const tuRes = textOf(await tu.handler({ paths: ["tu/style.css"] }));
    check("token_usage finds unused + undefined custom properties",
      tuRes.includes("defined but unused (1)") && tuRes.includes("--unused") && tuRes.includes("used but undefined (1)") && tuRes.includes("--missing"));
    await ctx.fs.writeAtomic("tu/clean.css", ":root { --c: red; }\n.b { color: var(--c); }\n");
    check("token_usage clean report", textOf(await tu.handler({ paths: ["tu/clean.css"] })).includes("every defined custom property is referenced"));
    // adversarial-review fix: --x: inside a string or comment is not a definition
    await ctx.fs.writeAtomic("tu/noise.css", ':root { --real: 1px; }\n.a { content: " --fake: x "; width: var(--real); }\n/* --comment: y */\n');
    const tuNoise = textOf(await tu.handler({ paths: ["tu/noise.css"] }));
    check("token_usage ignores --x in strings/comments", !tuNoise.includes("--fake") && !tuNoise.includes("--comment") && tuNoise.includes("every defined custom property is referenced"));

    // --- find_references plugin -----------------------------------------
    await ctx.fs.writeAtomic("refs/lib.ts", "export function widget() { return 1; }\n");
    await ctx.fs.writeAtomic("refs/use.ts", "import { widget } from './lib';\nconst x = widget();\nconst y = widget();\n");
    await ctx.fs.writeAtomic("refs/other.ts", "const widgetage = 2;\nconst sprocket = widget;\n");
    const refsPlugin = findReferencesPlugin();
    await refsPlugin.init?.(ctx);
    const fr = tool(refsPlugin, "find_references");

    const r1 = await fr.handler({ symbol: "widget", path: "refs" });
    const r1t = textOf(r1);
    check("find_references finds the definition", !r1.isError && r1t.includes("refs/lib.ts:1") && r1t.includes("function widget"));
    check("find_references finds usages", r1t.includes("refs/use.ts:1:") && r1t.includes("refs/use.ts:2:") && r1t.includes("refs/use.ts:3:"));
    check("find_references uses identifier boundaries (no 'widgetage')", !r1t.includes("widgetage = 2"));
    check("find_references excludes the def line from references", !/References[\s\S]*refs\/lib\.ts:1:/.test(r1t));

    const r2 = await fr.handler({ symbol: "nonexistentSymbolXYZ", path: "refs" });
    check("find_references handles no matches", textOf(r2).includes("No definitions or references"));

    const r3 = await fr.handler({ symbol: "WIDGET", path: "refs", caseInsensitive: true });
    check("find_references case-insensitive", textOf(r3).includes("refs/lib.ts:1"));

    // --- grep_context plugin --------------------------------------------
    await ctx.fs.writeAtomic("gc/svc.ts", "export class Svc {\n  start() {\n    return doThing();\n  }\n  stop() {\n    return 0;\n  }\n}\nfunction doThing() { return 42; }\n");
    const gcPlugin = grepContextPlugin();
    await gcPlugin.init?.(ctx);
    const gc = tool(gcPlugin, "grep_context");

    const g1 = await gc.handler({ pattern: "doThing", path: "gc" });
    const g1t = textOf(g1);
    check("grep_context returns enclosing symbols", !g1.isError && g1t.includes("gc/svc.ts › method Svc.start") && g1t.includes("gc/svc.ts › function doThing"));
    check("grep_context marks matched lines", g1t.includes("›") && g1t.includes("return doThing();"));
    check("grep_context excludes unrelated symbols", !g1t.includes("Svc.stop"));
    check("grep_context no match", textOf(await gc.handler({ pattern: "zzznope", path: "gc" })).includes("No matches"));
    check("grep_context invalid regex", (await gc.handler({ pattern: "(", path: "gc" })).isError === true);

    // --- symbol_find plugin ---------------------------------------------
    await ctx.fs.writeAtomic("sf/auth.ts", "export class AuthService {\n  login() {}\n  logout() {}\n}\nexport function authenticate() {}\nexport const helper = () => 0;\n");
    const sfPlugin = symbolFindPlugin();
    await sfPlugin.init?.(ctx);
    const sf = tool(sfPlugin, "symbol_find");
    const sfExact = await sf.handler({ name: "AuthService", path: "sf" });
    check("symbol_find exact match", !sfExact.isError && textOf(sfExact).includes("sf/auth.ts:1") && textOf(sfExact).includes("class AuthService"));
    const sfSub = textOf(await sf.handler({ name: "auth", path: "sf", substring: true, caseInsensitive: true }));
    check("symbol_find substring match", sfSub.includes("AuthService") && sfSub.includes("authenticate") && !sfSub.includes("helper"));
    check("symbol_find exact excludes substrings", textOf(await sf.handler({ name: "auth", path: "sf" })).includes("No symbol"));
    const sfKind = textOf(await sf.handler({ name: "auth", path: "sf", substring: true, kind: "function" }));
    check("symbol_find kind filter", sfKind.includes("authenticate") && !sfKind.includes("class AuthService"));
    check("symbol_find no match", textOf(await sf.handler({ name: "zzznope", path: "sf" })).includes("No symbol"));

    // --- call_sites plugin ----------------------------------------------
    await ctx.fs.writeAtomic("cs/lib.ts", "export function doThing() { return 1; }\n");
    await ctx.fs.writeAtomic("cs/use.ts", "import { doThing } from './lib';\nfunction run() {\n  const f: typeof doThing = doThing;\n  return doThing();\n}\n// doThing in a comment\n");
    await ctx.fs.writeAtomic("cs/m2.ts", "class S { greet() { return 'hi'; } }\nconst s = new S();\ns.greet();\n");
    const callsPl = callSitesPlugin();
    await callsPl.init?.(ctx);
    const calls = tool(callsPl, "call_sites");
    const callsRes = textOf(await calls.handler({ symbol: "doThing", path: "cs" }));
    check("call_sites finds the call, not import/type/comment/value-ref",
      callsRes.includes("cs/use.ts:4") && callsRes.includes("run") && !callsRes.includes("use.ts:1") && !callsRes.includes("use.ts:3") && !callsRes.includes("use.ts:6"));
    check("call_sites finds a method call via member access", textOf(await calls.handler({ symbol: "greet", path: "cs" })).includes("cs/m2.ts:3"));
    check("call_sites reports none cleanly", textOf(await calls.handler({ symbol: "zzzNope", path: "cs" })).includes("No call sites"));
    await ctx.fs.writeAtomic("csj/data.json", '{"a":1}\n');
    check("call_sites notes unsupported language", textOf(await calls.handler({ symbol: "x", path: "csj" })).includes("No call-site analysis"));
    // adversarial-review fix: computed/subscript calls obj[key]() are not false hits for `key`
    await ctx.fs.writeAtomic("cs/sub.ts", "const key = 'm';\nconst obj: Record<string, () => void> = {};\nobj[key]();\n");
    check("call_sites ignores computed/subscript calls", !textOf(await calls.handler({ symbol: "key", path: "cs" })).includes("cs/sub.ts:3"));

    // --- marker_inventory plugin ----------------------------------------
    await ctx.fs.writeAtomic("mk/a.ts", "// TODO: refactor this\nconst x = 1; // FIXME later\nfunction f() {} // not a marker\nconst TODOLIST = []; // a list, the word todo appears\n");
    await ctx.fs.writeAtomic("mk/b.py", "# HACK: temporary\nx = 1\n");
    const mkPl = markerInventoryPlugin();
    await mkPl.init?.(ctx);
    const mk = tool(mkPl, "marker_inventory");
    const mkRes = textOf(await mk.handler({ path: "mk" }));
    check("marker_inventory groups TODO/FIXME/HACK", mkRes.includes("TODO (1)") && mkRes.includes("refactor this") && mkRes.includes("FIXME (1)") && mkRes.includes("HACK (1)") && mkRes.includes("mk/b.py:1"));
    check("marker_inventory ignores prose/non-comment", !mkRes.includes("a list, the word"));
    const mkHack = textOf(await mk.handler({ path: "mk", tags: ["HACK"] }));
    check("marker_inventory custom tags", mkHack.includes("HACK (1)") && !mkHack.includes("TODO ("));
    check("marker_inventory none", textOf(await mk.handler({ path: "mk", tags: ["NOPEMARK"] })).includes("No markers"));

    // --- trace_locate plugin --------------------------------------------
    await ctx.fs.writeAtomic("tl/app.ts", "export function boom() {\n  throw new Error('x');\n}\n");
    const tlPlugin = traceLocatePlugin();
    await tlPlugin.init?.(ctx);
    const tl = tool(tlPlugin, "trace_locate");
    const trace = "Error: x\n    at boom (tl/app.ts:2:9)\n    at Object.<anonymous> (/external/node_modules/foo/index.js:99:1)\n";
    const tlRes = textOf(await tl.handler({ trace }));
    check("trace_locate resolves workspace frames", tlRes.includes("tl/app.ts:2") && tlRes.includes("throw new Error") && tlRes.includes("boom"));
    check("trace_locate skips external frames", !tlRes.includes("node_modules/foo"));
    check("trace_locate none when no workspace paths", textOf(await tl.handler({ trace: "at x (/nowhere/abc.js:1:1)" })).includes("No workspace source"));

    // --- import_map plugin ----------------------------------------------
    await ctx.fs.writeAtomic("im/b.ts", "export const b = 2;\n");
    await ctx.fs.writeAtomic("im/a.ts", 'import { b } from "./b.js";\nimport fs from "node:fs";\nexport const a = b + Number(fs);\n');
    await ctx.fs.writeAtomic("im/c.ts", 'import { b } from "./b.js";\nexport const c = b;\n');
    const imPl = importMapPlugin();
    await imPl.init?.(ctx);
    const im = tool(imPl, "import_map");
    const imImports = textOf(await im.handler({ path: "im/a.ts", direction: "imports" }));
    check("import_map lists imports (workspace + external)", imImports.includes("./b.js") && imImports.includes("im/b") && imImports.includes("node:fs") && imImports.includes("[external]"));
    const imImporters = textOf(await im.handler({ path: "im/b.ts", direction: "importers" }));
    check("import_map finds importers", imImporters.includes("im/a.ts:1") && imImporters.includes("im/c.ts:1") && imImporters.includes("importers (2)"));
    check("import_map both directions", textOf(await im.handler({ path: "im/a.ts" })).includes("imports (") && textOf(await im.handler({ path: "im/a.ts" })).includes("importers"));

    // --- type_closure plugin --------------------------------------------
    await ctx.fs.writeAtomic("tc/types.ts", "export interface Coord { v: number; }\nexport interface Point { c: Coord; }\nexport interface Shape { p: Point; }\n");
    const tcPl = typeClosurePlugin();
    await tcPl.init?.(ctx);
    const tc = tool(tcPl, "type_closure");
    const tcDeep = textOf(await tc.handler({ symbol: "Shape", path: "tc", maxDepth: 2 }));
    check("type_closure pulls referenced types transitively", tcDeep.includes("interface Shape") && tcDeep.includes("interface Point") && tcDeep.includes("interface Coord"));
    const tcShallow = textOf(await tc.handler({ symbol: "Shape", path: "tc", maxDepth: 1 }));
    check("type_closure respects maxDepth", tcShallow.includes("interface Point") && !tcShallow.includes("interface Coord"));
    check("type_closure unknown type errors", (await tc.handler({ symbol: "NopeType", path: "tc" })).isError === true);

    // --- call_hierarchy plugin ------------------------------------------
    await ctx.fs.writeAtomic("ch/lib.ts", "export function helper() { return 1; }\nexport function other() { return 2; }\nexport function target() {\n  return helper() + other();\n}\n");
    await ctx.fs.writeAtomic("ch/use.ts", "function run() {\n  return target() + 1;\n}\n");
    const chPl = callHierarchyPlugin();
    await chPl.init?.(ctx);
    const ch = tool(chPl, "call_hierarchy");
    const chRes = textOf(await ch.handler({ symbol: "target", path: "ch" }));
    check("call_hierarchy lists callees with their defs", chRes.includes("callees (2)") && chRes.includes("helper") && chRes.includes("other") && chRes.includes("ch/lib.ts"));
    check("call_hierarchy lists callers with enclosing symbol", chRes.includes("callers (1") && chRes.includes("ch/use.ts:2") && chRes.includes("run"));
    check("call_hierarchy unknown symbol errors", (await ch.handler({ symbol: "nopeFn", path: "ch" })).isError === true);
    check("call_hierarchy discloses a callee cap with +", textOf(await ch.handler({ symbol: "target", path: "ch", headLimit: 1 })).includes("callees (2+)"));

    // --- move_symbol plugin ---------------------------------------------
    await ctx.fs.writeAtomic("ms/a.ts", "export function moved() {\n  return 1;\n}\nexport function stays() {\n  return moved() + 1;\n}\n");
    await ctx.fs.writeAtomic("ms/b.ts", "export const existing = 0;\n");
    await ctx.fs.writeAtomic("ms/c.ts", 'import { moved } from "./a.js";\nexport const usesIt = moved();\n');
    const msPl = moveSymbolPlugin();
    await msPl.init?.(ctx);
    const ms = tool(msPl, "move_symbol");
    const msDry = textOf(await ms.handler({ symbol: "moved", from: "ms/a.ts", to: "ms/b.ts", dryRun: true }));
    check("move_symbol dryRun writes nothing", msDry.includes("DRY RUN") && (await ctx.fs.read("ms/b.ts")).content === "export const existing = 0;\n");
    const moveRes = await ms.handler({ symbol: "moved", from: "ms/a.ts", to: "ms/b.ts" });
    const aAfter = (await ctx.fs.read("ms/a.ts")).content;
    const bAfter = (await ctx.fs.read("ms/b.ts")).content;
    const cAfter = (await ctx.fs.read("ms/c.ts")).content;
    check("move_symbol relocates the definition", !moveRes.isError && !aAfter.includes("function moved()") && bAfter.includes("function moved()") && bAfter.includes("existing"));
    check("move_symbol re-imports into source with the .js extension when still used", aAfter.includes('import { moved } from "./b.js"'));
    check("move_symbol rewrites named importers", cAfter.includes('from "./b.js"') && !cAfter.includes('from "./a.js"'));
    check("move_symbol unknown symbol errors", (await ms.handler({ symbol: "nopeSym", from: "ms/a.ts", to: "ms/b.ts" })).isError === true);
    // adversarial-review fix: a same-named import of a different (dotted) module is not rewritten
    await ctx.fs.writeAtomic("ms2/config.ts", "export function cfg() { return 1; }\n");
    await ctx.fs.writeAtomic("ms2/config.local.ts", "export function cfg() { return 2; }\n");
    await ctx.fs.writeAtomic("ms2/app.ts", 'import { cfg } from "./config.local.js";\nexport const zz = cfg();\n');
    const mv2 = await ms.handler({ symbol: "cfg", from: "ms2/config.ts", to: "ms2/lib.ts" });
    const app2 = (await ctx.fs.read("ms2/app.ts")).content;
    check("move_symbol does not rewrite a same-named import of a different module", !mv2.isError && app2.includes('from "./config.local.js"') && !app2.includes("lib"));
    // adversarial-review fix: BOM preserved in a rewritten importer
    const BOM3 = String.fromCharCode(0xfeff);
    await ctx.fs.writeAtomic("ms3/dep.ts", "export function giz() { return 1; }\n");
    await ctx.fs.writeAtomic("ms3/use.ts", `${BOM3}import { giz } from "./dep.js";\nexport const qq = giz();\n`);
    await ms.handler({ symbol: "giz", from: "ms3/dep.ts", to: "ms3/lib.ts" });
    const use3 = (await ctx.fs.readRaw("ms3/use.ts")).content;
    check("move_symbol preserves BOM in a rewritten importer", use3.charCodeAt(0) === 0xfeff && use3.includes('"./lib'));
    // fix: the destination's imports are REPORTED, not synthesized (synthesizing
    // is bug-prone: non-exported siblings, property accesses, shadowing). Same-file
    // deps are listed; a member access (c.area) must not be reported as a dep.
    await ctx.fs.writeAtomic("ms4/src.ts", "export interface Cfg { n: number }\nexport function helper() { return 7; }\nexport function area() { return 0; }\nexport function feat(c: Cfg) { return helper() + c.n + c.area; }\n");
    await ctx.fs.writeAtomic("ms4/use.ts", 'import { feat } from "./src.js";\nexport const r = feat({ n: 1 });\n');
    const mv4 = await ms.handler({ symbol: "feat", from: "ms4/src.ts", to: "ms4/dest.ts" });
    const mv4t = textOf(mv4);
    const dest4 = (await ctx.fs.read("ms4/dest.ts")).content;
    const use4 = (await ctx.fs.read("ms4/use.ts")).content;
    check("move_symbol reports same-file deps for the destination (no silent omission)", !mv4.isError && mv4t.includes("helper") && mv4t.includes("Cfg"));
    check("move_symbol does not report a member-access name as a dep", !mv4t.includes("area"));
    check("move_symbol does not synthesize the destination's imports", dest4.includes("function feat") && !dest4.includes("import "));
    check("move_symbol rewrites the importer to the new module with .js", use4.includes('from "./dest.js"'));

    // --- code_context plugin --------------------------------------------
    await ctx.fs.writeAtomic("cc/util.ts", "export function helper(x: number): number {\n  return x * 2;\n}\n");
    await ctx.fs.writeAtomic("cc/main.ts", "import { helper } from './util';\nexport function compute(n: number): number {\n  return helper(n) + 1;\n}\n");
    await ctx.fs.writeAtomic("cc/use.ts", "import { compute } from './main';\nconsole.log(compute(5));\n");
    const ccxPlugin = codeContextPlugin();
    await ccxPlugin.init?.(ctx);
    const ccx = tool(ccxPlugin, "code_context");

    const c1 = await ccx.handler({ symbol: "compute", path: "cc" });
    const c1t = textOf(c1);
    check("code_context shows the definition", !c1.isError && c1t.includes("Definition — function compute") && c1t.includes("return helper(n) + 1;"));
    check("code_context lists used workspace symbols", c1t.includes("Uses (") && c1t.includes("function helper(x: number): number"));
    check("code_context lists references", c1t.includes("Referenced from") && c1t.includes("cc/use.ts:2:"));
    check("code_context handles unknown symbol", textOf(await ccx.handler({ symbol: "doesNotExistXYZ", path: "cc" })).includes("no definition"));

    // --- repo_map plugin ------------------------------------------------
    await ctx.fs.writeAtomic("rmap/api.ts", "export class Service {\n  run() {}\n}\nexport function helper() {}\nexport interface Opts { x: number }\n");
    await ctx.fs.writeAtomic("rmap/util/str.ts", "export function trimAll(s: string) { return s.trim(); }\n");
    await ctx.fs.writeAtomic("rmap/data.json", "{ \"a\": 1 }\n");
    const mapPlugin = repoMapPlugin();
    await mapPlugin.init?.(ctx);
    const rm = tool(mapPlugin, "repo_map");

    const m1 = await rm.handler({ path: "rmap" });
    const m1t = textOf(m1);
    check("repo_map lists top-level symbols", !m1.isError && m1t.includes("class Service") && m1t.includes("function helper") && m1t.includes("interface Opts"));
    check("repo_map excludes nested members (no run())", !m1t.includes("run"));
    check("repo_map groups by directory", m1t.includes("rmap/") && m1t.includes("rmap/util/") && m1t.includes("api.ts") && m1t.includes("str.ts"));
    check("repo_map lists non-grammar files bare", /data\.json(?!.*—)/.test(m1t) || (m1t.includes("data.json") && !m1t.includes("data.json —")));
    check("repo_map header reports counts", /repo map — \d+ file\(s\), \d+ top-level symbol/.test(m1t));

    const m2 = await rm.handler({ path: "rmap", maxTokens: 1 });
    check("repo_map respects token budget", textOf(m2).includes("truncated"));
    // fix: a subdirectory whose name sorts between a directory's own files must
    // not cause that directory's header to repeat (rmap/util sorts before zzz.ts).
    await ctx.fs.writeAtomic("rmap/zzz.ts", "export function zzzFn() {}\n");
    const m3t = textOf(await rm.handler({ path: "rmap" }));
    const rmapHeaders = m3t.split("\n").filter((l) => l === "rmap/").length;
    check("repo_map emits each directory header once", rmapHeaders === 1, `headers=${rmapHeaders}`);

    // --- F4: generated-file awareness (code_search / repo_map) ----------
    await ctx.fs.writeAtomic("genf/keep.ts", "export const FINDGENTOKEN = 1;\n");
    await ctx.fs.writeAtomic("genf/skip.min.js", "const FINDGENTOKEN = 2;\n");
    await ctx.fs.writeAtomic("genf/marked.ts", "// @generated\nexport const FINDGENTOKEN = 3;\n");
    const csGenPlugin = codeSearchPlugin();
    await csGenPlugin.init?.(ctx);
    const csGen = tool(csGenPlugin, "code_search");
    const csHidden = textOf(await csGen.handler({ pattern: "FINDGENTOKEN", path: "genf" }));
    check("code_search hides generated (glob + @generated) by default", csHidden.includes("genf/keep.ts") && !csHidden.includes("skip.min.js") && !csHidden.includes("marked.ts") && csHidden.includes("2 generated file(s) hidden"));
    const csInc = textOf(await csGen.handler({ pattern: "FINDGENTOKEN", path: "genf", includeGenerated: true }));
    check("code_search includeGenerated shows generated files", csInc.includes("genf/keep.ts") && csInc.includes("skip.min.js") && csInc.includes("marked.ts"));

    const rmGenPlugin = repoMapPlugin();
    await rmGenPlugin.init?.(ctx);
    const rmGen = tool(rmGenPlugin, "repo_map");
    const rmHidden = textOf(await rmGen.handler({ path: "genf" }));
    check("repo_map hides generated files by default", rmHidden.includes("keep.ts") && !rmHidden.includes("skip.min.js") && !rmHidden.includes("marked.ts") && rmHidden.includes("generated file(s) hidden"));
    const rmInc = textOf(await rmGen.handler({ path: "genf", includeGenerated: true }));
    check("repo_map includeGenerated shows generated files", rmInc.includes("skip.min.js") && rmInc.includes("marked.ts"));
    // adversarial-review fix: only a leading-comment @generated marker counts, not prose/mid-file mentions
    await ctx.fs.writeAtomic("genf/prose.ts", "// This documents the @generated convention; this file is hand-written.\nexport const PROSEGEN = 1;\n");
    await ctx.fs.writeAtomic("genf/midgen.ts", "export const MIDGEN = 1;\n// @generated\n");
    const proseSearch = textOf(await csGen.handler({ pattern: "PROSEGEN", path: "genf" }));
    check("code_search keeps a file that only mentions @generated in prose", proseSearch.includes("genf/prose.ts"));
    const midSearch = textOf(await csGen.handler({ pattern: "MIDGEN", path: "genf" }));
    check("code_search keeps a file with a non-leading @generated", midSearch.includes("genf/midgen.ts"));

    // --- diff_digest plugin ---------------------------------------------
    // Non-repo: the smoke root is not a git repo.
    const ddNonRepo = diffDigestPlugin();
    await ddNonRepo.init?.(ctx);
    check("diff_digest detects non-repo", (await tool(ddNonRepo, "diff_digest").handler({})).isError === true);
    const rbNonRepo = reviewBranchPlugin();
    await rbNonRepo.init?.(ctx);
    check("review_branch detects non-repo", (await tool(rbNonRepo, "review_branch").handler({})).isError === true);

    // Real (isolated) git repo: exercise the success paths.
    const gitRoot = await mkTmp("efficient-token-git-");
    try {
      const g = (a: string[]): Promise<unknown> => execFileP("git", a, { cwd: gitRoot });
      await g(["init", "-q"]);
      await g(["config", "user.email", "t@example.com"]);
      await g(["config", "user.name", "Test"]);
      await g(["config", "commit.gpgsign", "false"]);
      await fsp.writeFile(path.join(gitRoot, "f.ts"), "export const a = 1;\n");
      await g(["add", "f.ts"]);
      await g(["commit", "-q", "-m", "init"]);
      await fsp.writeFile(path.join(gitRoot, "f.ts"), "export const a = 2;\nexport const b = 3;\n");

      const gPaths = new PathSandbox(gitRoot);
      const gctx: CoreContext = {
        ...ctx,
        config: { ...config, root: gitRoot },
        paths: gPaths,
        fs: new SafeFs(gPaths, config.maxFileBytes),
        scan: new Scanner(gPaths),
      };
      const gdd = diffDigestPlugin();
      await gdd.init?.(gctx);
      const dd = tool(gdd, "diff_digest");

      const digestT = textOf(await dd.handler({}));
      check("diff_digest shows changed hunks", digestT.includes("+export const a = 2;") && digestT.includes("+export const b = 3;") && digestT.includes("f.ts"));
      check("diff_digest stat mode", textOf(await dd.handler({ outputMode: "stat" })).includes("f.ts") && textOf(await dd.handler({ outputMode: "stat" })).includes("|"));
      check("diff_digest files mode", /^M\s+f\.ts/m.test(textOf(await dd.handler({ outputMode: "files" }))));
      check("diff_digest invalid ref rejected", (await dd.handler({ ref: "--evil" })).isError === true);

      await g(["add", "f.ts"]);
      check("diff_digest staged mode", textOf(await dd.handler({ staged: true })).includes("+export const b = 3;"));

      // F4: diff_digest hides generated changed files (isolated repo so the
      // sequence above is untouched).
      const genGitRoot = await mkTmp("efficient-token-git-gen-");
      const g2 = (a: string[]): Promise<unknown> => execFileP("git", a, { cwd: genGitRoot });
      await g2(["init", "-q"]);
      await g2(["config", "user.email", "t@example.com"]);
      await g2(["config", "user.name", "Test"]);
      await g2(["config", "commit.gpgsign", "false"]);
      await fsp.writeFile(path.join(genGitRoot, "app.ts"), "export const x = 1;\n");
      await fsp.writeFile(path.join(genGitRoot, "bundle.min.js"), "var a=1;\n");
      await g2(["add", "."]);
      await g2(["commit", "-q", "-m", "init"]);
      await fsp.writeFile(path.join(genGitRoot, "app.ts"), "export const x = 2;\n");
      await fsp.writeFile(path.join(genGitRoot, "bundle.min.js"), "var a=2;\n");
      const genPaths = new PathSandbox(genGitRoot);
      const genctx: CoreContext = { ...ctx, config: { ...config, root: genGitRoot }, paths: genPaths, fs: new SafeFs(genPaths, config.maxFileBytes), scan: new Scanner(genPaths) };
      const ddGenPlugin = diffDigestPlugin();
      await ddGenPlugin.init?.(genctx);
      const ddGen = tool(ddGenPlugin, "diff_digest");
      const ddGenOut = textOf(await ddGen.handler({}));
      check("diff_digest hides generated changed files by default", ddGenOut.includes("app.ts") && !ddGenOut.includes("bundle.min.js") && ddGenOut.includes("generated file(s) hidden"));
      const ddGenInc = textOf(await ddGen.handler({ includeGenerated: true }));
      check("diff_digest includeGenerated shows generated changes", ddGenInc.includes("bundle.min.js"));

      // F5: test_run changed — select & run only tests affected by the diff (isolated repo)
      const tsGitRoot = await mkTmp("efficient-token-git-tr-");
      const g3 = (a: string[]): Promise<unknown> => execFileP("git", a, { cwd: tsGitRoot });
      await g3(["init", "-q"]);
      await g3(["config", "user.email", "t@example.com"]);
      await g3(["config", "user.name", "Test"]);
      await g3(["config", "commit.gpgsign", "false"]);
      await fsp.writeFile(path.join(tsGitRoot, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { t: 'node -e "process.exit(0)"' } }));
      await fsp.mkdir(path.join(tsGitRoot, "src"), { recursive: true });
      await fsp.writeFile(path.join(tsGitRoot, "src", "calc.ts"), "export function calc() {\n  return 1;\n}\n");
      await fsp.writeFile(path.join(tsGitRoot, "src", "calc.test.ts"), "import { calc } from './calc.js';\nit('calc', () => { calc(); });\n");
      await fsp.writeFile(path.join(tsGitRoot, "src", "util.test.ts"), "it('util', () => {});\n");
      await fsp.writeFile(path.join(tsGitRoot, "src", "lonely.test.ts"), "it('lonely', () => {});\n");
      await fsp.writeFile(path.join(tsGitRoot, "src", "calc$weird.test.ts"), "import { calc } from './calc.js';\nit('w', () => { calc(); });\n");
      await g3(["add", "."]);
      await g3(["commit", "-q", "-m", "init"]);
      await fsp.writeFile(path.join(tsGitRoot, "src", "calc.ts"), "export function calc() {\n  return 2;\n}\n");
      await fsp.writeFile(path.join(tsGitRoot, "src", "util.test.ts"), "it('util', () => { return 1; });\n");
      const trPaths = new PathSandbox(tsGitRoot);
      const trctx: CoreContext = { ...ctx, config: { ...config, root: tsGitRoot }, paths: trPaths, fs: new SafeFs(trPaths, config.maxFileBytes), scan: new Scanner(trPaths) };
      const trcPlugin = testRunPlugin();
      await trcPlugin.init?.(trctx);
      const trc = tool(trcPlugin, "test_run");
      const trChanged = textOf(await trc.handler({ script: "t", changed: true }));
      check(
        "test_run changed selects changed + importing tests, excludes unrelated",
        trChanged.includes("src/calc.test.ts") && trChanged.includes("src/util.test.ts") && !trChanged.includes("lonely.test.ts") && trChanged.includes("passed"),
      );
      // adversarial-review fix: an affected test with a shell-unsafe path is reported, never silently dropped
      check(
        "test_run changed reports shell-unsafe affected paths instead of dropping them silently",
        trChanged.includes("NOT run") && trChanged.includes("calc$weird.test.ts"),
      );
      await g3(["add", "."]);
      await g3(["commit", "-q", "-m", "commit changes"]);
      const trNone = textOf(await trc.handler({ script: "t", changed: true }));
      check("test_run changed reports nothing when the tree is clean", trNone.includes("no uncommitted changes"));

      // F5: the no-HEAD (fresh repo, no commits) path selects untracked affected tests
      const freshRoot = await mkTmp("efficient-token-git-fresh-");
      const gf = (a: string[]): Promise<unknown> => execFileP("git", a, { cwd: freshRoot });
      await gf(["init", "-q"]);
      await gf(["config", "user.email", "t@example.com"]);
      await gf(["config", "user.name", "Test"]);
      await fsp.writeFile(path.join(freshRoot, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { t: 'node -e "process.exit(0)"' } }));
      await fsp.mkdir(path.join(freshRoot, "src"), { recursive: true });
      await fsp.writeFile(path.join(freshRoot, "src", "x.ts"), "export function x() {\n  return 1;\n}\n");
      await fsp.writeFile(path.join(freshRoot, "src", "x.test.ts"), "import { x } from './x.js';\nit('x', () => { x(); });\n");
      const freshPaths = new PathSandbox(freshRoot);
      const freshCtx: CoreContext = { ...ctx, config: { ...config, root: freshRoot }, paths: freshPaths, fs: new SafeFs(freshPaths, config.maxFileBytes), scan: new Scanner(freshPaths) };
      const trFreshPlugin = testRunPlugin();
      await trFreshPlugin.init?.(freshCtx);
      const trFresh = textOf(await tool(trFreshPlugin, "test_run").handler({ script: "t", changed: true }));
      check("test_run changed selects affected tests in a fresh repo (no HEAD)", trFresh.includes("src/x.test.ts") && trFresh.includes("passed"));
      // parsePorcelain: status-code slice + rename arrow extraction
      check(
        "parsePorcelain extracts paths including renames",
        JSON.stringify(parsePorcelain(" M src/a.ts\nA  src/b.ts\n?? src/c.ts\nR  old.ts -> new.ts\n")) === JSON.stringify(["src/a.ts", "src/b.ts", "src/c.ts", "new.ts"]),
      );

      // review_branch: map changes to symbols
      await fsp.writeFile(path.join(gitRoot, "mod.ts"), "export function alpha() {\n  return 1;\n}\nexport function beta() {\n  return 2;\n}\n");
      await g(["add", "mod.ts"]);
      await g(["commit", "-q", "-m", "add mod"]);
      await fsp.writeFile(path.join(gitRoot, "mod.ts"), "export function alpha() {\n  return 100;\n}\nexport function beta() {\n  return 2;\n}\n");
      const rbPlugin = reviewBranchPlugin();
      await rbPlugin.init?.(gctx);
      const rbt = textOf(await tool(rbPlugin, "review_branch").handler({}));
      check("review_branch maps changes to symbols", rbt.includes("mod.ts") && rbt.includes("~ function alpha") && !rbt.includes("~ function beta"));

      // read_at_rev: historical code_read (HEAD has f.ts=a2/b3 and mod.ts alpha=1; working tree has alpha=100)
      const rarPlugin = readAtRevPlugin();
      await rarPlugin.init?.(gctx);
      const rar = tool(rarPlugin, "read_at_rev");
      const rarHead = textOf(await rar.handler({ path: "f.ts", ref: "HEAD" }));
      check("read_at_rev reads whole file at HEAD", rarHead.includes("export const a = 2;") && rarHead.includes("export const b = 3;") && rarHead.includes("@"));
      const rarOld = textOf(await rar.handler({ path: "f.ts", ref: "HEAD~1" }));
      check("read_at_rev reads an older revision", rarOld.includes("export const a = 1;") && !rarOld.includes("b = 3"));
      const rarSym = textOf(await rar.handler({ path: "mod.ts", ref: "HEAD", symbol: "alpha" }));
      check("read_at_rev reads a symbol from the committed rev (not working tree)", rarSym.includes("return 1;") && !rarSym.includes("return 100;"));
      check("read_at_rev invalid ref rejected", (await rar.handler({ path: "f.ts", ref: "--evil" })).isError === true);
      check("read_at_rev missing path at rev errors", (await rar.handler({ path: "nope.ts", ref: "HEAD" })).isError === true);

      // symbol_history: git log -L for one symbol (commit alpha=100, giving 2 commits touching alpha)
      await g(["commit", "-q", "-am", "bump alpha"]);
      const shPlugin = symbolHistoryPlugin();
      await shPlugin.init?.(gctx);
      const sh = tool(shPlugin, "symbol_history");
      const shList = textOf(await sh.handler({ path: "mod.ts", symbol: "alpha" }));
      check("symbol_history list shows commits touching the symbol", shList.includes("add mod") && shList.includes("bump alpha") && shList.includes("function alpha"));
      const shHunks = textOf(await sh.handler({ path: "mod.ts", symbol: "alpha", mode: "hunks" }));
      check("symbol_history hunks shows the per-revision diff", shHunks.includes("return 100") && shHunks.includes("commit "));
      check("symbol_history range mode works", !(await sh.handler({ path: "mod.ts", startLine: 1, endLine: 3 })).isError);
      check("symbol_history invalid ref rejected", (await sh.handler({ path: "mod.ts", symbol: "alpha", ref: "--evil" })).isError === true);
      check("symbol_history unknown symbol errors", (await sh.handler({ path: "mod.ts", symbol: "zzz" })).isError === true);

      // change_coverage: intersect changed lines with an lcov artifact
      await fsp.writeFile(path.join(gitRoot, "cov.ts"), "export function covered() {\n  return 1;\n}\nexport function uncovered() {\n  return 2;\n}\n");
      await g(["add", "cov.ts"]);
      await g(["commit", "-q", "-m", "add cov"]);
      await fsp.writeFile(path.join(gitRoot, "cov.ts"), "export function covered() {\n  return 11;\n}\nexport function uncovered() {\n  return 22;\n}\n");
      await fsp.mkdir(path.join(gitRoot, "coverage"), { recursive: true });
      await fsp.writeFile(path.join(gitRoot, "coverage", "lcov.info"), "SF:cov.ts\nDA:2,3\nDA:5,0\nend_of_record\n");
      const chgCovPlugin = changeCoveragePlugin();
      await chgCovPlugin.init?.(gctx);
      const chc = tool(chgCovPlugin, "change_coverage");
      const chcT = textOf(await chc.handler({}));
      check("change_coverage flags covered vs uncovered changed lines", chcT.includes("cov.ts:5") && chcT.includes("uncovered") && chcT.includes("1/2") && chcT.includes("function uncovered"));
      check("change_coverage missing artifact errors", (await chc.handler({ artifact: "nope/lcov.info" })).isError === true);
      // adversarial-review fix: a cross-root/absolute lcov SF path matches by trailing-segment
      await fsp.writeFile(path.join(gitRoot, "coverage", "abs.info"), "SF:/ci/build/cov.ts\nDA:2,4\nDA:5,0\nend_of_record\n");
      const chcAbs = textOf(await chc.handler({ artifact: "coverage/abs.info" }));
      check("change_coverage matches absolute/cross-root lcov SF by suffix", chcAbs.includes("cov.ts:5") && chcAbs.includes("1/2"));

      // commit_log: compact history
      const clPlugin = commitLogPlugin();
      await clPlugin.init?.(gctx);
      const cl = tool(clPlugin, "commit_log");
      const clt = textOf(await cl.handler({}));
      check("commit_log lists commits", clt.includes("init") && clt.includes("add cov") && clt.includes("commit(s)"));
      check("commit_log path scope", textOf(await cl.handler({ path: "mod.ts" })).includes("add mod"));
      check("commit_log limit caps", textOf(await cl.handler({ limit: 1 })).includes("— 1 commit(s)"));
      check("commit_log invalid ref rejected", (await cl.handler({ ref: "--evil" })).isError === true);

      // line_blame: provenance with collapsed runs
      const lbPlugin = lineBlamePlugin();
      await lbPlugin.init?.(gctx);
      const lb = tool(lbPlugin, "line_blame");
      const lbWhole = textOf(await lb.handler({ path: "mod.ts" }));
      check("line_blame collapses runs with author/date/summary",
        lbWhole.includes("Test") && /\d{4}-\d{2}-\d{2}/.test(lbWhole) && (lbWhole.includes("bump alpha") || lbWhole.includes("add mod")) && lbWhole.includes("run(s)"));
      const lbSym = textOf(await lb.handler({ path: "mod.ts", symbol: "alpha" }));
      check("line_blame scopes to a symbol", lbSym.includes("function alpha") && lbSym.includes("bump alpha"));
      await fsp.writeFile(path.join(gitRoot, "mod.ts"), "export function alpha() {\n  return 999;\n}\nexport function beta() {\n  return 2;\n}\n");
      check("line_blame marks uncommitted lines", textOf(await lb.handler({ path: "mod.ts", startLine: 2, endLine: 2 })).includes("uncommitted"));

      // outline_diff: symbol-level rev-to-rev delta (HEAD vs working tree)
      await fsp.writeFile(path.join(gitRoot, "mod.ts"), "export function alpha() {\n  return 999;\n}\nexport function gamma() {\n  return 7;\n}\n");
      const odPlugin = outlineDiffPlugin();
      await odPlugin.init?.(gctx);
      const od = tool(odPlugin, "outline_diff");
      const odRes = textOf(await od.handler({ ref: "HEAD" }));
      check("outline_diff classifies added/removed/changed",
        odRes.includes("mod.ts") && odRes.includes("~ changed: function alpha") && odRes.includes("- removed: function beta") && odRes.includes("+ added: function gamma"));
      check("outline_diff invalid ref rejected", (await od.handler({ ref: "--evil" })).isError === true);
      // adversarial-review fix: a change to the SECOND of two same-keyed (overload) defs is detected
      await fsp.writeFile(path.join(gitRoot, "dup.ts"), "export function dup() {\n  return 1;\n}\nexport function dup() {\n  return 2;\n}\n");
      await g(["add", "dup.ts"]);
      await g(["commit", "-q", "-m", "add dup"]);
      await fsp.writeFile(path.join(gitRoot, "dup.ts"), "export function dup() {\n  return 1;\n}\nexport function dup() {\n  return 22;\n}\n");
      check("outline_diff detects a change in a duplicate-keyed (overload) symbol", textOf(await od.handler({ ref: "HEAD" })).includes("~ changed: function dup"));
    } finally {
      await fsp.rm(gitRoot, { recursive: true, force: true });
    }

    // --- conflict_digest plugin (isolated repo with a real merge conflict)
    const conflictRoot = await mkTmp("efficient-token-conflict-");
    try {
      const gc = (a: string[]): Promise<unknown> => execFileP("git", a, { cwd: conflictRoot });
      await gc(["init", "-q"]);
      await gc(["config", "user.email", "t@example.com"]);
      await gc(["config", "user.name", "Test"]);
      await gc(["config", "commit.gpgsign", "false"]);
      await fsp.writeFile(path.join(conflictRoot, "c.txt"), "top\nMIDDLE\nbottom\n");
      await gc(["add", "c.txt"]);
      await gc(["commit", "-q", "-m", "base"]);
      await gc(["checkout", "-q", "-b", "other"]);
      // theirs side deliberately contains a "=======" content line (a marker-looking
      // line) to prove the parser does not drop it as a separator.
      await fsp.writeFile(path.join(conflictRoot, "c.txt"), "top\ntheirs-mid\n=======\nmore\nbottom\n");
      await gc(["commit", "-q", "-am", "theirs"]);
      await gc(["checkout", "-q", "-"]);
      await fsp.writeFile(path.join(conflictRoot, "c.txt"), "top\nours-mid\nbottom\n");
      await gc(["commit", "-q", "-am", "ours"]);
      try {
        await gc(["merge", "other"]);
      } catch {
        /* merge conflict expected (non-zero exit) */
      }

      const ccPaths = new PathSandbox(conflictRoot);
      const ccCtx: CoreContext = {
        ...ctx,
        config: { ...config, root: conflictRoot },
        paths: ccPaths,
        fs: new SafeFs(ccPaths, config.maxFileBytes),
        scan: new Scanner(ccPaths),
      };
      const cdPlugin = conflictDigestPlugin();
      await cdPlugin.init?.(ccCtx);
      const cd = tool(cdPlugin, "conflict_digest");
      const cdt = textOf(await cd.handler({}));
      check("conflict_digest lists conflicted files", cdt.includes("c.txt") && cdt.includes("conflict(s)"));
      check("conflict_digest shows ours and theirs verbatim", cdt.includes("ours-mid") && cdt.includes("theirs-mid") && cdt.includes("--- ours ---") && cdt.includes("--- theirs ---"));
      check("conflict_digest preserves a marker-looking content line in theirs", cdt.includes("=======") && cdt.includes("more"));
      await gc(["merge", "--abort"]);
      check("conflict_digest reports none when clean", textOf(await cd.handler({})).includes("No unresolved merge conflicts"));
    } finally {
      await fsp.rm(conflictRoot, { recursive: true, force: true });
    }

    // --- code_check plugin ----------------------------------------------
    // No package.json at the smoke root -> graceful error.
    const ccNo = codeCheckPlugin();
    await ccNo.init?.(ctx);
    check("code_check needs package.json", (await tool(ccNo, "code_check").handler({ script: "test" })).isError === true);

    // --- run-script utilities (boundedTail / killTree): degrade and best-effort
    // cleanup must never drop all output or crash the process. ---
    {
      const huge = "x".repeat(100000);
      const tail = boundedTail(huge, 6000); // budget 24000
      check(
        "boundedTail keeps a faithful tail of a single over-budget line",
        tail.length > 1000 && !tail.includes("last 0 of") && /x{500,}/.test(tail),
        `${tail.length} chars`,
      );
      const mixed = `ERROR: boom\nat foo.ts:1\n${"y".repeat(100000)}`;
      const mt = boundedTail(mixed, 6000);
      check(
        "boundedTail keeps content when the last line is over budget",
        mt.length > 1000 && !mt.includes("last 0 of") && /y{500,}/.test(mt),
      );
      check("boundedTail returns short output unchanged", boundedTail("line1\nline2\nline3", 6000) === "line1\nline2\nline3");
      check("boundedTail reports empty output", boundedTail("   \n  ", 6000) === "(no output)");
      // A long emoji line must produce a well-formed tail (no lone surrogate half).
      const et = boundedTail("😀".repeat(20000), 1000);
      const body = et.split("\n").slice(1).join("\n");
      check(
        "boundedTail tail is well-formed UTF-16 (no split surrogate)",
        body.length > 0 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body),
      );

      // killTree is best-effort cleanup: a bogus pid must never throw or crash.
      killTree(2147483646, process.platform === "win32");
      // The hazard it guards: spawning a missing binary emits an ASYNC "error"
      // event (not a throw); killTree must attach a listener so it can't become an
      // uncaughtException. Confirm the event is emitted and catchable here.
      const { spawn } = await import("node:child_process");
      const caught = await new Promise<boolean>((res) => {
        const c = spawn("efftoken_no_such_binary_xyz", ["/T", "/F"], { windowsHide: true });
        c.on("error", () => res(true));
        setTimeout(() => res(false), 2000);
      });
      check("killTree survived a bogus pid and missing-binary spawn emits a catchable async error", caught);
    }

    const checkRoot = await mkTmp("efficient-token-check-");
    try {
      const pkg = {
        name: "t",
        version: "1.0.0",
        scripts: {
          ok: 'node -e "process.exit(0)"',
          bad: "node -e \"console.error('boomtoken123'); process.exit(3)\"",
          sleep: 'node -e "setTimeout(() => {}, 30000)"',
          failloc: "node -e \"console.error('src.ts:2:21 - error TS2322: bad type'); process.exit(1)\"",
          longout: "node -e \"console.error('x.'.repeat(60000)); console.error('src.ts:3:1 - err'); process.exit(1)\"",
          bigfail: "node -e \"process.stderr.write('E'.repeat(100000)); process.exit(1)\"",
          needsfilter: "node -e \"process.exit(process.argv[1] === 'wanted' ? 0 : 1)\"",
        },
      };
      await fsp.writeFile(path.join(checkRoot, "package.json"), JSON.stringify(pkg, null, 2));
      await fsp.writeFile(path.join(checkRoot, "src.ts"), "export function broken() {\n  const x: number = 'oops';\n  return x;\n}\n");
      const cPaths = new PathSandbox(checkRoot);
      const cctx: CoreContext = {
        ...ctx,
        config: { ...config, root: checkRoot },
        paths: cPaths,
        fs: new SafeFs(cPaths, config.maxFileBytes),
        scan: new Scanner(cPaths),
      };
      const ccp = codeCheckPlugin();
      await ccp.init?.(cctx);
      const cc = tool(ccp, "code_check");

      const okRes = await cc.handler({ script: "ok" });
      check("code_check pass is terse", !okRes.isError && textOf(okRes).includes("✓ ok: passed (exit 0") && !textOf(okRes).includes("boom"));
      const badRes = await cc.handler({ script: "bad" });
      check("code_check failure shows exit + output", !badRes.isError && textOf(badRes).includes("✗ bad: FAILED (exit ") && textOf(badRes).includes("boomtoken123"));
      const bigRes = await cc.handler({ script: "bigfail" });
      const bigText = textOf(bigRes);
      check(
        "code_check shows a real tail when a failure is one over-budget line",
        !bigRes.isError && bigText.includes("✗ bigfail: FAILED") && /E{500,}/.test(bigText) && !bigText.includes("last 0 of"),
      );
      const missing = await cc.handler({ script: "nope" });
      check("code_check missing script lists available", missing.isError === true && textOf(missing).includes("Available: ok, bad"));
      const unsafe = await cc.handler({ script: "a b; rm -rf /" });
      check("code_check rejects unsafe script name", unsafe.isError === true && textOf(unsafe).includes("invalid script name"));

      // F6: apply_patch can run a package.json check after applying, riding the result
      const apChk = applyPatchPlugin();
      await apChk.init?.(cctx);
      const ap6 = tool(apChk, "apply_patch");
      await cctx.fs.writeAtomic("patchme.txt", "alpha\n");
      const apOk = await ap6.handler({ edits: [{ file_path: "patchme.txt", old_string: "alpha", new_string: "beta" }], check: "ok" });
      check("apply_patch runs a passing post-edit check", !apOk.isError && textOf(apOk).includes("Applied 1") && textOf(apOk).includes("post-edit check") && textOf(apOk).includes("✓ ok: passed"));
      const apBad = await ap6.handler({ edits: [{ file_path: "patchme.txt", old_string: "beta", new_string: "gamma" }], check: "bad" });
      check("apply_patch reports a failing check but still applies", !apBad.isError && (await cctx.fs.read("patchme.txt")).content === "gamma\n" && textOf(apBad).includes("✗ bad: FAILED"));
      const apBadName = await ap6.handler({ edits: [{ file_path: "patchme.txt", old_string: "gamma", new_string: "delta" }], check: "nope" });
      check("apply_patch with an unknown check still applies and notes it", !apBadName.isError && (await cctx.fs.read("patchme.txt")).content === "delta\n" && textOf(apBadName).includes("no npm script"));

      const t0 = Date.now();
      const timed = await cc.handler({ script: "sleep", timeoutMs: 800 });
      check(
        "code_check kills timed-out script promptly",
        timed.isError === true && textOf(timed).includes("timed out") && Date.now() - t0 < 15_000,
        `${Date.now() - t0}ms`,
      );

      // check_locate: run + jump to the failing source
      const clPlugin = checkLocatePlugin();
      await clPlugin.init?.(cctx);
      const cl = tool(clPlugin, "check_locate");
      check("check_locate pass is terse", textOf(await cl.handler({ script: "ok" })).includes("✓ ok: passed"));
      const clt = textOf(await cl.handler({ script: "failloc" }));
      check("check_locate shows the failing source", clt.includes("✗ failloc: FAILED") && clt.includes("src.ts:2") && clt.includes("const x: number = 'oops';"));
      check("check_locate marks error line + enclosing symbol", clt.includes("›") && clt.includes("in function broken"));
      const clT0 = Date.now();
      const clLong = textOf(await cl.handler({ script: "longout" }));
      check("check_locate is ReDoS-safe on long output lines", clLong.includes("✗ longout: FAILED") && clLong.includes("src.ts:3") && Date.now() - clT0 < 10_000, `${Date.now() - clT0}ms`);

      // test_run: filter passthrough + injection rejection
      const trPlugin = testRunPlugin();
      await trPlugin.init?.(cctx);
      const tr = tool(trPlugin, "test_run");
      check("test_run forwards filter (match -> pass)", textOf(await tr.handler({ script: "needsfilter", filter: "wanted" })).includes("passed"));
      check("test_run forwards filter (mismatch -> fail)", textOf(await tr.handler({ script: "needsfilter", filter: "other" })).includes("FAILED"));
      check("test_run rejects metacharacters in filter", (await tr.handler({ script: "ok", filter: "x; echo HACKED" })).isError === true);
      check("test_run rejects command substitution", (await tr.handler({ script: "ok", filter: "$(touch pwned)" })).isError === true);
      check("test_run rejects backticks/pipes", (await tr.handler({ script: "ok", filter: "a | b `c`" })).isError === true);
      check("test_run rejects a leading-dash filter (arg injection)", (await tr.handler({ script: "ok", filter: "--config=./evil.cjs" })).isError === true);
      check("test_run rejects unsafe script name", (await tr.handler({ script: "a; rm -rf /", filter: "x" })).isError === true);
      // an injection attempt is rejected before running (no side effect)
      await tr.handler({ script: "ok", filter: 'x && node -e "require(\'fs\').writeFileSync(\'PWNED\',\'x\')"' });
      check("test_run injection never executed", !(await cctx.fs.exists("PWNED")));
      check("test_run missing script lists available", (await tr.handler({ script: "nope" })).isError === true);
    } finally {
      await fsp.rm(checkRoot, { recursive: true, force: true });
    }

    // --- savings ledger -------------------------------------------------
    const sav = ctx.savings.report();
    check("savings ledger accrued from distilled reads",
      sav.calls > 0 && sav.savedTokens > 0 && sav.returnedTokens <= sav.baselineTokens, JSON.stringify(sav));
    const healthPl = healthPlugin();
    await healthPl.init?.(ctx);
    const hpText = textOf(await tool(healthPl, "health").handler({}));
    check("health reports session savings", hpText.includes("savings this session") && hpText.includes("passed ~") && hpText.includes("to Claude"));

    // --- loader group gate ----------------------------------------------
    const reg1: string[] = [];
    await loadPlugins({ registerTool: (n: string) => reg1.push(n) } as never, { ...ctx, config: { ...ctx.config, groups: new Set(["core"]) } }, [healthPlugin(), colorContrastPlugin(), mediaInfoPlugin()]);
    check("group gate loads core, skips the design bundle", reg1.includes("health") && !reg1.includes("color_contrast") && !reg1.includes("media_info"));
    const reg2: string[] = [];
    await loadPlugins({ registerTool: (n: string) => reg2.push(n) } as never, { ...ctx, config: { ...ctx.config, groups: new Set(["core", "design"]) } }, [colorContrastPlugin()]);
    check("group gate loads an enabled bundle", reg2.includes("color_contrast"));
    const reg3: string[] = [];
    await loadPlugins({ registerTool: (n: string) => reg3.push(n) } as never, ctx, [colorContrastPlugin()]);
    check("group gate: unset groups loads everything", reg3.includes("color_contrast"));
    // Regression: an additive bundle value (or a typo) never drops core.
    const reg4: string[] = [];
    await loadPlugins({ registerTool: (n: string) => reg4.push(n) } as never, { ...ctx, config: { ...ctx.config, groups: new Set(["design"]) } }, [healthPlugin(), colorContrastPlugin()]);
    check("group gate: 'design' still loads core (imply-core)", reg4.includes("health") && reg4.includes("color_contrast"));
    const reg5: string[] = [];
    await loadPlugins({ registerTool: (n: string) => reg5.push(n) } as never, { ...ctx, config: { ...ctx.config, groups: new Set(["typo"]) } }, [healthPlugin(), colorContrastPlugin()]);
    check("group gate: a typo bundle still loads core, skips design", reg5.includes("health") && !reg5.includes("color_contrast"));

    // --- config: group parsing robustness -------------------------------
    const prevGroups = process.env.EFFICIENT_TOKEN_GROUPS;
    try {
      process.env.EFFICIENT_TOKEN_GROUPS = ", ,";
      check("loadConfig: delimiter-only groups → unset (load all)", loadConfig().groups === undefined);
      process.env.EFFICIENT_TOKEN_GROUPS = "Design, CORE";
      const g = loadConfig().groups;
      check("loadConfig: groups parsed, lowercased", g !== undefined && g.has("design") && g.has("core"));
    } finally {
      if (prevGroups === undefined) delete process.env.EFFICIENT_TOKEN_GROUPS;
      else process.env.EFFICIENT_TOKEN_GROUPS = prevGroups;
    }

    // --- premium loader (open-core seam) --------------------------------
    const prevPremium = process.env.EFFICIENT_TOKEN_PREMIUM;
    try {
      const premDir = await mkTmp("efficient-token-premium-");
      const premFile = path.join(premDir, "premium.mjs");
      await fsp.writeFile(premFile, 'export function premiumPlugins() {\n  return [{ name: "fake-premium", version: "0.0.0", tier: "premium", tools: [] }];\n}\n');
      process.env.EFFICIENT_TOKEN_PREMIUM = pathToFileURL(premFile).href;
      const discovered = await loadPremiumPlugins(log);
      check("premium loader discovers an installed premium package", discovered.length === 1 && discovered[0]?.name === "fake-premium" && discovered[0]?.tier === "premium");
      const regPrem: string[] = [];
      await loadPlugins({ registerTool: (n: string) => regPrem.push(n) } as never, ctx, discovered);
      check("premium plugin stays dark under the free entitlement", regPrem.length === 0);

      process.env.EFFICIENT_TOKEN_PREMIUM = "efficient-token-premium-definitely-not-installed-xyz";
      check("premium loader is empty (no throw) when no premium package is installed", (await loadPremiumPlugins(log)).length === 0);
    } finally {
      if (prevPremium === undefined) delete process.env.EFFICIENT_TOKEN_PREMIUM;
      else process.env.EFFICIENT_TOKEN_PREMIUM = prevPremium;
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(`\n${failed === 0 ? "ALL PASS" : "SOME FAILED"} — ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  })
  .catch((err: unknown) => {
    console.error(`\nSMOKE CRASHED — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exitCode = 1;
  });
