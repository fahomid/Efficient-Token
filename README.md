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
| `health` | Confirm the server is connected and see tier / workspace / limits. *(read-only)* |
| `code_outline` | List a file's symbols (functions, classes, methods, types) with line ranges and signatures — not the source. *(read-only)* |
| `code_read` | Read source faithfully but minimally: one **symbol**, a **line range**, or a **whole file** that degrades to an outline + head when it exceeds the token budget. *(read-only)* |
| `glob` | List file **paths** matching a glob/type (no content), like Claude's `Glob` — find files without reading directories. *(read-only)* |
| `read_many` | Read **several symbols / ranges / files in one call** (the read-side analog of `apply_patch`) — labeled, budget-bounded; cuts per-call round-trips. *(read-only)* |
| `json_query` | Extract a **value from a JSON file by a dotted/bracket path** (e.g. `scripts.build`, `items[0].name`) instead of reading the whole file; with no query, a shallow **top-level overview** (keys + types/sizes). Token-bounded. *(read-only)* |
| `read_at_rev` | The historical `code_read`: read **one symbol / line range / whole file as of a git revision** (degrades to an outline over budget) instead of `git show <ref>:file` dumping everything. *(read-only)* |
| `code_search` | Regex search across the workspace (Claude `Grep`/ripgrep): `files_with_matches` (default), `content` (matching lines), or `count`; `glob`/`type` filters, context lines, case-insensitive, multiline. Returns matches — not whole files. *(read-only)* |
| `find_references` | Locate where a symbol is **defined** (AST-precise: kind + line + signature) and **used** (identifier-boundary scan) across the workspace, as `file:line` locations. *(read-only)* |
| `call_sites` | Where a symbol is actually **called** (AST callee of a call/invocation) — not text matches: excludes imports, type uses, comments, value-passing. Each hit `file:line + enclosing symbol + the call line`. TS/JS, Python, Go, Rust, Java, C/C++, Ruby. *(read-only)* |
| `symbol_find` | Find where symbols are **defined** by name — exact or `substring` (fuzzy recall) — returning `file:line` + kind + signature; optional `kind` filter. *(read-only)* |
| `grep_context` | Regex search that returns each match **with its enclosing function/class source** (deduped, line-numbered, matched lines marked `›`) — one call instead of search → open-each-file. *(read-only)* |
| `code_context` | One-shot **task primer** for a symbol: its definition source + the workspace symbols it **uses** (with signatures) + where it's **referenced** — primes a task without chasing dependencies. *(read-only)* |
| `repo_map` | A token-bounded **table of contents**: the file tree grouped by directory, with each source file's top-level symbols (classes/functions/types). Orient in a codebase without reading files. *(read-only)* |
| `diff_digest` | Review git changes as **hunks only** (or a `--stat` summary / file list) — `ref`/`staged`/`path` scoped — instead of reading whole changed files. Read-only git. *(read-only)* |
| `commit_log` | Compact **commit history** — one row per commit (`sha date author subject`, no bodies/diffs) — scoped by `path`/`ref`/`limit`, instead of raw `git log`. *(read-only)* |
| `line_blame` | **Line provenance** via `git blame`, with contiguous same-commit runs **collapsed into ranges** (`Lstart-Lend sha date author summary`). Scope to a symbol/range; marks uncommitted lines. *(read-only)* |
| `review_branch` | **Semantic** change summary: each changed file with the **symbols that changed** (functions/classes), mapped from the diff to the AST — review a branch/PR without reading hunks. *(read-only)* |
| `symbol_history` | The history of **one symbol** (or line range) via `git log -L` — `list` (commits that touched it) or `hunks` (per-revision diff of just that span) — instead of `git log` + per-commit `git show` dragging in whole files. *(read-only)* |
| `conflict_digest` | Show only the **three-way regions of merge-conflicted files** (ours / base / theirs, verbatim + line-numbered) instead of reading whole files to find `<<<<<<<` markers. Extracts only — you decide the resolution. *(read-only)* |
| `change_coverage` | Intersect your **changed lines with an lcov coverage artifact** — "did I test my change?" — listing covered vs **uncovered changed lines + enclosing symbol**, instead of reading a huge coverage report by hand. *(read-only)* |
| `code_check` | Run one of the project's **own** `package.json` scripts (test/build/lint/typecheck) and return a one-line PASS or **bounded failure output** — never the whole log. Allowlisted to defined scripts; no arbitrary commands. *(executes)* |
| `check_locate` | Like `code_check`, but on failure it parses `file:line` from the output and returns the **failing source + enclosing symbol** — "the check failed → here's the code" in one call. *(executes)* |
| `code_edit` | Exact find-and-replace in a file (Claude `Edit` semantics): `oldString` must match **verbatim** and be **unique** unless `replaceAll=true`; refuses missing/ambiguous matches; atomic write. **Refuses (and never writes) a change that would leave an unclosed/unbalanced token** (e.g. a missing `}`) — reports the location so you can retry — unless `validate=false`. *(mutating)* |
| `code_write` | Create or fully overwrite a file (Claude `Write` semantics); creates parent dirs; atomic write. Same **syntax-error recovery guard** as `code_edit` (`validate=false` to override). *(mutating)* |
| `replace_symbol` | Replace a whole **function/class/method definition by NAME** — pass only the new source, not the old body as a match anchor (as `code_edit` needs). Resolves the span via the AST (export/decorator-aware, line-ending/BOM faithful), disambiguates by `container`/`occurrence`, runs the same syntax guard, atomic write. Kills re-sending the existing body on every whole-symbol rewrite. *(mutating)* |
| `apply_patch` | Apply **many edits across one or more files in one atomic call** (all-or-nothing). Each edit follows `code_edit` semantics; validated (incl. syntax guard) in memory first — if anything fails, nothing is written. Cuts the round-trips of editing files one at a time. *(mutating)* |
| `note_write` / `note_read` | A small persistent **scratchpad** under `.efficient-token/notes/` — stash and recall plans/findings across steps and agents without re-deriving them. *(write / read)* |
| `project_rename` | Rename an identifier **across the whole workspace in one atomic call** (identifier-boundary, syntax-guarded, `dryRun`-able) instead of find_references → edit each file. Textual (scope with `path`/`type`). *(mutating)* |

Read tools declare `readOnlyHint`; the two mutating tools declare `destructiveHint` so hosts can gate them. All writes stay inside the workspace root (symlink/ADS-safe) and are atomic (temp + rename).

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
