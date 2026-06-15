# Architecture

This document describes the architecture, conventions, and hard-won environment
notes for **efficient-token**. It is the design reference for contributors.

---

## What this is

A local-first MCP server that does deterministic code work on the user's machine
and returns only distilled, faithful results to the model, cutting token usage
without degrading reasoning.

The one principle everything obeys: anything the model will *reason over* (source
code, document text) is returned losslessly, as real slices and real extracted
text. Savings come from returning *less* (one symbol, not a whole file), never
from summarizing. A local tool detects and transforms deterministically; it does
not make a judgment the model should make. If a feature would require interpreting
intent (for example "what does this code mean", or "write the comment"), that
stays with the model. The server only supplies faithful material and applies the
model's decisions.

The business model is open-core. The free tier is open source. Premium
(whole-project) tools come later behind a licensing seam that is wired in now but
inert.

The current implementation covers the core kernel and the free-tier tools under
`src/`. Read-side tools include `health`, `code_outline`, `code_read`, `read_many`
(batch read), `glob` (list paths), `code_search` (regex), `grep_context` (search
plus enclosing symbol), `find_references` (symbol defs plus uses), `symbol_find`
(locate defs by name/substring), `code_context` (symbol primer: def plus uses plus
refs), `repo_map` (project table of contents), `diff_digest` (git hunks), and
`review_branch` (changed files to changed symbols). Mutating tools are `code_edit`
(exact find-and-replace), `code_write` (create/overwrite), `apply_patch` (atomic
multi-file batch edit), and `project_rename` (workspace-wide identifier rename,
atomic with dryRun). Execution tools are `code_check` (run an allowlisted
package.json script, failures-only) and `check_locate` (run a script plus jump to
the failing source). Session tools are `note_write` and `note_read` (scratchpad
under `.efficient-token/notes/`). The repo also ships `package.json`,
`tsconfig.json`, `README.md`, a smoke test (`npm run smoke`), and a real-stdio
e2e test (`npm run e2e`). The entitlement and premium-plugin phases are not built
yet; the license layer is the inert free-only stub described below.

---

## Tech stack (pinned)

- **TypeScript**, **ESM**, `module`/`moduleResolution`: **NodeNext**, target ES2022.
- **@modelcontextprotocol/sdk** (recent 1.x, see `package.json`): MCP server plus
  stdio transport. The `title` option in `registerTool` needs a 1.x newer than
  1.12 (see the environment notes); the dependency is pinned accordingly.
- **web-tree-sitter** ^0.25 plus **tree-sitter-wasms** ^0.1.11: AST via WASM
  grammars (no native build step).
- **zod** ^3.25: tool input schemas.
- Dev: **tsx** (run TS directly), **typescript**, **@types/node**. Node >= 18.

---

## Conventions

1. **ESM plus NodeNext means local imports carry a `.js` extension** in TS source,
   for example `import { ok } from "../core/result.js";` (even though the file is
   `result.ts`). Omitting it breaks the build at runtime.
2. **stdout is the MCP protocol stream.** Do not `console.log`. All logging goes to
   stderr via the logger service. A stray stdout write corrupts the transport and
   the host disconnects.
3. **Faithful on reasoning paths.** Do not summarize or paraphrase code or document
   content that the model will reason over. Return real source.
4. **Tool `description` text ships to the model every turn**, so it is a recurring
   token cost. Keep descriptions tight and say when to use a given tool instead of
   a built-in.
5. **Plugins depend only on `CoreContext` and never import another plugin.** Shared
   capability lives in core services. This is what guarantees no cross-feature
   cascade.
6. **The loader is the only code that touches the SDK and does tier-gating.**
   Plugins just declare a `tier` and a list of tools.
7. **All filesystem access goes through the path sandbox; writes are atomic.**
8. **Tools never throw into the transport.** Handlers are wrapped in try/catch and
   return the uniform result envelope (`ok` / `fail`).

