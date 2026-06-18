import { createRequire } from "node:module";
import path from "node:path";

import { Language, Parser, type Node } from "web-tree-sitter";

import { truncate } from "../core/text.js";
import type { Logger } from "./logger.js";

/** A definition surfaced from a file's syntax tree. */
export interface SymbolInfo {
  kind: string;
  name: string;
  container?: string;
  signature: string;
  startLine: number;
  endLine: number;
  /** Char offset of the definition's first char in the source, for exact splices. */
  startIndex: number;
  /** Char offset just past the definition's last char. */
  endIndex: number;
  hasDoc: boolean;
}

/** A syntax fault (ERROR or MISSING node) found by the parser. */
export interface SyntaxIssue {
  kind: "error" | "missing";
  line: number; // 1-based
  column: number; // 1-based
  text: string; // short snippet / missing token
}

/** Render syntax issues for a tool message. */
export function formatSyntaxIssues(issues: readonly SyntaxIssue[]): string {
  return issues.map((i) => `  ${i.line}:${i.column}  ${i.kind} ${i.text}`).join("\n");
}

const require = createRequire(import.meta.url);
/** Directory holding `tree-sitter-<grammar>.wasm` files from tree-sitter-wasms. */
const WASM_DIR = path.join(
  path.dirname(require.resolve("tree-sitter-wasms/package.json")),
  "out",
);

/**
 * File extension (no dot, lowercase) -> tree-sitter grammar id. Every id maps to
 * a `tree-sitter-<id>.wasm` in tree-sitter-wasms. The elm, codeql, and yaml
 * grammars in that package are not mapped: they are ABI-incompatible with, or
 * crash, this web-tree-sitter runtime (see scripts/discover.ts).
 */
const EXT_TO_GRAMMAR: Readonly<Record<string, string>> = {
  // TypeScript / JavaScript
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  // Python / Ruby / PHP
  py: "python",
  rb: "ruby",
  php: "php",
  // Go / Rust / Zig
  go: "go",
  rs: "rust",
  zig: "zig",
  // C family
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cs: "c_sharp", // underscore is intentional: file is tree-sitter-c_sharp.wasm
  m: "objc", // Objective-C (.m is also MATLAB, which has no grammar here)
  // JVM
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sc: "scala",
  // Apple / mobile
  swift: "swift",
  dart: "dart",
  // Functional / ML family
  ml: "ocaml",
  mli: "ocaml",
  res: "rescript",
  resi: "rescript",
  el: "elisp",
  ex: "elixir",
  exs: "elixir",
  // Scripting / shells
  lua: "lua",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  // Smart contracts / hardware / formal
  sol: "solidity",
  rdl: "systemrdl",
  tla: "tlaplus",
  // Web / markup / config / data
  html: "html",
  htm: "html",
  css: "css",
  vue: "vue",
  erb: "embedded_template",
  ejs: "embedded_template",
  json: "json",
  toml: "toml",
};

/**
 * Node types that are definitions across the supported grammars. Curated from
 * the actual trees each grammar emits (scripts/discover.ts), so it stays a flat,
 * language-agnostic allowlist: a type here is a definition wherever it appears.
 */
