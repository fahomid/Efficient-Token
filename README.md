# efficient-token

A **local-first [MCP](https://modelcontextprotocol.io) server** that does
deterministic code work on your machine and returns only distilled, **faithful**
results to the model — cutting token usage **without degrading reasoning**.

The one principle everything obeys: anything the model will *reason over* (source
code, document text) is returned **losslessly** — real slices, real symbols.
Savings come from returning **less** (one symbol, not a whole file), never from
summarizing. The server detects and transforms deterministically; it never makes
a judgment the model should make.

## Requirements

- Node.js **>= 18** (uses ESM + WASM tree-sitter; no native build step).

## Install & build

```bash
npm install
npm run build      # tsc -> dist/index.js
npm run smoke      # self-test; prints "ALL PASS"
```

## Register with Claude Code

Use the **absolute** path to the built entrypoint:

```bash
claude mcp add --transport stdio efficient-token -- node /abs/path/efficient-token/dist/index.js
# optional: pin the workspace the server is allowed to touch
#   --env EFFICIENT_TOKEN_ROOT=/abs/path/to/your/project
```

During development you can skip the build step and run the TypeScript directly:

```bash
claude mcp add --transport stdio efficient-token -- npx tsx /abs/path/efficient-token/src/index.ts
```

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `EFFICIENT_TOKEN_ROOT` | current working dir | Workspace root; **all** file access is confined here. |
| `EFFICIENT_TOKEN_MAX_READ_TOKENS` | `6000` | Whole-file read budget before `code_read` degrades to an outline. |
| `EFFICIENT_TOKEN_MAX_FILE_BYTES` | `2000000` | Hard cap on the size of any file the server will read. |

## Tools (free tier)

| Tool | Use it to… |
| --- | --- |
| `health` | Confirm the server is connected and see tier / workspace / limits. |
| `code_outline` | List a file's symbols (functions, classes, methods, types) with line ranges and signatures — not the source. |
| `code_read` | Read source faithfully but minimally: one **symbol**, a **line range**, or a **whole file** that degrades to an outline + head when it exceeds the token budget. |

### Language support

`code_read` and `code_outline` use [tree-sitter](https://tree-sitter.github.io/)
(via WASM). Language is chosen by file extension (`src/services/ast.ts`).

**Full symbol outlines** — functions, classes, methods, types, etc. are extracted
accurately:

> TypeScript (`.ts .mts .cts`), TSX (`.tsx`), JavaScript (`.js .mjs .cjs .jsx`),
> Python (`.py`), Ruby (`.rb`), PHP (`.php`), Go (`.go`), Rust (`.rs`),
> Zig (`.zig`), C (`.c .h`), C++ (`.cpp .cc .cxx .hpp .hh .hxx`), C# (`.cs`),
> Objective-C (`.m`), Java (`.java`), Kotlin (`.kt .kts`), Scala (`.scala .sc`),
> Swift (`.swift`), Dart (`.dart`), OCaml (`.ml .mli`), ReScript (`.res .resi`),
> Emacs Lisp (`.el`), Lua (`.lua`), Bash (`.sh .bash .zsh`), Solidity (`.sol`),
> SystemRDL (`.rdl`), TLA⁺ (`.tla`)

**Parse-only** — these parse (so `code_read` works everywhere), but produce few or
no outline symbols by design (markup/config/data, or macro-based definitions):

> HTML (`.html .htm`), CSS (`.css`), Vue (`.vue`), ERB/EJS (`.erb .ejs`),
> JSON (`.json`), TOML (`.toml`), Elixir (`.ex .exs`)

Any other file type still works with `code_read` in range/whole-file mode; only
the symbol-aware features need a grammar. Adding a language is usually a one-line
entry in `EXT_TO_GRAMMAR` — run `npm run discover` to inspect a grammar's nodes.

> Note: `elm`, `codeql`, and `yaml` grammars exist in `tree-sitter-wasms` but are
> intentionally **not** mapped — they are ABI-incompatible with or crash this
> `web-tree-sitter` runtime (verified in `scripts/discover.ts`). Also, `.m` is
> treated as Objective-C (there is no MATLAB grammar).

## Architecture

A small **kernel** that knows nothing about any feature, plus **plugins** that
receive a shared `CoreContext` and depend only on it — never on each other.

```
src/
  core/      contract.ts · config.ts · loader.ts · result.ts · text.ts
  services/  logger.ts · paths.ts · fs.ts · ast.ts · budget.ts · license.ts
  plugins/   health · code-outline · code-read
  index.ts   bootstrap: build ctx, register plugins, serve over stdio
scripts/
  smoke.ts   self-test
```

- **stdout is the MCP protocol stream** — the server never writes to it; all logs
  go to stderr.
- **All filesystem access is sandboxed** to the workspace root; writes are atomic.
- The **license layer** is a free-only stub today; premium tools register through
  the same loader behind an entitlement check (open-core).

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full project brief, hard conventions, and
the plugin contract.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # emit dist/
npm run smoke       # run the self-test
npm run dev         # run the server from source via tsx
```

Adding a plugin: create `src/plugins/<name>/index.ts` exporting a factory that
returns a `Plugin`, talk only to `ctx`, set the correct `tier`, add one entry to
the `plugins` array in `src/index.ts`, and extend `scripts/smoke.ts`. Nothing
else changes.

## License

[MIT](./LICENSE) (free tier).