### Verified environment notes
- `web-tree-sitter` 0.25 exports **named** `Parser` and `Language`:
  `import { Parser, Language, type Node } from "web-tree-sitter";`
  Init once with `await Parser.init();` then
  `const lang = await Language.load(wasmPath); const p = new Parser(); p.setLanguage(lang); const tree = p.parse(code);`
  `tree` may be null, so guard it. Use `tree.rootNode`. `Language.load` accepts a
  filesystem **path string** or a `Uint8Array` of wasm bytes (not a `URL` object).
  `Tree`/`Parser` hold WASM memory, so extract everything you need synchronously,
  then call `tree.delete()` / `parser.delete()` (the server does this per parse).
- Grammar `.wasm` files live in **tree-sitter-wasms**'s `out/` dir. Resolve with:
  ```ts
  import { createRequire } from "node:module";
  const require = createRequire(import.meta.url);
  const WASM_DIR = path.dirname(require.resolve("tree-sitter-wasms/package.json")) + "/out/";
  // e.g. WASM_DIR + "tree-sitter-typescript.wasm"
  ```
  Files are named `tree-sitter-<grammar>.wasm`. The one irregular name: C# is
  `tree-sitter-c_sharp.wasm` (underscore), so map the `.cs` ext to grammar id
  `c_sharp`, not `c-sharp`/`cs`. All others follow the ext-to-grammar map directly
  (ts to typescript, rs to rust, rb to ruby, and so on).
- MCP tool registration (high-level API):
  ```ts
  server.registerTool(name, { title, description, inputSchema }, handler);
  ```
  where `inputSchema` is a Zod raw shape (a plain object of Zod fields, for example
  `{ path: z.string() }`, not `z.object(...)`). The handler returns
  `{ content: [{ type: "text", text }], isError? }`.
  The `title` config key was added in a later 1.x of the SDK (it is absent in
  1.12.x, where only `description`/`inputSchema`/`outputSchema`/`annotations`
  exist). `package.json` therefore pins a recent 1.x so `title` is in the types;
  the loader passes `title` only when a tool declares one.
- Build with `rootDir: "src"`, `include: ["src"]` so output is `dist/index.js`
  (matching `bin` and the MCP host registration). Run scripts via `tsx`.

---

## Architecture and file layout

The core (kernel) knows nothing about any specific feature. Every feature is a
plugin implementing the contract and receiving a shared `CoreContext`.

```
efficient-token/
  package.json          # type: module; bin -> dist/index.js
  tsconfig.json         # NodeNext, rootDir src, outDir dist
  README.md
  src/
    core/
      contract.ts       # Plugin, CoreContext, ToolDef, ToolResult, Tier
      config.ts         # workspace root + limits from env
      loader.ts         # tier-gate + register tools (only code touching the SDK)
      result.ts         # ok() / fail() / errMessage()
      read.ts           # readTarget(): shared symbol/range/whole-file read
      text.ts           # numberLines() / splitLines() / truncate()
      edits.ts          # applyStringEdit(): shared literal-replace primitive
      git.ts            # runGit() / gitOk(): shared read-only git helpers
      run-script.ts     # runNpmScript() (tree-kill on timeout) + boundedTail()
    services/
      logger.ts         # stderr-only Logger
      paths.ts          # PathSandbox (confine to workspace root)
      fs.ts             # SafeFs (size-guarded read, atomic write)
      ast.ts            # AstService (tree-sitter outline + symbol slice)
      scan.ts           # Scanner (deterministic sandboxed file walk + glob)
      budget.ts         # TokenBudgeter (~4 chars/token estimate)
      license.ts        # Entitlement stub (free only; premium seam)
    plugins/
      health/index.ts        # built-in liveness/config tool (free)
      code-outline/index.ts
      code-read/index.ts
      read-many/index.ts      # batch read of symbols/ranges/files (read-side apply_patch)
      glob/index.ts           # list file paths by glob/type
      code-search/index.ts    # regex search across the workspace
      grep-context/index.ts   # search + enclosing-symbol source (dedup, bounded)
      find-references/index.ts # symbol definitions (AST) + usages (text scan)
      symbol-find/index.ts    # locate definitions by name/substring (AST)
      code-context/index.ts   # symbol primer: definition + uses + references
      repo-map/index.ts       # project table of contents (tree + top-level symbols)
      diff-digest/index.ts    # git changes as hunks/stat/files (read-only git)
      review-branch/index.ts  # semantic diff: changed files -> changed symbols
      code-check/index.ts     # run an allowlisted package.json script (failures-only)
      check-locate/index.ts   # run a script + locate failing source (file:line + symbol)
      code-edit/index.ts      # exact find-and-replace
      code-write/index.ts     # create / overwrite a file
      apply-patch/index.ts    # atomic multi-file batch edit (all-or-nothing)
      note/index.ts           # note_write/note_read scratchpad (.efficient-token/notes)
      project-rename/index.ts # workspace-wide identifier rename (atomic, dryRun)
    index.ts            # bootstrap: build ctx, register core + plugins, stdio
  scripts/
    smoke.ts            # self-test (run via tsx)
```

