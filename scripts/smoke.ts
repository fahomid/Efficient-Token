/**
 * Self-test for efficient-token. Exercises every core service and the three
 * free-tier plugins against a throwaway workspace, WITHOUT starting the MCP
 * transport. Prints `ALL PASS` and exits 0 on success; exits 1 otherwise.
 *
 * Run: `npm run smoke`  (tsx scripts/smoke.ts)
 */
import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

import { loadConfig } from "../src/core/config.js";
import type { CoreContext, Plugin, ToolResult } from "../src/core/contract.js";
import { splitLines, truncate } from "../src/core/text.js";
import { AstService } from "../src/services/ast.js";
import { TokenBudgeter } from "../src/services/budget.js";
import { SafeFs } from "../src/services/fs.js";
import { createEntitlement } from "../src/services/license.js";
import { createLogger } from "../src/services/logger.js";
import { PathSandbox } from "../src/services/paths.js";
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
import { commitLogPlugin } from "../src/plugins/commit-log/index.js";
import { conflictDigestPlugin } from "../src/plugins/conflict-digest/index.js";
import { diffDigestPlugin } from "../src/plugins/diff-digest/index.js";
import { findReferencesPlugin } from "../src/plugins/find-references/index.js";
import { globPlugin } from "../src/plugins/glob/index.js";
import { grepContextPlugin } from "../src/plugins/grep-context/index.js";
import { healthPlugin } from "../src/plugins/health/index.js";
import { importMapPlugin } from "../src/plugins/import-map/index.js";
import { jsonQueryPlugin } from "../src/plugins/json-query/index.js";
import { lineBlamePlugin } from "../src/plugins/line-blame/index.js";
import { markerInventoryPlugin } from "../src/plugins/marker-inventory/index.js";
import { moveSymbolPlugin } from "../src/plugins/move-symbol/index.js";
import { notePlugin } from "../src/plugins/note/index.js";
import { outlineDiffPlugin } from "../src/plugins/outline-diff/index.js";
import { projectRenamePlugin } from "../src/plugins/project-rename/index.js";
import { readAtRevPlugin } from "../src/plugins/read-at-rev/index.js";
import { readManyPlugin } from "../src/plugins/read-many/index.js";
import { replaceSymbolPlugin } from "../src/plugins/replace-symbol/index.js";
import { repoMapPlugin } from "../src/plugins/repo-map/index.js";
import { reviewBranchPlugin } from "../src/plugins/review-branch/index.js";
import { symbolFindPlugin } from "../src/plugins/symbol-find/index.js";
import { symbolHistoryPlugin } from "../src/plugins/symbol-history/index.js";
import { traceLocatePlugin } from "../src/plugins/trace-locate/index.js";
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
  return res.content.map((c) => c.text).join("\n");
}

