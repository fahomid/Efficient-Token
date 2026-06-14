/**
 * Self-test for efficient-token. Exercises every core service and the three
 * free-tier plugins against a throwaway workspace, WITHOUT starting the MCP
 * transport. Prints `ALL PASS` and exits 0 on success; exits 1 otherwise.
 *
 * Run: `npm run smoke`  (tsx scripts/smoke.ts)
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";
import type { CoreContext, Plugin, ToolResult } from "../src/core/contract.js";
import { splitLines, truncate } from "../src/core/text.js";
import { AstService } from "../src/services/ast.js";
import { TokenBudgeter } from "../src/services/budget.js";
import { SafeFs } from "../src/services/fs.js";
import { createEntitlement } from "../src/services/license.js";
import { createLogger } from "../src/services/logger.js";
import { PathSandbox } from "../src/services/paths.js";
import { codeEditPlugin } from "../src/plugins/code-edit/index.js";
import { codeOutlinePlugin } from "../src/plugins/code-outline/index.js";
import { codeReadPlugin } from "../src/plugins/code-read/index.js";
import { codeWritePlugin } from "../src/plugins/code-write/index.js";
import { healthPlugin } from "../src/plugins/health/index.js";

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