The read/edit/write/search tools mirror the built-in Read/Edit/Write/Grep
behavior of an MCP host such as Claude Code, so they are familiar to use and
return less material per call.

### The plugin contract

```ts
export type Tier = "free" | "premium";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title?: string;
  description: string;            // tight; ships to the model every turn
  inputSchema: import("zod").ZodRawShape;   // raw shape, not z.object()
  handler: (args: any) => Promise<ToolResult>;
}

export interface CoreContext {
  config: Config;
  paths: PathSandbox;
  fs: SafeFs;
  ast: AstService;
  budget: TokenBudgeter;
  license: Entitlement;          // read-only to plugins
  log: Logger;
}

export interface Plugin {
  name: string;
  version: string;
  tier: Tier;
  tools: ToolDef[];
  init?(ctx: CoreContext): void | Promise<void>;  // capture ctx here
}
```

A plugin is a factory function that closes over a `let ctx` filled in `init`:

```ts
export function codeOutlinePlugin(): Plugin {
  let ctx: CoreContext;
  return {
    name: "code-outline", version: "0.1.0", tier: "free",
    init(c) { ctx = c; },
    tools: [{ name: "code_outline", description: "...", inputSchema: { path: z.string() },
      handler: async ({ path: p }) => { /* uses ctx; try/catch -> ok()/fail() */ } }],
  };
}
```

### Loader (the gate)

```ts
for (const plugin of plugins) {
  if (!ctx.license.isEntitled(plugin.tier)) continue;   // premium skipped until paid
  await plugin.init?.(ctx);
  for (const t of plugin.tools)
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema }, t.handler as never);
}
```

### License stub (the premium seam)

`createEntitlement()` returns `{ tier: "free", isEntitled: t => t === "free" }`.
When premium ships, the real implementation drops in here (Supabase plus Stripe
plus Ed25519-signed license tokens, verified offline against an embedded public
key; periodic online re-check with offline grace; only license status crosses the
wire, never user code). Nothing else changes.

---

## Core services and responsibilities

- **PathSandbox**: `resolve(p)` returns an absolute path or throws if it escapes
  the workspace root (rejecting `..` traversal). On Windows it also rejects NTFS
  alternate data streams (a `:` in the final segment, for example `f.ts::$DATA`).
  `relative(abs)` produces compact output.
