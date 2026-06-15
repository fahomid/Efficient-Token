/**
 * Fixtures for the multi-language outline sweep run by the smoke test.
 * `expect` present = full-outline assertion; absent = parse-only (Tier B).
 */
export interface LangCase {
  ext: string;
  code: string;
  expect?: string[];
}

export const LANG_CASES: LangCase[] = [
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
  { ext: "css", code: ".a { color: red; }\n" },
  { ext: "html", code: "<!DOCTYPE html><div id='x'>hi</div>\n" },
  { ext: "json", code: '{ "a": 1, "b": [1, 2] }\n' },
  { ext: "toml", code: "[s]\nk = 1\n" },
  { ext: "vue", code: "<template><div>{{ m }}</div></template>\n" },
  { ext: "erb", code: "<ul><% items.each do |i| %><li><%= i %></li><% end %></ul>\n" },
  { ext: "ex", code: "defmodule M do\n  def f, do: 1\nend\n" },
];
