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
import { codeCheckPlugin } from "../src/plugins/code-check/index.js";
import { diffDigestPlugin } from "../src/plugins/diff-digest/index.js";
import { findReferencesPlugin } from "../src/plugins/find-references/index.js";
import { grepContextPlugin } from "../src/plugins/grep-context/index.js";
import { healthPlugin } from "../src/plugins/health/index.js";
import { repoMapPlugin } from "../src/plugins/repo-map/index.js";

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
    } finally {
      await fsp.rm(gitRoot, { recursive: true, force: true });
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
        },
      };
      await fsp.writeFile(path.join(checkRoot, "package.json"), JSON.stringify(pkg, null, 2));
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