async function main(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "efficient-token-smoke-"));
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

    // writeAtomic must not follow a symlink that escapes the workspace root.
    const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), "efficient-token-outside-"));
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

    // --- multi-language outline coverage --------------------------------
    // Tier A: grammars whose definitions the extractor resolves accurately.
    const tierA: Array<{ ext: string; code: string; expect: string[] }> = [
      { ext: "py", code: "class Greeter:\n    def greet(self):\n        return 1\n\ndef add(a, b):\n    return a + b\n", expect: ["Greeter", "greet", "add"] },
      { ext: "go", code: "package m\ntype Greeter struct{ name string }\nfunc (g Greeter) Greet() string { return g.name }\nfunc Add(a int) int { return a }\n", expect: ["Greeter", "Greet", "Add"] },
      { ext: "rs", code: "pub fn add(a: i32) -> i32 { a }\npub struct S { x: i32 }\nimpl S { pub fn m(&self) {} }\npub trait T { fn area(&self) -> f64; }\npub union RU { a: i32, b: f32 }\n", expect: ["add", "S", "m", "T", "area", "RU"] },
      { ext: "c", code: "int add(int a) { return a; }\nstruct Point { int x; };\nunion U { int a; float b; };\nenum Color { RED };\n", expect: ["add", "Point", "U", "Color"] },
      { ext: "cpp", code: "class G { public: int greet() { return 1; } };\nint add(int a) { return a; }\nnamespace ns { void f() {} }\n", expect: ["G", "greet", "add", "ns", "f"] },
      { ext: "cs", code: "namespace App { public class G { public int M() => 1; } public interface IS {} }\n", expect: ["App", "G", "M", "IS"] },
      { ext: "rb", code: "class G\n  def greet\n    1\n  end\nend\n\ndef add(a)\n  a\nend\n", expect: ["G", "greet", "add"] },
      { ext: "php", code: "<?php\nfunction add($a) { return $a; }\nclass G { public function greet() { return 1; } }\ninterface S { public function area(): float; }\n", expect: ["add", "G", "greet", "S", "area"] },
      { ext: "java", code: "public class G { public G() {} public int greet() { return 1; } }\ninterface S { double area(); }\nenum C { A }\n", expect: ["G", "greet", "S", "area", "C"] },
      { ext: "kt", code: "fun add(a: Int): Int = a\nclass G(val n: String) { fun greet(): String = n }\nobject O { val x = 1 }\ninterface S { fun area(): Double }\n", expect: ["add", "G", "greet", "O", "S", "area"] },
      { ext: "swift", code: "func add(a: Int) -> Int { return a }\nclass G { init() {} func greet() -> String { return \"\" } }\nstruct P { var x: Int }\nprotocol S { func area() -> Double }\n", expect: ["add", "G", "greet", "P", "S", "area"] },
      { ext: "scala", code: "def add(a: Int): Int = a\nclass G(n: String) { def greet(): String = n }\nobject M { val x = 1 }\ntrait S { def area: Double }\n", expect: ["add", "G", "greet", "M", "S", "area"] },
      { ext: "dart", code: "int add(int a) => a;\nclass G { String greet() => ''; }\nenum C { a }\n", expect: ["add", "G", "greet", "C"] },
      { ext: "lua", code: "local function add(a) return a end\nfunction G(n) return n end\n", expect: ["add", "G"] },
      { ext: "sh", code: "greet() { echo hi; }\nfunction add { echo done; }\n", expect: ["greet", "add"] },
      { ext: "m", code: "@interface G : NSObject\n- (int)greet;\n@end\n@implementation G\n- (int)greet { return 1; }\n@end\nvoid cfunc(void) {}\n", expect: ["G", "greet", "cfunc"] },
      { ext: "zig", code: "fn add(a: i32) i32 { return a; }\nconst G = struct {\n  fn greet() void {}\n};\n", expect: ["add", "G", "greet"] },
      { ext: "sol", code: "pragma solidity ^0.8.0;\ncontract G { function greet() public pure returns (uint) { return 1; } }\n", expect: ["G", "greet"] },
      { ext: "tla", code: "---- MODULE M ----\nAdd(a, b) == a + b\n====\n", expect: ["M", "Add"] },
      { ext: "el", code: "(defun add (a b) (+ a b))\n(defmacro twice (x) x)\n", expect: ["add", "twice"] },
      { ext: "ml", code: "let add a b = a + b\ntype color = Red\nmodule M = struct let x = 1 end\n", expect: ["add", "color", "M"] },
      { ext: "res", code: "let add = (a, b) => a + b\ntype color = Red\nmodule M = { let x = 1 }\n", expect: ["add", "color", "M"] },
      { ext: "rdl", code: "reg my_reg { field { sw=rw; } f1; };\nreg other { field {} f2; };\n", expect: ["my_reg", "other"] },
      { ext: "ts", code: "export const a = () => 1, b = () => 2;\nexport function f() {}\n", expect: ["a", "b", "f"] },
    ];
    for (const { ext, code, expect } of tierA) {
      const out = await ctx.ast.outline(`sample.${ext}`, code);
      const names = new Set((out ?? []).map((s) => s.name));
      const missing = expect.filter((n) => !names.has(n));
      check(
        `lang ${ext} outlines [${expect.join(",")}]`,
        Array.isArray(out) && missing.length === 0,
        `missing [${missing.join(",")}], got [${[...names].join(",")}]`,
      );
    }

    // kind correctness: "constructor" contains "struct" — must not mislabel.
    const javaKinds = (await ctx.ast.outline("K.java", "class K { K() {} void m() {} }")) ?? [];
    const ctor = javaKinds.find((s) => s.name === "K" && s.kind !== "class");
    check("constructor kind not mislabeled as struct", ctor?.kind === "constructor", `got ${ctor?.kind}`);

    // Tier B: grammar loads & parses (config/markup/macro — limited/no symbols).
    const tierB: Array<{ ext: string; code: string }> = [
      { ext: "css", code: ".a { color: red; }\n" },
      { ext: "html", code: "<!DOCTYPE html><div id='x'>hi</div>\n" },
      { ext: "json", code: '{ "a": 1, "b": [1, 2] }\n' },
      { ext: "toml", code: "[s]\nk = 1\n" },
      { ext: "vue", code: "<template><div>{{ m }}</div></template>\n" },
      { ext: "erb", code: "<ul><% items.each do |i| %><li><%= i %></li><% end %></ul>\n" },
      { ext: "ex", code: "defmodule M do\n  def f, do: 1\nend\n" },
    ];
    for (const { ext, code } of tierB) {
      const out = await ctx.ast.outline(`sample.${ext}`, code);
      check(`lang ${ext} parses (Tier B)`, Array.isArray(out), `got ${out === undefined ? "undefined" : "array"}`);
    }

    // Grammars excluded for incompatibility/crashes must NOT be mapped.
    for (const ext of ["elm", "ql", "yaml", "yml"]) {
      check(`lang ${ext} not mapped`, ctx.ast.grammarIdFor(`x.${ext}`) === undefined);
    }

    // Alias extensions must resolve to their base grammar.
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

    // --- code_outline plugin --------------------------------------------
    const outlinePlugin = codeOutlinePlugin();
    await outlinePlugin.init?.(ctx);
    const oRes = await tool(outlinePlugin, "code_outline").handler({ path: "sample.ts" });
    check("code_outline lists symbols", !oRes.isError && textOf(oRes).includes("symbol(s)") && textOf(oRes).includes("class Greeter"));
    const oTxt = await tool(outlinePlugin, "code_outline").handler({ path: "notes.txt" });
    check("code_outline handles no-grammar", textOf(oTxt).includes("no grammar"));

    // --- code_read plugin ------------------------------------------------
    const readPlugin = codeReadPlugin();
    await readPlugin.init?.(ctx);
    const cr = tool(readPlugin, "code_read");

    const symRes = await cr.handler({ path: "sample.ts", symbol: "add" });
    check("code_read symbol mode", !symRes.isError && textOf(symRes).includes("function add") && textOf(symRes).includes("return a + b;"));

    const missRes = await cr.handler({ path: "sample.ts", symbol: "doesNotExist" });
    check("code_read missing symbol lists names", missRes.isError === true && textOf(missRes).includes("not found") && textOf(missRes).includes("add"));

    const rangeRes = await cr.handler({ path: "sample.ts", startLine: 1, endLine: 2 });
    check("code_read range mode", !rangeRes.isError && textOf(rangeRes).includes("lines 1-2") && textOf(rangeRes).includes("1| "));

    const wholeRes = await cr.handler({ path: "sample.ts" });
    check("code_read whole-file fits", !wholeRes.isError && textOf(wholeRes).includes("class Greeter") && textOf(wholeRes).includes("interface Point"));

    const degradeRes = await cr.handler({ path: "sample.ts", maxTokens: 1 });
    const dTxt = textOf(degradeRes);
    check("code_read degrades over budget", !degradeRes.isError && dTxt.includes("exceeds budget 1") && dTxt.includes("Outline:") && dTxt.includes("First lines:"));

    // A wide EXPLICIT range over a large file must bound output, not dump it
    // (adversarial-review fix: readRange now honours maxTokens).
    await ctx.fs.writeAtomic("bigrange.ts", Array.from({ length: 800 }, (_, i) => `const v${i} = ${i}; // ${"y".repeat(40)}`).join("\n") + "\n");
    const wideRange = await cr.handler({ path: "bigrange.ts", startLine: 1, endLine: 800, maxTokens: 50 });
    const wrTxt = textOf(wideRange);
    check("code_read bounds a wide range", !wideRange.isError && wrTxt.includes("more line(s)") && wrTxt.length < 3500, `len=${wrTxt.length}`);

    // --- round-3 edge-case hardening ------------------------------------
    // Degrade must stay bounded even when the file is one giant line.
    const longLine = `const data = "${"x".repeat(60000)}";`;
    await ctx.fs.writeAtomic("minified.js", longLine);
    const minRes = await cr.handler({ path: "minified.js" });
    const minTxt = textOf(minRes);
    check("code_read bounds degrade of one long line", !minRes.isError && minTxt.length < 5000 && minTxt.includes("long lines truncated"), `len=${minTxt.length}`);

    // Trailing newline must not produce a phantom numbered line / off-by-one.
    await ctx.fs.writeAtomic("nl.txt", "l1\nl2\nl3\n");
    const nlTxt = textOf(await cr.handler({ path: "nl.txt" }));
    check("code_read no phantom trailing line", nlTxt.includes("3 line(s)") && !nlTxt.includes("4| "), nlTxt);

    // Lone-CR line endings split correctly and leave no stray CR in output.
    await ctx.fs.writeAtomic("cr.txt", "a\rb\rc");
    const crTxt = textOf(await cr.handler({ path: "cr.txt" }));
    check("code_read splits lone-CR with no stray CR", crTxt.includes("3 line(s)") && !crTxt.includes("\r"), JSON.stringify(crTxt));

    // splitLines / truncate helpers.
    check("splitLines strips one trailing newline", JSON.stringify(splitLines("a\nb\n")) === JSON.stringify(["a", "b"]));
    check("splitLines splits lone CR and CRLF", JSON.stringify(splitLines("a\rb\r\nc")) === JSON.stringify(["a", "b", "c"]));
    check("splitLines empty -> []", splitLines("").length === 0);
    const wellFormed = (s: string): boolean =>
      Array.from(s).every((ch) => { const cp = ch.codePointAt(0) ?? 0; return cp < 0xd800 || cp > 0xdfff; });
    const trunc = truncate("a".repeat(150) + "😀".repeat(20), 160);
    check("truncate is surrogate-safe", trunc.endsWith("…") && wellFormed(trunc));

    // Mixed declarators: a sibling binding must not leak into a symbol's signature.
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

    const created = await cw.handler({ path: "w/new.txt", content: "hello\nworld\n" });
    check("code_write creates file", !created.isError && textOf(created).includes("Created") && (await ctx.fs.read("w/new.txt")).content === "hello\nworld\n");
    const overwritten = await cw.handler({ path: "w/new.txt", content: "changed\n" });
    check("code_write overwrites file", !overwritten.isError && textOf(overwritten).includes("Overwrote") && (await ctx.fs.read("w/new.txt")).content === "changed\n");
    check("code_write rejects path escape", (await cw.handler({ path: "../escape.txt", content: "x" })).isError === true);

    // --- code_edit plugin (Edit semantics) ------------------------------
    const editPlugin = codeEditPlugin();
    await editPlugin.init?.(ctx);
    const ce = tool(editPlugin, "code_edit");

    await ctx.fs.writeAtomic("e/edit.txt", "alpha\nbeta\nalpha\n");
    const uniqueEdit = await ce.handler({ path: "e/edit.txt", oldString: "beta", newString: "BETA" });
    check("code_edit replaces unique match", !uniqueEdit.isError && (await ctx.fs.read("e/edit.txt")).content === "alpha\nBETA\nalpha\n");

    const ambiguous = await ce.handler({ path: "e/edit.txt", oldString: "alpha", newString: "X" });
    check("code_edit refuses ambiguous match", ambiguous.isError === true && textOf(ambiguous).includes("not unique (2 matches)"));
    check("code_edit ambiguous left file unchanged", (await ctx.fs.read("e/edit.txt")).content === "alpha\nBETA\nalpha\n");

    const all = await ce.handler({ path: "e/edit.txt", oldString: "alpha", newString: "X", replaceAll: true });
    check("code_edit replaceAll replaces every match", !all.isError && textOf(all).includes("2 replacement(s)") && (await ctx.fs.read("e/edit.txt")).content === "X\nBETA\nX\n");

    const notFound = await ce.handler({ path: "e/edit.txt", oldString: "zzz", newString: "y" });
    check("code_edit reports missing oldString", notFound.isError === true && textOf(notFound).includes("not found"));

    // newString with `$` patterns must be inserted LITERALLY (no String.replace).
    await ctx.fs.writeAtomic("e/dollar.txt", "value = HERE;\n");
    await ce.handler({ path: "e/dollar.txt", oldString: "HERE", newString: "$&$1$$x" });
    check("code_edit inserts $ patterns literally", (await ctx.fs.read("e/dollar.txt")).content === "value = $&$1$$x;\n", (await ctx.fs.read("e/dollar.txt")).content);
    await ctx.fs.writeAtomic("e/dollar2.txt", "a HERE b HERE c\n");
    await ce.handler({ path: "e/dollar2.txt", oldString: "HERE", newString: "$&", replaceAll: true });
    check("code_edit replaceAll inserts $ literally", (await ctx.fs.read("e/dollar2.txt")).content === "a $& b $& c\n");

    const identical = await ce.handler({ path: "e/edit.txt", oldString: "X", newString: "X" });
    check("code_edit rejects identical old/new", identical.isError === true && textOf(identical).includes("identical"));

    check("code_edit rejects path escape", (await ce.handler({ path: "../escape.txt", oldString: "a", newString: "b" })).isError === true);

    // code_edit preserves a BOM (uses raw read, not BOM-stripped read).
    const BOM = String.fromCharCode(0xfeff);
    await ctx.fs.writeAtomic("e/bom.ts", `${BOM}const k = 1;\n`);
    await ce.handler({ path: "e/bom.ts", oldString: "const k = 1;", newString: "const k = 2;" });
    check("code_edit preserves BOM via raw read", (await ctx.fs.readRaw("e/bom.ts")).content === `${BOM}const k = 2;\n`);

    // --- syntax recovery guard (code_edit + code_write) -----------------
    const GOOD = "export function f() {\n  return 1;\n}\n";
    await ctx.fs.writeAtomic("syn/f.ts", GOOD);
    const broke = await ce.handler({ path: "syn/f.ts", oldString: "  return 1;\n}", newString: "  return 1;" });
    check("code_edit refuses syntax-breaking edit", broke.isError === true && textOf(broke).includes("syntax error"));
    check("code_edit left file unchanged after refusal", (await ctx.fs.read("syn/f.ts")).content === GOOD);
    const forced = await ce.handler({ path: "syn/f.ts", oldString: "  return 1;\n}", newString: "  return 1;", validate: false });
    check("code_edit validate:false overrides guard", !forced.isError && !(await ctx.fs.read("syn/f.ts")).content.includes("}"));

    await ctx.fs.writeAtomic("syn/g.ts", "export const x = 1;\n");
    const validEdit = await ce.handler({ path: "syn/g.ts", oldString: "= 1", newString: "= 2" });
    check("code_edit allows syntactically-valid edit", !validEdit.isError && (await ctx.fs.read("syn/g.ts")).content.includes("= 2"));

    await ctx.fs.writeAtomic("syn/broken.ts", "export function h() {\n  return 1;\n"); // already missing }
    const fixBroken = await ce.handler({ path: "syn/broken.ts", oldString: "return 1;\n", newString: "return 1;\n}\n" });
    check("code_edit allows edits to an already-broken file", !fixBroken.isError);

    await ctx.fs.writeAtomic("syn/n.txt", "hello\n");
    const txtEdit = await ce.handler({ path: "syn/n.txt", oldString: "hello", newString: "((( unbalanced" });
    check("code_edit skips validation for non-grammar files", !txtEdit.isError && (await ctx.fs.read("syn/n.txt")).content.includes("((("));

    const cwBroke = await cw.handler({ path: "syn/w.ts", content: "export function w() {\n  return 1;\n" });
    check("code_write refuses syntactically-broken content", cwBroke.isError === true && textOf(cwBroke).includes("syntax error"));
    check("code_write did not create the broken file", !(await ctx.fs.exists("syn/w.ts")));
    const cwForced = await cw.handler({ path: "syn/w.ts", content: "export function w() {\n  return 1;\n", validate: false });
    check("code_write validate:false overrides", !cwForced.isError && (await ctx.fs.exists("syn/w.ts")));
    const cwOk = await cw.handler({ path: "syn/ok.ts", content: "export const y = 2;\n" });
    check("code_write allows valid content", !cwOk.isError && (await ctx.fs.read("syn/ok.ts")).content.includes("y = 2"));

    // Valid-but-newer TS must NOT be falsely blocked (grammar emits ERROR, not MISSING).
    await ctx.fs.writeAtomic("syn/modern.ts", "class C {\n  x = 1;\n}\n");
    const accessorEdit = await ce.handler({ path: "syn/modern.ts", oldString: "  x = 1;", newString: "  accessor x = 1;" });
    check("code_edit allows valid `accessor` field (no false positive)", !accessorEdit.isError && (await ctx.fs.read("syn/modern.ts")).content.includes("accessor x = 1"));
    await ctx.fs.writeAtomic("syn/variance.ts", "export interface Box<T> { v: T }\n");
    const varianceEdit = await ce.handler({ path: "syn/variance.ts", oldString: "Box<T>", newString: "Box<out T>" });
    check("code_edit allows valid in/out variance (no false positive)", !varianceEdit.isError && (await ctx.fs.read("syn/variance.ts")).content.includes("Box<out T>"));

    // code_write: an UNREADABLE (oversize) existing baseline must not be faked clean.
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
      { path: "ap/a.ts", oldString: "a = 1", newString: "a = 10" },
      { path: "ap/a.ts", oldString: "b = 2", newString: "b = 20" },
      { path: "ap/b.ts", oldString: "c = 3", newString: "c = 30" },
    ] });
    check("apply_patch applies across files", !ap1.isError && (await ctx.fs.read("ap/a.ts")).content === "export const a = 10;\nexport const b = 20;\n" && (await ctx.fs.read("ap/b.ts")).content === "export const c = 30;\n");

    await ctx.fs.writeAtomic("ap/seq.ts", "let x = 0;\n");
    const apSeq = await ap.handler({ edits: [
      { path: "ap/seq.ts", oldString: "= 0", newString: "= 1" },
      { path: "ap/seq.ts", oldString: "= 1", newString: "= 2" },
    ] });
    check("apply_patch sequential edits compound", !apSeq.isError && (await ctx.fs.read("ap/seq.ts")).content === "let x = 2;\n");

    await ctx.fs.writeAtomic("ap/x.ts", "export const p = 1;\n");
    await ctx.fs.writeAtomic("ap/y.ts", "export const q = 2;\n");
    const apAbort = await ap.handler({ edits: [
      { path: "ap/x.ts", oldString: "p = 1", newString: "p = 11" },
      { path: "ap/y.ts", oldString: "NOTHERE", newString: "z" },
    ] });
    check("apply_patch aborts atomically on a bad edit", apAbort.isError === true && textOf(apAbort).includes("aborted") && (await ctx.fs.read("ap/x.ts")).content === "export const p = 1;\n");

    await ctx.fs.writeAtomic("ap/g.ts", "export function g() {\n  return 1;\n}\n");
    const apSyn = await ap.handler({ edits: [{ path: "ap/g.ts", oldString: "  return 1;\n}", newString: "  return 1;" }] });
    check("apply_patch enforces syntax guard", apSyn.isError === true && (await ctx.fs.read("ap/g.ts")).content.includes("}"));
    const apForced = await ap.handler({ validate: false, edits: [{ path: "ap/g.ts", oldString: "  return 1;\n}", newString: "  return 1;" }] });
    check("apply_patch validate:false overrides", !apForced.isError && !(await ctx.fs.read("ap/g.ts")).content.includes("}"));

    await ctx.fs.writeAtomic("ap/amb.ts", "const dup = 1; const x = dup + dup;\n");
    const apAmb = await ap.handler({ edits: [{ path: "ap/amb.ts", oldString: "dup", newString: "D" }] });
    check("apply_patch rejects ambiguous edit", apAmb.isError === true && textOf(apAmb).includes("not unique"));

    const apEscape = await ap.handler({ edits: [{ path: "../escape.ts", oldString: "a", newString: "b" }] });
    check("apply_patch blocks path escape", apEscape.isError === true);

    // Case-variant paths to the SAME file must coalesce (no lost edit) on a
    // case-insensitive filesystem.
    if (process.platform === "win32" || process.platform === "darwin") {
      await ctx.fs.writeAtomic("ap/cv.ts", "const A = 1;\nconst C = 2;\n");
      const apCv = await ap.handler({ edits: [
        { path: "ap/cv.ts", oldString: "A = 1", newString: "A = 11" },
        { path: "ap/CV.ts", oldString: "C = 2", newString: "C = 22" },
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
    // Unicode identifier boundary: renaming "caf" must not corrupt "café".
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

    const contentRes = await cs.handler({ pattern: "beta", path: "srch", outputMode: "content" });
    check("code_search content mode", textOf(contentRes).includes("srch/a.ts:2:const beta = 1;"));

    const countRes = await cs.handler({ pattern: "alpha", path: "srch", outputMode: "count" });
    check("code_search count mode", textOf(countRes).includes("srch/a.ts: 1") && textOf(countRes).includes("srch/c.txt: 1"));

    const ci = await cs.handler({ pattern: "ALPHA", path: "srch", caseInsensitive: true });
    check("code_search case-insensitive", textOf(ci).includes("srch/a.ts"));

    const ctxRes = await cs.handler({ pattern: "beta", path: "srch", outputMode: "content", context: 1 });
    check("code_search context lines", textOf(ctxRes).includes("srch/a.ts-1-") && textOf(ctxRes).includes("srch/a.ts:2:"));

    const none = await cs.handler({ pattern: "zzzznope", path: "srch" });
    check("code_search no match", textOf(none).includes("No matches"));

    const badRe = await cs.handler({ pattern: "(", path: "srch" });
    check("code_search invalid regex", badRe.isError === true && textOf(badRe).includes("invalid regex"));

    check("code_search skips node_modules implicitly", !textOf(await cs.handler({ pattern: "alpha" })).includes("node_modules"));

    // Zero-width regex in count+multiline must terminate (no infinite loop).
    const zw = await cs.handler({ pattern: "\\w*", path: "srch", outputMode: "count", multiline: true });
    check("code_search zero-width regex terminates", !zw.isError);

    // Scanner must not follow a symlinked scope out of the workspace root.
    const scanOut = await fsp.mkdtemp(path.join(os.tmpdir(), "efficient-token-scanout-"));
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
    // adversarial-review fix: an oversized FIRST target is bounded, not dumped whole.
    await ctx.fs.writeAtomic("rm/big.txt", Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(50)}`).join("\n") + "\n");
    const rmBudget = await rmm.handler({ maxTokens: 5, reads: [{ path: "rm/big.txt" }] });
    const rmBudgetT = textOf(rmBudget);
    check("read_many bounds an oversized first target", !rmBudget.isError && rmBudgetT.length < 2000 && rmBudgetT.includes("truncated"), `len=${rmBudgetT.length}`);

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
    check("move_symbol re-imports into source when still used", aAfter.includes('import { moved } from "./b'));
    check("move_symbol rewrites named importers", cAfter.includes('from "./b.js"') && !cAfter.includes('from "./a.js"'));
    check("move_symbol unknown symbol errors", (await ms.handler({ symbol: "nopeSym", from: "ms/a.ts", to: "ms/b.ts" })).isError === true);

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

    // --- diff_digest plugin ---------------------------------------------
    // Non-repo: the smoke root is not a git repo.
    const ddNonRepo = diffDigestPlugin();
    await ddNonRepo.init?.(ctx);
    check("diff_digest detects non-repo", (await tool(ddNonRepo, "diff_digest").handler({})).isError === true);
    const rbNonRepo = reviewBranchPlugin();
    await rbNonRepo.init?.(ctx);
    check("review_branch detects non-repo", (await tool(rbNonRepo, "review_branch").handler({})).isError === true);

    // Real (isolated) git repo: exercise the success paths.
    const gitRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "efficient-token-git-"));
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
    } finally {
      await fsp.rm(gitRoot, { recursive: true, force: true });
    }

    // --- conflict_digest plugin (isolated repo with a real merge conflict)
    const conflictRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "efficient-token-conflict-"));
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
      await fsp.writeFile(path.join(conflictRoot, "c.txt"), "top\ntheirs-mid\nbottom\n");
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

    const checkRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "efficient-token-check-"));
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
      const missing = await cc.handler({ script: "nope" });
      check("code_check missing script lists available", missing.isError === true && textOf(missing).includes("Available: ok, bad"));
      const unsafe = await cc.handler({ script: "a b; rm -rf /" });
      check("code_check rejects unsafe script name", unsafe.isError === true && textOf(unsafe).includes("invalid script name"));

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
    } finally {
      await fsp.rm(checkRoot, { recursive: true, force: true });
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