const DEFINITION_TYPES: ReadonlySet<string> = new Set([
  // functions / methods / constructors
  "function_declaration",
  "function_definition",
  "function_item",
  "function_signature", // dart top-level fn; TS ambient fn
  "function_signature_item", // rust trait method
  "function_definition_statement", // lua
  "local_function_definition_statement", // lua
  "method_declaration",
  "method_definition",
  "method_signature", // dart / TS interface method
  "method",
  "singleton_method", // ruby
  "constructor_declaration",
  "constructor",
  "init_declaration", // swift
  "macro_definition", // rust macro_rules!, elisp defmacro
  "operator_definition", // tla+
  // classes / interfaces / protocols / contracts
  "class_declaration",
  "class_definition",
  "class_specifier", // c++
  "class_interface", // objc @interface
  "class_implementation", // objc @implementation
  "class",
  "interface_declaration",
  "interface",
  "protocol_declaration", // swift
  "protocol_function_declaration", // swift
  "contract_declaration", // solidity
  // structs / enums / traits / impls
  "struct_declaration",
  "struct_item",
  "struct_specifier",
  "union_specifier", // c / c++
  "union_item", // rust
  "enum_declaration",
  "enum_item",
  "enum_specifier",
  "trait_declaration",
  "trait_item",
  "trait_definition", // scala
  "impl_item",
  // modules / namespaces / objects
  "module",
  "module_declaration",
  "module_binding", // ocaml / rescript
  "mod_item",
  "namespace_definition",
  "namespace_declaration", // c#
  "object_declaration", // kotlin
  "object_definition", // scala
  "component_named_def", // systemrdl (reg / field / regfile / addrmap / mem …)
  // type aliases / bindings
  "type_alias_declaration",
  "type_declaration",
  "type_item",
  "type_spec", // go
  "type_binding", // ocaml / rescript
  "let_binding", // ocaml / rescript
]);

/**
 * Value node types that make a `const X = …` binding itself a definition, taking
 * the binding's name and the value's kind. Covers JS/TS arrow consts and Zig's
 * `const Foo = struct {…}` / `enum {…}` idiom.
 */
const VALUE_DEFINITION_TYPES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "struct_declaration",
  "enum_declaration",
  "union_declaration",
]);

/** Exact node-type -> kind, where the substring heuristic would be wrong. */
const KIND_OVERRIDES: Readonly<Record<string, string>> = {
  protocol_declaration: "interface",
  protocol_function_declaration: "method",
  init_declaration: "constructor",
  object_declaration: "object",
  object_definition: "object",
  contract_declaration: "contract",
  operator_definition: "operator",
  macro_definition: "macro",
  component_named_def: "component",
};

/** Node types whose text is a usable symbol name (for the identifier fallback). */
const NAME_NODE = /identifier|(?:^|_)name$/;

/** Wrapper node types to climb through when looking for a doc comment. */
const DECL_WRAPPERS: ReadonlySet<string> = new Set([
  "export_statement",
  "ambient_declaration",
  "decorated_definition",
  "declaration",
]);

/** Identifier-like node types whose text is a callable name. */
const IDENT_TYPES: ReadonlySet<string> = new Set([
  "identifier", "field_identifier", "property_identifier", "type_identifier",
  "shorthand_property_identifier", "name", "simple_identifier",
]);

/**
 * Per-grammar call/invocation node types and the field naming the callee, for
 * `findCallLines`. Curated for the common languages; a grammar absent here
 * parses but reports no call sites, so callers degrade honestly. The callee
 * falls back to the first named child when the field is absent.
 */
const CALL_SPECS: Readonly<Record<string, ReadonlyArray<{ type: string; field?: string }>>> = {
  typescript: [{ type: "call_expression", field: "function" }, { type: "new_expression", field: "constructor" }],
  tsx: [{ type: "call_expression", field: "function" }, { type: "new_expression", field: "constructor" }],
  javascript: [{ type: "call_expression", field: "function" }, { type: "new_expression", field: "constructor" }],
  python: [{ type: "call", field: "function" }],
  go: [{ type: "call_expression", field: "function" }],
  rust: [{ type: "call_expression", field: "function" }, { type: "macro_invocation", field: "macro" }],
  java: [{ type: "method_invocation", field: "name" }, { type: "object_creation_expression", field: "type" }],
  c: [{ type: "call_expression", field: "function" }],
  cpp: [{ type: "call_expression", field: "function" }],
  ruby: [{ type: "call", field: "method" }, { type: "method_call", field: "method" }],
};

