/**
 * Grammar introspection helper. Parses a representative sample of each grammar
 * and prints its named-node structure (type + extracted name + line), so the
 * AstService definition rules can be grounded in what tree-sitter actually emits
 * rather than guessed. Dev tool. Run: `npx tsx scripts/discover.ts`.
 */
import { createRequire } from "node:module";
import path from "node:path";

import { Language, Parser, type Node } from "web-tree-sitter";

const require = createRequire(import.meta.url);
const WASM_DIR = path.join(
  path.dirname(require.resolve("tree-sitter-wasms/package.json")),
  "out",
);

const SAMPLES: Record<string, string> = {
  bash: `#!/usr/bin/env bash
greet() { echo "hi $1"; }
function add { return $(( $1 + $2 )); }
`,
  css: `.btn { color: red; }
#main { margin: 0; }
@media screen { body { color: blue; } }
`,
  dart: `int add(int a, int b) => a + b;
class Greeter {
  final String name;
  Greeter(this.name);
  String greet() => 'hi $name';
}
enum Color { red, blue }
`,
  elisp: `(defun add (a b) (+ a b))
(defvar counter 0)
(defmacro twice (x) (list 'progn x x))
`,
  elixir: `defmodule Greeter do
  @doc "greet"
  def greet(name) do
    "hi " <> name
  end
  defp secret, do: 42
end
`,
  elm: `module Main exposing (..)
add : Int -> Int -> Int
add a b = a + b
type Color = Red | Blue
type alias Point = { x : Int, y : Int }
`,
  embedded_template: `<ul>
<% items.each do |item| %>
  <li><%= item %></li>
<% end %>
</ul>
`,
  html: `<!DOCTYPE html>
<html><head><title>T</title></head>
<body><h1 id="x">Hi</h1></body></html>
`,
  json: `{ "name": "x", "nested": { "a": 1 }, "list": [1, 2, 3] }
`,
  kotlin: `fun add(a: Int, b: Int): Int = a + b
class Greeter(val name: String) {
  fun greet(): String = "hi $name"
}
interface Shape { fun area(): Double }
object Singleton { val x = 1 }
enum class Color { RED, BLUE }
`,
  lua: `local function add(a, b) return a + b end
function Greeter(name) return name end
local M = {}
function M.greet(self) return "hi" end
`,
  objc: `@interface Greeter : NSObject
- (NSString *)greet;
@end
@implementation Greeter
- (NSString *)greet { return @"hi"; }
@end
void cfunc(void) {}
`,
  ocaml: `let add a b = a + b
type color = Red | Blue
module M = struct let x = 1 end
`,
  ql: `class Foo extends Bar { predicate p() { any() } }
predicate isThing(int x) { x > 0 }
`,
  rescript: `let add = (a, b) => a + b
type color = Red | Blue
module M = { let x = 1 }
`,
  scala: `def add(a: Int, b: Int): Int = a + b
class Greeter(name: String) { def greet(): String = "hi " + name }
object Main { val x = 1 }
trait Shape { def area: Double }
`,
  solidity: `pragma solidity ^0.8.0;
contract Greeter {
  string name;
  function greet() public view returns (string memory) { return name; }
}
`,
  swift: `func add(a: Int, b: Int) -> Int { return a + b }
class Greeter {
  let name: String
  init(name: String) { self.name = name }
  func greet() -> String { return "hi" }
}
struct Point { var x: Int; var y: Int }
protocol Shape { func area() -> Double }
enum Color { case red, blue }
extension Greeter { func bye() {} }
`,
  systemrdl: `reg my_reg {
  field { sw=rw; hw=r; } f1;
};
`,
  tlaplus: `---- MODULE M ----
Add(a, b) == a + b
Init == TRUE
====
`,
  toml: `[section]
key = "value"
[other.nested]
n = 1
`,
  vue: `<template><div>{{ msg }}</div></template>
<script>export default { data() { return { msg: 'hi' } } }</script>
`,
  yaml: `name: x
nested:
  a: 1
list:
  - one
  - two
`,
  zig: `fn add(a: i32, b: i32) i32 { return a + b; }
const Greeter = struct {
  name: []const u8,
  fn greet(self: Greeter) []const u8 { return self.name; }
};
const PI: f64 = 3.14;
`,
  c: `int add(int a, int b) { return a + b; }
struct Point { int x; int y; };
enum Color { RED, BLUE };
`,
  cpp: `class Greeter {
  std::string name;
public:
  Greeter(std::string n) : name(n) {}
  std::string greet() { return name; }
};
int add(int a, int b) { return a + b; }
namespace ns { void f() {} }
`,
  c_sharp: `namespace App {
  public class Greeter {
    private string name;
    public Greeter(string n) { name = n; }
    public string Greet() => "hi " + name;
  }
  public interface IShape { double Area(); }
  public enum Color { Red, Blue }
}
`,
  go: `package main
type Greeter struct { name string }
func (g Greeter) Greet() string { return g.name }
func Add(a, b int) int { return a + b }
type Shape interface { Area() float64 }
`,
  rust: `pub fn add(a: i32, b: i32) -> i32 { a + b }
pub struct Greeter { name: String }
impl Greeter { pub fn greet(&self) -> &str { &self.name } }
pub trait Shape { fn area(&self) -> f64; }
`,
  python: `class Greeter:
    """doc"""
    def __init__(self, name):
        self.name = name
    def greet(self):
        return "hi"

def add(a, b):
    return a + b
`,
  ruby: `class Greeter
  def initialize(name)
    @name = name
  end
  def greet
    "hi"
  end
end

def add(a, b)
  a + b
end

module M
  def self.f; end
end
`,
  php: `<?php
function add($a, $b) { return $a + $b; }
class Greeter {
  public function greet() { return "hi"; }
}
interface Shape { public function area(): float; }
`,
  java: `public class Greeter {
  public Greeter(String name) {}
  public String greet() { return "hi"; }
}
interface Shape { double area(); }
enum Color { RED, BLUE }
`,
};

function nameOf(node: Node, src: string): string {
  const named = node.childForFieldName("name");
  if (named) return src.slice(named.startIndex, named.endIndex);
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && /identifier/i.test(c.type)) return src.slice(c.startIndex, c.endIndex);
  }
  return "";
}

function walk(node: Node, src: string, depth: number, maxDepth: number, out: string[]): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "comment") continue;
    const nm = nameOf(c, src);
    out.push(`${"  ".repeat(depth)}${c.type}${nm ? `  «${nm}»` : ""}`);
    if (depth < maxDepth) walk(c, src, depth + 1, maxDepth, out);
  }
}

async function main(): Promise<void> {
  await Parser.init();
  for (const [id, code] of Object.entries(SAMPLES)) {
    console.log(`\n===== ${id} =====`);
    try {
      const lang = await Language.load(path.join(WASM_DIR, `tree-sitter-${id}.wasm`));
      const parser = new Parser();
      parser.setLanguage(lang);
      const tree = parser.parse(code);
      if (!tree) {
        console.log("  <parse returned null>");
        continue;
      }
      const out: string[] = [];
      walk(tree.rootNode, code, 0, 2, out);
      console.log(out.join("\n"));
      tree.delete();
      parser.delete();
    } catch (err) {
      console.log(`  <error: ${err instanceof Error ? err.message : String(err)}>`);
    }
  }
}

void main();