- **SafeFs**: `read(p)` rejects non-files and files over `maxFileBytes`, strips a
  leading UTF-8 BOM, and returns `{ abs, content, lineCount }`. `readRaw(p)` is the
  same but BOM-preserving, for `code_edit`'s verbatim round-trip. `writeAtomic(p,
  content)` writes via temp plus rename. `exists(p)` checks presence. Everything
  goes via the sandbox. Both read and write additionally `realpath`-check the
  target (writes check the nearest existing ancestor before `mkdir`, then the dir
  after) so a symlinked path component cannot escape root.
- **AstService**: `init()`, `grammarFor(filePath)`, `outline(filePath, code)`
  returning `SymbolInfo[]`, and `findSymbol(filePath, code, name)`. Definition
  extraction is heuristic, by walking named nodes (see below). `EXT_TO_GRAMMAR`
  maps about 53 file extensions to 33 grammars: 26 with full symbol outlines and 7
  parse-only. The full-outline languages are TS/JS, Python, Ruby, PHP, Go, Rust,
  Zig, C/C++/C#, Objective-C, Java, Kotlin, Scala, Swift, Dart, OCaml, ReScript,
  Elisp, Lua, Bash, Solidity, TLA+, and SystemRDL; HTML/CSS/Vue/ERB/JSON/TOML/
  Elixir are parse-only. The `DEFINITION_TYPES` allowlist plus `KIND_OVERRIDES`
  plus `VALUE_DEFINITION_TYPES` are curated from real grammar output via
  `scripts/discover.ts` (`npm run discover`); extend them there, empirically, when
  adding a language. The `elm`/`codeql`/`yaml` grammars are intentionally not
  mapped (ABI-incompatible or crash this web-tree-sitter runtime). `outline()` is
  memoized in a small LRU keyed by file path plus a content fingerprint, so a
  symbol miss, a budget degrade, and `code_outline` followed by `code_read` on the
  same content reuse one parse. WASM trees/parsers are freed (`delete()`) per
  parse; parse errors are caught and degrade to "no symbols" rather than
  propagating. `findSyntaxErrors(path, code)` returns ERROR/MISSING nodes
  (line/col/kind). `introducedSyntaxErrors(path, old, new)` is the deterministic
  guard behind `code_edit`/`code_write`. It blocks only on introduced MISSING
  nodes (an absent or unclosed token, for example an unbalanced bracket), which is
  high precision, and deliberately not on generic ERROR nodes, since the bundled
  grammars emit ERROR for valid-but-newer syntax (TS `accessor`, `in`/`out`
  variance) that would be false positives. `validate:false` overrides the guard;
  an already-broken file (pre-existing MISSING) is never blocked, so
  fixes-in-progress go through.
- **Scanner**: `files({within?, glob?, exts?, maxFiles?})` deterministically walks
  the workspace (pre-order, name-sorted), skipping `node_modules`/`.git`/build
  dirs, with basename-vs-fullpath glob semantics (like ripgrep). Shared by
  `code_search` and the reference/map tools.
- **TokenBudgeter**: `estimate(text)=ceil(len/4)`, `fits(text, max)`.
- **Entitlement**: the stub above.
- **Logger**: `info/warn/error` to stderr only.

### AstService extraction rules
- Walk `namedChild`ren recursively; track the nearest enclosing definition name as
  `container` (so methods get their class).
- A node is a definition if its `type` is in the `DEFINITION_TYPES` allowlist
  (function/method/class/interface/protocol/contract/type/enum/struct/union/trait/
  impl/module/object/binding across languages), or if it is a
  `lexical_declaration`/`variable_declaration` whose value is in
  `VALUE_DEFINITION_TYPES`: an `arrow_function`/`function_expression`
  (`const foo = () => {}`) or a Zig `struct`/`enum`/`union`
  (`const Foo = struct {…}`). Multi-binding declarations
  (`const a = () => {}, b = () => {}`) yield one symbol per declarator.
- `name`: `childForFieldName("name")`, else the `id` field (SystemRDL), else a
  C-style `declarator` chain (`function_definition` to `function_declarator` to
  `identifier`), else the first child matching `NAME_NODE` =
  `/identifier|(?:^|_)name$/` (the `_name$` arm catches OCaml `value_name`/
  `module_name`).
- `kind`: `KIND_OVERRIDES[type]` (protocol to interface, init to constructor,
  object/contract/operator/macro/component, and so on), else a substring match on
  the type string. Order matters: test `constructor` before `struct`, because
  "con**struct**or" contains "struct".
- `signature`: source from `node.startIndex` to the `body` field's `startIndex` (or
  node end), whitespace collapsed, capped to about 160 code points via the shared
  `truncate()` helper (which slices on code-point boundaries so an astral character
  or emoji is never split into a lone, ill-formed surrogate).
- `startLine/endLine`: `startPosition.row + 1` / `endPosition.row + 1` (1-based).
- `hasDoc` (best-effort, wrapped in try/catch): climb through wrapper parents
  (`export_statement`, `ambient_declaration`, `decorated_definition`), then check
  `previousSibling` for a comment node, or (Python) whether the first body
  statement is a string. Defaults to false on any surprise.

`SymbolInfo = { kind, name, container?, signature, startLine, endLine, hasDoc }`.

---

## The two foundational read tools

### `code_outline` (free)
- Input: `{ path: string }`.
- Read the file, get `outline()`. If there is no grammar, tell the model to use
  `code_read`. If there are no symbols, say so.
- Output: a header of the form `rel`, a separator, and `N symbol(s)`, then one
  block per symbol: `L{start}-{end}  {kind} {container?.}{name}{ [no doc]?}` plus
  an indented signature.

### `code_read` (free), the workhorse
- Input: `{ path, symbol?, startLine?, endLine?, maxTokens? }`.
- **Mode symbol**: `findSymbol`; if none, return the list of defined names so the
  model can recover; if found, return that symbol's real source, line-numbered,
  with a header that combines `rel` and `{kind} {name} (lines a-b of total)`,
  noting extra matches if any.
- **Mode range**: clamp to file bounds, return the numbered slice.
- **Mode whole-file**: if `fits(content, maxTokens ?? config.maxReadTokens)`,
  return the numbered file; otherwise degrade by returning the outline plus a
  bounded head (up to 40 lines, each capped to about 400 code points, total within
  about maxTokens) plus an instruction to request a specific symbol or range. A
  file over budget is never silently dumped; the head is bounded by size too, so a
  single huge line (minified JS/CSS, one-line JSON) cannot blow the budget.
- Lines are split with `splitLines()` (which handles `\r\n`/`\r`/`\n` and strips
  one trailing terminator, so there is no stray `\r` and no phantom empty last line
  or off-by-one in the `of N` counts).
- All output uses `numberLines(lines, startLineNo)` (right-aligned `N| code`).

---

## Build, run, test

```bash
npm install
npm run build        # tsc -> dist/index.js
npm run smoke        # tsx scripts/smoke.ts  (self-test, prints ALL PASS on success)
```

### Register with an MCP host (use the absolute path)
```bash
claude mcp add --transport stdio efficient-token -- node /abs/path/efficient-token/dist/index.js
# optional explicit workspace:
#   --env EFFICIENT_TOKEN_ROOT=/abs/path/to/project
```

### Config (env)
`EFFICIENT_TOKEN_ROOT` (default cwd), `EFFICIENT_TOKEN_MAX_READ_TOKENS` (6000),
`EFFICIENT_TOKEN_MAX_FILE_BYTES` (2000000).

---

## Adding a new plugin

1. Create `src/plugins/<name>/index.ts` exporting a factory returning a `Plugin`.
2. Talk only to `ctx`; set the correct `tier`.
3. Add one entry to the `plugins` array in `src/index.ts`. That is the only edit
   outside the new folder.
4. Add a smoke check, and a tight tool description.

Nothing else changes, and nothing else can break.

### Definition of done (per plugin)
Implements the contract and depends on `ctx` only; correct `tier`; tight
descriptions; uniform result envelope, never throws; faithful (no lossy
summarizing); smoke test; README plus tool-table entry.

---

## Roadmap

Later phases build on earlier ones.

- **Phase 0, core kernel**: contract, services, loader, license stub, `health`
  tool. The foundation.
- **Phase 1, free-tier plugins**: `code_outline`, `code_read`, `code_search`
  (regex), `code_edit` (exact string replace, atomic), `code_write`
  (create/overwrite, atomic), `find_references` (symbol defs plus uses),
  `repo_map` (project map), `diff_digest` (git hunks), and `code_check`
  (allowlisted runner, failures only). Workflow tools (round-trip reducers) are
  also in place: `apply_patch`, `grep_context`, `code_context`, `review_branch`,
  `check_locate`, `note_write`/`note_read`, and `project_rename`. A remaining idea
  is `code_doc` (scaffold plus AST-correct placement plus `@param` consistency,
  with the model authoring the text).
- **Phase 2, entitlement**: replace the license stub (Supabase plus Stripe plus
  Ed25519 plus activation plus encrypted premium-bundle delivery plus seat-lock
  plus revocation).
- **Phase 3, premium plugins**: repo map, impact analysis, project review plus
  dead-code (flag candidates; removal gated by `code_check` with rollback), PR
  diff digest, coverage/test targeting, profiler runner, PDF/spreadsheet/docx
  extraction (lazy and faithful), dependency audit/license compliance, and
  project-wide rename.

Free now, premium later. Every premium feature stays behind the loader's
entitlement check via its `tier`.