/**
 * Tree-sitter (via WASM) outline and symbol slicing. Grammars load lazily and
 * are cached; extracted outlines are memoized in a small LRU so a file parsed
 * once is not parsed again. A symbol miss, a budget degrade, and `code_outline`
 * followed by `code_read` on the same content all reuse the first parse. All node
 * access happens synchronously inside {@link AstService.run} before the tree's
 * WASM memory is freed.
 */
export class AstService {
  private initialized = false;
  private readonly grammars = new Map<string, Language | null>();
  /** LRU of extracted outlines, keyed by file path + content fingerprint. */
  private readonly outlineCache = new Map<string, SymbolInfo[]>();
  private static readonly OUTLINE_CACHE_MAX = 8;

  constructor(private readonly log: Logger) {}

  /** Initialise the WASM runtime once (idempotent). */
  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await Parser.init();
    } catch {
      // Fallback: point emscripten at web-tree-sitter's own core wasm.
      const dir = path.dirname(require.resolve("web-tree-sitter/package.json"));
      await Parser.init({ locateFile: (file: string) => path.join(dir, file) });
    }
    this.initialized = true;
  }

  /** Grammar id for a file path, or undefined if unsupported. */
  grammarIdFor(filePath: string): string | undefined {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    return EXT_TO_GRAMMAR[ext];
  }

  /** Whether this file path maps to a supported grammar. */
  supports(filePath: string): boolean {
    return this.grammarIdFor(filePath) !== undefined;
  }

  /**
   * All top-level + nested definitions in source order.
   * @returns `undefined` if the file type has no grammar; `[]` if none found.
   */
  async outline(filePath: string, code: string): Promise<SymbolInfo[] | undefined> {
    if (this.grammarIdFor(filePath) === undefined) return undefined;

    const key = `${filePath}\u0000${code.length}\u0000${fingerprint(code)}`;
    const cached = this.outlineCache.get(key);
    if (cached !== undefined) {
      this.outlineCache.delete(key); // refresh LRU recency
      this.outlineCache.set(key, cached);
      return [...cached]; // hand out a copy so callers can't mutate the cache
    }

    const result = await this.run(filePath, code, (root, src) => {
      const out: SymbolInfo[] = [];
      this.walk(root, src, undefined, out);
      return out;
    });
    if (result === undefined) return undefined; // grammar present but load failed

    this.outlineCache.set(key, result);
    if (this.outlineCache.size > AstService.OUTLINE_CACHE_MAX) {
      const oldest = this.outlineCache.keys().next().value;
      if (oldest !== undefined) this.outlineCache.delete(oldest);
    }
    return [...result]; // hand out a copy so callers can't mutate the cache
  }

  /**
   * Definitions named `name` (there may be more than one).
   * @returns `undefined` if the file type has no grammar; `[]` if none match.
   */
  async findSymbol(
    filePath: string,
    code: string,
    name: string,
  ): Promise<SymbolInfo[] | undefined> {
    const all = await this.outline(filePath, code);
    if (all === undefined) return undefined;
    return all.filter((s) => s.name === name);
  }

  /**
   * 1-based line numbers where `calleeName` is the callee of a call/invocation.
   * AST-precise, not text matches: it excludes imports, types, and comments.
   * @returns `undefined` if the file type has no grammar or no call mapping
   * (so callers can degrade honestly); `[]` if mapped but no calls match.
   */
  async findCallLines(filePath: string, code: string, calleeName: string): Promise<number[] | undefined> {
    const id = this.grammarIdFor(filePath);
    if (id === undefined) return undefined;
    const specs = CALL_SPECS[id];
    if (specs === undefined) return undefined; // grammar parses, but calls aren't mapped
    const result = await this.run(filePath, code, (root) => {
      const lines = new Set<number>();
      this.walkCalls(root, specs, calleeName, lines, 0);
      return [...lines].sort((a, b) => a - b);
    });
    return result;
  }

  /**
   * Every call/invocation in the file as `{name, line}` (the callee name and the
   * 1-based line). Used by `call_hierarchy` to list a function's callees.
   * @returns `undefined` if the file type has no grammar or no call mapping.
   */
  async findCalls(filePath: string, code: string): Promise<Array<{ name: string; line: number }> | undefined> {
    const id = this.grammarIdFor(filePath);
    if (id === undefined) return undefined;
    const specs = CALL_SPECS[id];
    if (specs === undefined) return undefined;
    return this.run(filePath, code, (root) => {
      const out: Array<{ name: string; line: number }> = [];
      this.walkAllCalls(root, specs, out, 0);
      return out;
    });
  }

  private walkAllCalls(
    node: Node,
    specs: ReadonlyArray<{ type: string; field?: string }>,
    out: Array<{ name: string; line: number }>,
    depth: number,
  ): void {
    if (depth > 4000 || out.length > 20000) return;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      const spec = specs.find((s) => s.type === child.type);
      if (spec) {
        const callee = (spec.field ? child.childForFieldName(spec.field) : null) ?? child.namedChild(0);
        const name = callee ? this.calleeName(callee) : undefined;
        if (name && callee) out.push({ name, line: callee.startPosition.row + 1 });
      }
      this.walkAllCalls(child, specs, out, depth + 1);
    }
  }

  private walkCalls(
    node: Node,
    specs: ReadonlyArray<{ type: string; field?: string }>,
    target: string,
    out: Set<number>,
    depth: number,
  ): void {
    if (depth > 4000 || out.size > 5000) return;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      const spec = specs.find((s) => s.type === child.type);
      if (spec) {
        const callee = (spec.field ? child.childForFieldName(spec.field) : null) ?? child.namedChild(0);
        const name = callee ? this.calleeName(callee) : undefined;
        if (name === target && callee) out.add(callee.startPosition.row + 1);
      }
      this.walkCalls(child, specs, target, out, depth + 1);
    }
  }

  /** The called name from a callee node: a bare identifier, or the member/field/path tail. */
  private calleeName(node: Node): string | undefined {
    if (IDENT_TYPES.has(node.type)) return node.text;
    for (const f of ["property", "field", "name", "attribute"]) {
      const c = node.childForFieldName(f);
      if (c && IDENT_TYPES.has(c.type)) return c.text;
    }
    // Computed/subscript callees (obj[key](), arr[i]()) have no static name; the
    // last named child is the index expression, not the callee, so don't guess.
    if (node.type === "subscript_expression" || node.type === "subscript") return undefined;
    let last: Node | undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c && IDENT_TYPES.has(c.type)) last = c;
    }
    return last?.text;
  }

  /**
   * Syntax faults (ERROR / MISSING nodes) in `code`.
   * @returns `undefined` if the file type has no grammar; `[]` if it parses clean.
   */
  async findSyntaxErrors(filePath: string, code: string): Promise<SyntaxIssue[] | undefined> {
    return this.run(filePath, code, (root, src) => {
      const out: SyntaxIssue[] = [];
      if (root.hasError) this.collectErrors(root, src, out);
      return out;
    });
  }

  /**
   * Syntax errors that an edit would introduce: errors present in `newContent`
   * but not in `oldContent`. Returns `[]` when the file type has no grammar, the
   * new content is clean, or the old content was already broken (so a fix isn't
   * blocked). This is the deterministic guard behind code_edit and code_write.
   */
  async introducedSyntaxErrors(
    filePath: string,
    oldContent: string,
    newContent: string,
  ): Promise<SyntaxIssue[]> {
    const after = await this.findSyntaxErrors(filePath, newContent);
    if (after === undefined) return []; // no grammar
    // Block only on introduced MISSING nodes (an absent or unclosed token, e.g.
    // an unbalanced bracket). Generic ERROR nodes are deliberately not blocked:
    // tree-sitter emits them for valid-but-newer syntax the bundled grammar does
    // not know yet (e.g. TS `accessor` fields, `in`/`out` variance), which would
    // be false positives that wrongly refuse correct edits.
    const afterMissing = after.filter((i) => i.kind === "missing");
    if (afterMissing.length === 0) return [];
    const before = await this.findSyntaxErrors(filePath, oldContent);
    if (before === undefined) return [];
    if (before.some((i) => i.kind === "missing")) return []; // already had missing tokens
    return afterMissing;
  }

  /** Collect ERROR/MISSING nodes (capped and depth-bounded) within error subtrees. */
  private collectErrors(node: Node, src: string, out: SyntaxIssue[], depth = 0): void {
    if (depth > 200) return; // defensive bound against pathological nesting
    for (let i = 0; i < node.childCount && out.length < 20; i++) {
      const c = node.child(i);
      if (!c) continue;
      if (c.isError || c.isMissing) {
        out.push({
          kind: c.isMissing ? "missing" : "error",
          line: c.startPosition.row + 1,
          column: c.startPosition.column + 1,
          text: c.isMissing
            ? `\`${c.type || "token"}\``
            : truncate(src.slice(c.startIndex, c.endIndex).replace(/\s+/g, " ").trim() || c.type, 40),
        });
        continue; // the whole node is the fault; don't descend into it
      }
      if (c.hasError) this.collectErrors(c, src, out, depth + 1);
    }
  }

  /** Load (and cache) the grammar for a file path. */
  private async grammarFor(filePath: string): Promise<Language | undefined> {
    const id = this.grammarIdFor(filePath);
    if (id === undefined) return undefined;
    if (this.grammars.has(id)) return this.grammars.get(id) ?? undefined;
    await this.init();
    const wasmPath = path.join(WASM_DIR, `tree-sitter-${id}.wasm`);
    try {
      const lang = await Language.load(wasmPath);
      this.grammars.set(id, lang);
      return lang;
    } catch (err) {
      this.log.warn(`failed to load grammar "${id}" (${wasmPath})`, err);
      this.grammars.set(id, null); // negative-cache so we don't retry
      return undefined;
    }
  }

  /**
   * Parse, run `fn` synchronously against the root node, then free WASM memory.
   * `fn` must extract everything it needs; it cannot retain nodes past return.
   */
  private async run<T>(
    filePath: string,
    code: string,
    fn: (root: Node, src: string) => T,
  ): Promise<T | undefined> {
    const lang = await this.grammarFor(filePath);
    if (!lang) return undefined;
    // Construct inside the try too: if an earlier trap left the shared WASM heap
    // corrupted, even `new Parser()` / setLanguage can throw — degrade, don't escape.
    let parser: Parser | null = null;
    let tree: ReturnType<Parser["parse"]> = null;
    try {
      parser = new Parser();
      parser.setLanguage(lang);
      tree = parser.parse(code);
      if (tree === null) {
        this.log.warn(`parse returned null for ${filePath}`);
        return undefined;
      }
      return fn(tree.rootNode, code);
    } catch (err) {
      // A grammar can throw a WASM RuntimeError; degrade instead of propagating.
      this.log.warn(`parse/extract failed for ${filePath}`, err);
      return undefined;
    } finally {
      // Free WASM memory now that everything is extracted into plain objects.
      // A parse that trapped (e.g. "memory access out of bounds") can leave the
      // instance so corrupted that delete() itself throws; a throw here would
      // escape the catch above and surface as a tool error, defeating the
      // graceful degrade. Swallow cleanup failures (logged) so the worst case is
      // skipped validation, never a failed edit.
      try {
        tree?.delete();
      } catch (err) {
        this.log.warn(`tree.delete() failed for ${filePath}`, err);
      }
      try {
        parser?.delete();
      } catch (err) {
        this.log.warn(`parser.delete() failed for ${filePath}`, err);
      }
    }
  }

  /** Depth-first walk; pushes each definition, recursing with it as container. */
  private walk(
    node: Node,
    src: string,
    container: string | undefined,
    out: SymbolInfo[],
    depth = 0,
  ): void {
    // Defensive bound (mirrors walkCalls/collectErrors): a pathologically nested
    // AST must truncate the outline, not overflow the V8 stack mid-walk.
    if (depth > 2000 || out.length > 50000) return;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      const defs = this.definitionsOf(child, src);
      if (defs.length > 0) {
        for (const d of defs) {
          out.push(container !== undefined ? { ...d, container } : d);
        }
        // Recurse with the first definition's name as the container for members.
        this.walk(child, src, defs[0]!.name, out, depth + 1);
      } else {
        this.walk(child, src, container, out, depth + 1);
      }
    }
  }

  /** Zero or more definitions introduced directly by `node`. */
  private definitionsOf(node: Node, src: string): SymbolInfo[] {
    const type = node.type;
    if (DEFINITION_TYPES.has(type)) {
      const name = this.nameOf(node, src);
      return name === undefined
        ? [] // anonymous definition: skip
        : [this.symbolAt(node, kindFromType(type), name, src)];
    }
    if (type === "lexical_declaration" || type === "variable_declaration") {
      return this.bindingDefinitions(node, src);
    }
    return [];
  }

  /**
   * Definitions from a `const/var` binding whose value is itself a definition:
   * `const f = () => {}`, `const Foo = struct {…}` (Zig), and the multi-binding
   * `const a = () => {}, b = function () {}` (one symbol per declarator).
   */
  private bindingDefinitions(node: Node, src: string): SymbolInfo[] {
    const perDeclarator: SymbolInfo[] = [];
    let declaratorCount = 0;
    for (let i = 0; i < node.namedChildCount; i++) {
      const decl = node.namedChild(i);
      if (!decl || !/declarator/.test(decl.type)) continue;
      declaratorCount++;
      const value = decl.childForFieldName("value");
      if (!value || !VALUE_DEFINITION_TYPES.has(value.type)) continue;
      const nameNode = decl.childForFieldName("name");
      if (nameNode) {
        perDeclarator.push(
          this.symbolAt(decl, kindFromType(value.type), textOf(nameNode, src), src),
        );
      }
    }
    // Sole declarator in the statement: report the whole declaration (nicer
    // signature). With multiple declarators, scope each symbol to its own
    // declarator so a sibling binding can't leak into its signature/range.
    if (declaratorCount === 1 && perDeclarator.length === 1) {
      const only = perDeclarator[0]!;
      return [this.symbolAt(node, only.kind, this.nameOf(node, src) ?? only.name, src)];
    }
    if (perDeclarator.length > 0) return perDeclarator;

    // Zig: `const Foo = struct {…}`, where the value is a direct child, no declarator.
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (!c || !VALUE_DEFINITION_TYPES.has(c.type)) continue;
      const name = this.nameOf(node, src);
      if (name !== undefined) {
        return [this.symbolAt(node, kindFromType(c.type), name, src)];
      }
    }
    return [];
  }

  /** Build a {@link SymbolInfo} (without `container`) for `node`. */
  private symbolAt(node: Node, kind: string, name: string, src: string): SymbolInfo {
    const span = this.outerSpan(node);
    return {
      kind,
      name,
      signature: this.signatureOf(node, src),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startIndex: span.startIndex,
      endIndex: span.endIndex,
      hasDoc: this.hasDoc(node),
    };
  }

  /**
   * The char span of a definition including its leading `export`, decorator, and
   * `declare` wrappers, so an exact splice replaces the whole declaration as it
   * appears in source. A sole `const`/`var` binding expands to its declaration
   * statement; one of several bindings stays the single declarator, so replacing
   * one never clobbers its siblings.
   */
  private outerSpan(node: Node): { startIndex: number; endIndex: number } {
    let top: Node = node;
    if (top.type === "variable_declarator") {
      const decl = top.parent;
      if (decl && (decl.type === "lexical_declaration" || decl.type === "variable_declaration")) {
        let declarators = 0;
        for (let i = 0; i < decl.namedChildCount; i++) {
          if (decl.namedChild(i)?.type === "variable_declarator") declarators++;
        }
        if (declarators === 1) top = decl;
      }
    }
    while (top.parent && DECL_WRAPPERS.has(top.parent.type)) top = top.parent;
    return { startIndex: top.startIndex, endIndex: top.endIndex };
  }

  /**
   * Resolve a definition's name: a `const/var` binding's declarator name, the
   * `name` field, a C-style `declarator` chain (function_definition ->
   * function_declarator -> identifier), or else the first identifier-like child.
   */
  private nameOf(node: Node, src: string): string | undefined {
    if (
      node.type === "lexical_declaration" ||
      node.type === "variable_declaration"
    ) {
      for (let i = 0; i < node.namedChildCount; i++) {
        const decl = node.namedChild(i);
        if (!decl || !/declarator/.test(decl.type)) continue;
        const n = decl.childForFieldName("name");
        if (n) return textOf(n, src);
      }
    }

    const named = node.childForFieldName("name");
    if (named) return textOf(named, src);

    // Some grammars (e.g. SystemRDL) put the name in an `id` field.
    const idField = node.childForFieldName("id");
    if (idField) return textOf(idField, src);

    // C-family: the name is nested under a `declarator` field chain.
    let d: Node | null = node.childForFieldName("declarator");
    while (d) {
      if (NAME_NODE.test(d.type)) return textOf(d, src);
      const inner = d.childForFieldName("declarator");
      if (!inner) {
        const n = d.childForFieldName("name");
        return n ? textOf(n, src) : undefined;
      }
      d = inner;
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c && NAME_NODE.test(c.type)) return textOf(c, src);
    }
    return undefined;
  }

  /** Source from node start to its `body` (or node end), collapsed and capped. */
  private signatureOf(node: Node, src: string): string {
    const body = node.childForFieldName("body");
    const end = body ? body.startIndex : node.endIndex;
    const raw = src.slice(node.startIndex, Math.max(node.startIndex, end));
    const collapsed = raw.replace(/\s+/g, " ").trim();
    return truncate(collapsed, 160);
  }

  /**
   * Best-effort doc detection: a preceding comment (after climbing export and
   * decorator wrappers), or a Python-style docstring as the first body statement.
   * Any surprise returns false.
   */
  private hasDoc(node: Node): boolean {
    try {
      let top: Node = node;
      while (top.parent && DECL_WRAPPERS.has(top.parent.type)) {
        top = top.parent;
      }
      const prev = top.previousSibling;
      if (prev && /comment/.test(prev.type)) return true;
      const prevNamed = top.previousNamedSibling;
      if (prevNamed && /comment/.test(prevNamed.type)) return true;

      const body = node.childForFieldName("body");
      const first = body?.namedChild(0);
      if (first) {
        if (first.type === "string") return true;
        if (first.type === "expression_statement") {
          const inner = first.namedChild(0);
          if (inner && inner.type === "string") return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }
}

/** Derive a coarse `kind` from a node type string (override map, then substring). */
function kindFromType(type: string): string {
  const override = KIND_OVERRIDES[type];
  if (override) return override;
  const t = type.toLowerCase();
  // "constructor" contains the substring "struct", so test it first.
  if (t.includes("constructor")) return "constructor";
  if (t.includes("class")) return "class";
  if (t.includes("interface")) return "interface";
  if (t.includes("enum")) return "enum";
  if (t.includes("struct")) return "struct";
  if (t.includes("union")) return "union";
  if (t.includes("trait")) return "trait";
  if (t.includes("impl")) return "impl";
  if (t.includes("namespace") || t.includes("module") || t.includes("mod")) {
    return "module";
  }
  if (t.includes("type")) return "type";
  if (t.includes("method")) return "method";
  return "function";
}

/** Exact source slice for a node. */
function textOf(node: Node, src: string): string {
  return src.slice(node.startIndex, node.endIndex);
}

/** Fast 32-bit FNV-1a fingerprint of source, used in the outline cache key. */
function fingerprint(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
