# efficient-token

[![CI](https://github.com/fahomid/Efficient-Token/actions/workflows/ci.yml/badge.svg)](https://github.com/fahomid/Efficient-Token/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/efficient-token.svg)](https://www.npmjs.com/package/efficient-token)
[![Node](https://img.shields.io/node/v/efficient-token.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A **local-first [MCP](https://modelcontextprotocol.io) server** that does
deterministic code work on your machine and returns only distilled, faithful
results to the model. It cuts token usage without degrading reasoning.

The one principle everything obeys: anything the model will *reason over* (source
code, document text) is returned losslessly, as real slices and real symbols.
Savings come from returning less (one symbol instead of a whole file), never from
summarizing. The server detects and transforms deterministically; it never makes
a judgment the model should make.

## Requirements

- Node.js **>= 18**. Uses ESM and WASM tree-sitter, with no native build step.

## Install & build

```bash
npm install
npm run build      # tsc -> dist/index.js
npm run smoke      # self-test; prints "ALL PASS"
```

## Register with Claude Code

Use the absolute path to the built entrypoint:

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
| `EFFICIENT_TOKEN_ROOT` | current working dir | Workspace root. All file access is confined here. |
| `EFFICIENT_TOKEN_MAX_READ_TOKENS` | `6000` | Whole-file read budget before `code_read` degrades to an outline. |
| `EFFICIENT_TOKEN_MAX_FILE_BYTES` | `2000000` | Hard cap on the size of any file the server will read. |
| `EFFICIENT_TOKEN_GROUPS` | *(all)* | Comma-separated tool bundles to register. Every tool definition ships to the model each turn at a fixed token cost, so a project can drop bundles it never uses. The bundles are `core` (everything except the design tools) and `design` (`color_contrast`, `font_info`, `design_tokens`, `svg_digest`, `token_usage`, `media_info`). Unset loads all. Set `EFFICIENT_TOKEN_GROUPS=core` in a pure-code repo to save roughly 760 tokens per turn, or `EFFICIENT_TOKEN_GROUPS=core,design` for UI and video work. Run `npm run toolcost` to see the exact per-bundle cost. |

## Tools (free tier)

45 tools, grouped by what you reach for. Every tool is read-only unless
marked *(mutating)* or *(executes)*.

#### Read & navigate

| Tool | Use it to… |
| --- | --- |
| `health` | Confirm the server is connected and see tier, workspace, and limits, plus the estimated tokens saved this session by distilled reads. The baseline is exact: whole-file size against what was returned. *(read-only)* |
| `code_outline` | List a file's symbols (functions, classes, methods, types) with line ranges and signatures, without the source. *(read-only)* |
| `code_read` | Like Claude's `Read` (same `file_path`/`offset`/`limit`, cat-n output) but leaner: it can also extract one symbol, and a whole-file read over budget degrades to an outline plus head rather than dumping the file. *(read-only)* |
| `glob` | List file paths matching a glob or type, with no content, like Claude's `Glob` (same `pattern`/`path`). Use it to find files without reading directories. Sorted by name for reproducibility rather than by mtime. *(read-only)* |
| `read_many` | Read several symbols, ranges, or files in one call, the read-side analog of `apply_patch`. Output is labeled and budget-bounded, which cuts per-call round-trips. *(read-only)* |
| `json_query` | Extract a value from a JSON file by a dotted or bracket path (`scripts.build`, `items[0].name`) instead of reading the whole file. With no query it returns a shallow top-level overview of keys with their types and sizes. Token-bounded. *(read-only)* |
| `read_at_rev` | The historical `code_read`: read one symbol, line range, or whole file as of a git revision, degrading to an outline over budget, instead of letting `git show <ref>:file` dump everything. *(read-only)* |

#### Creative & design

| Tool | Use it to… |
| --- | --- |
| `view_image` | See raster image files (png/jpg/gif/webp/avif/bmp) directly: pass paths, get them back as viewable images. Use it to inspect a rendered frame, screenshot, or exported asset instead of guessing or asking for a paste. Oversized files are refused. *(read-only)* |
| `media_info` | Distilled facts about image, video, and audio files: format, dimensions, aspect ratio, and byte size, plus duration, fps, and codec for A/V when `ffprobe` is present. It reads metadata without loading the bytes. An optional `fps` maps a duration to a frame count. *(read-only)* |
| `design_tokens` | Distill a project's design tokens (colors, sizes and spacing, typography) as verbatim `name=value` pairs from CSS custom properties and design-token JSON, grouped by kind, instead of re-reading whole stylesheets. *(read-only)* |
| `color_contrast` | Deterministic color math. Compute the WCAG contrast ratio with AA/AAA pass/fail between two colors, or convert one color between hex, rgb, and hsl. Accepts hex (3/4/6/8), rgb(), hsl(), and common names. *(read-only)* |
| `svg_digest` | An SVG's structure: `viewBox`, intrinsic size, an element-type histogram, and defined ids, without dumping the verbose markup and path data. A structural digest in the spirit of `code_outline`. *(read-only)* |
| `font_info` | The real family and style of fonts rather than a guess from filenames. Reads family and subfamily from TTF/OTF `name` tables, and `@font-face` declarations (family, weight, style, src) from CSS. *(read-only)* |
| `token_usage` | Audit CSS custom properties: which are defined but never referenced via `var()`, and which are used but never defined, each with a `file:line`, instead of cross-checking by eye. *(read-only)* |

#### Search & symbols

| Tool | Use it to… |
| --- | --- |
| `code_search` | Like Claude's `Grep` (ripgrep), with the same params: `output_mode` (`files_with_matches`/`content`/`count`), `glob`/`type`, `-A`/`-B`/`-C`, `-i`, `-n`, `-o`, `head_limit`, `multiline`. Returns matches, not whole files. *(read-only)* |
| `find_references` | Locate where a symbol is defined (AST-precise: kind, line, signature) and where it is used (identifier-boundary scan) across the workspace, as `file:line` locations. *(read-only)* |
| `call_sites` | Where a symbol is actually called (the AST callee of a call or invocation), not text matches. It excludes imports, type uses, comments, and value-passing. Each hit gives `file:line`, the enclosing symbol, and the call line. Covers TS/JS, Python, Go, Rust, Java, C/C++, Ruby. *(read-only)* |
| `call_hierarchy` | A function's local call neighborhood in one call: its callees (functions it calls, each with where it's defined) and its callers (workspace call sites). For callers alone, `call_sites` is lighter. *(read-only)* |
| `marker_inventory` | Inventory code-comment markers (TODO/FIXME/HACK/XXX/BUG, or custom `tags`) across the workspace, grouped by tag, each as `file:line + text`. It matches only after a comment leader so prose isn't a false positive. *(read-only)* |
| `import_map` | A file's dependency edges: what it imports (workspace files vs external packages) and who imports it (dependents), resolved across the workspace instead of grepping import lines. JS/TS family. *(read-only)* |
| `symbol_find` | Find where symbols are defined by name, exact or `substring` for fuzzy recall, returning `file:line` with kind and signature. Takes an optional `kind` filter. *(read-only)* |
| `grep_context` | Regex search that returns each match with its enclosing function or class source (deduped, line-numbered, matched lines marked `›`). One call replaces a search followed by opening each file. *(read-only)* |
| `code_context` | A task primer for a symbol in one shot: its definition source, the workspace symbols it uses (with signatures), and where it is referenced. Primes a task without chasing dependencies. *(read-only)* |
| `type_closure` | A type's definition plus the verbatim defs of the workspace types it transitively references (cycle-safe, depth-bounded). Understand a complex type in one call instead of chasing each referenced type. *(read-only)* |
| `repo_map` | A token-bounded table of contents: the file tree grouped by directory, with each source file's top-level symbols (classes, functions, types). Orient in a codebase without reading files. *(read-only)* |

#### Git & review

| Tool | Use it to… |
| --- | --- |
| `diff_digest` | Review git changes as hunks only, or as a `--stat` summary or file list, scoped by `ref`/`staged`/`path`, instead of reading whole changed files. Read-only git. *(read-only)* |
| `commit_log` | Compact commit history, one row per commit (`sha date author subject`, no bodies or diffs), scoped by `path`/`ref`/`limit` instead of raw `git log`. *(read-only)* |
| `line_blame` | Line provenance via `git blame`, with contiguous same-commit runs collapsed into ranges (`Lstart-Lend sha date author summary`). Scope it to a symbol or range; uncommitted lines are marked. *(read-only)* |
| `review_branch` | A semantic change summary: each changed file with the symbols that changed (functions, classes), mapped from the diff to the AST. Review a branch or PR without reading hunks. *(read-only)* |
| `symbol_history` | The history of one symbol or line range via `git log -L`, as `list` (commits that touched it) or `hunks` (per-revision diff of just that span), instead of `git log` plus per-commit `git show` dragging in whole files. *(read-only)* |
| `outline_diff` | A symbol-level delta between two revisions: per changed file, the symbols added, removed, or changed. An API-surface diff that skips the hunks. Works on arbitrary rev-to-rev, whereas `review_branch` is working-tree and changed-only. *(read-only)* |
| `conflict_digest` | Show only the three-way regions of merge-conflicted files (ours, base, theirs, verbatim and line-numbered) instead of reading whole files to find `<<<<<<<` markers. It extracts only; you decide the resolution. *(read-only)* |
| `change_coverage` | Intersect your changed lines with an lcov coverage artifact to answer "did I test my change?". Lists covered against uncovered changed lines with the enclosing symbol, instead of reading a huge coverage report yourself. *(read-only)* |

#### Run & locate

| Tool | Use it to… |
| --- | --- |
| `code_check` | Run one of the project's own `package.json` scripts (test, build, lint, typecheck) and return a one-line PASS or bounded failure output, never the whole log. Allowlisted to defined scripts, so no arbitrary commands. *(executes)* |
| `check_locate` | Like `code_check`, but on failure it parses `file:line` from the output and returns the failing source with its enclosing symbol. The check failed, so here's the code, in one call. *(executes)* |
| `trace_locate` | Paste a stack trace or error output and get the source at each `file:line` frame, with context and the enclosing symbol. External and `node_modules` frames are skipped. Same locator as `check_locate`, run on text you supply. *(read-only)* |
| `test_run` | Run a focused test by forwarding a `filter` to a package.json test script (`npm run test -- <filter>`), returning PASS or a bounded failure tail with the failing source, instead of the whole suite. Only package.json scripts run, and the filter is charset-restricted to exclude shell metacharacters. *(executes)* |

#### Edit & session *(atomic, syntax-guarded)*

| Tool | Use it to… |
| --- | --- |
| `code_edit` | Like Claude's `Edit` (same `file_path`/`old_string`/`new_string`/`replace_all`): the match must be verbatim and unique unless `replace_all=true`, missing or ambiguous matches are refused, and the write is atomic. It adds a guard that refuses a change leaving an unclosed token, such as a missing `}`, unless `validate=false`. *(mutating)* |
| `code_write` | Like Claude's `Write` (same `file_path`/`content`); creates parent dirs and writes atomically. Carries the same syntax-error guard as `code_edit`, overridable with `validate=false`. *(mutating)* |
| `replace_symbol` | Replace a whole function, class, or method definition by name: pass only the new source, not the old body as a match anchor the way `code_edit` needs. It resolves the span via the AST (export- and decorator-aware, line-ending and BOM faithful), disambiguates by `container`/`occurrence`, runs the same syntax guard, and writes atomically. This avoids re-sending the existing body on every whole-symbol rewrite. *(mutating)* |
| `apply_patch` | Apply many edits across one or more files in one atomic, all-or-nothing call. Each edit is `{ file_path, old_string, new_string, replace_all? }`, as in `code_edit`. Everything (including the syntax guard) is validated in memory first; if anything fails, nothing is written. This removes the round-trips of editing files one at a time. *(mutating)* |
| `move_symbol` | Relocate a definition from one file to another atomically, rewriting the named imports and re-exports of it across the workspace, and importing it back into the source if it's still used. It is `dryRun`-able and syntax-guarded; default and namespace importers, along with the moved code's own deps, are flagged rather than guessed. JS/TS. *(mutating)* |
| `note_write` / `note_read` | A small persistent scratchpad under `.efficient-token/notes/`. Stash and recall plans and findings across steps and agents without re-deriving them. *(write / read)* |
| `project_rename` | Rename an identifier across the whole workspace in one atomic call (identifier-boundary, syntax-guarded, `dryRun`-able) instead of running find_references and editing each file. Textual, scoped with `path`/`type`. *(mutating)* |

Read tools declare `readOnlyHint`, and the mutating tools declare `destructiveHint` so hosts can gate them. All writes stay inside the workspace root (symlink- and ADS-safe) and are atomic via temp file plus rename.

### Language support

`code_read` and `code_outline` use [tree-sitter](https://tree-sitter.github.io/)
(via WASM). Language is chosen by file extension (`src/services/ast.ts`).

**Full symbol outlines.** Functions, classes, methods, types, and the like are
extracted accurately:

> TypeScript (`.ts .mts .cts`), TSX (`.tsx`), JavaScript (`.js .mjs .cjs .jsx`),
> Python (`.py`), Ruby (`.rb`), PHP (`.php`), Go (`.go`), Rust (`.rs`),
> Zig (`.zig`), C (`.c .h`), C++ (`.cpp .cc .cxx .hpp .hh .hxx`), C# (`.cs`),
> Objective-C (`.m`), Java (`.java`), Kotlin (`.kt .kts`), Scala (`.scala .sc`),
> Swift (`.swift`), Dart (`.dart`), OCaml (`.ml .mli`), ReScript (`.res .resi`),
> Emacs Lisp (`.el`), Lua (`.lua`), Bash (`.sh .bash .zsh`), Solidity (`.sol`),
> SystemRDL (`.rdl`), TLA⁺ (`.tla`)

**Parse-only.** These parse, so `code_read` works everywhere, but produce few or
no outline symbols by design. They are markup, config, data, or macro-based
definitions:

> HTML (`.html .htm`), CSS (`.css`), Vue (`.vue`), ERB/EJS (`.erb .ejs`),
> JSON (`.json`), TOML (`.toml`), Elixir (`.ex .exs`)

Any other file type still works with `code_read` in range or whole-file mode;
only the symbol-aware features need a grammar. Adding a language is usually a
one-line entry in `EXT_TO_GRAMMAR`. Run `npm run discover` to inspect a grammar's
nodes.

> Note: the `elm`, `codeql`, and `yaml` grammars exist in `tree-sitter-wasms` but
> are intentionally not mapped, because they are ABI-incompatible with or crash
> this `web-tree-sitter` runtime (verified in `scripts/discover.ts`). Also, `.m`
> is treated as Objective-C, since there is no MATLAB grammar.

## Architecture

A small kernel that knows nothing about any feature, plus plugins that receive a
shared `CoreContext` and depend only on it, never on each other.

```
src/
  core/      contract.ts · config.ts · loader.ts · result.ts · read.ts
             text.ts · edits.ts · git.ts · run-script.ts
  services/  logger.ts · paths.ts · fs.ts · ast.ts · scan.ts
             budget.ts · savings.ts · license.ts
  plugins/   one folder per tool (45 tools across the groups above)
  index.ts   bootstrap: build ctx, register plugins, serve over stdio
scripts/
  smoke.ts   in-process self-test      e2e.ts      real-stdio round-trip
  toolcost.ts per-turn cost report     discover.ts grammar node inspector
```

- stdout is the MCP protocol stream. The server never writes to it; all logs go
  to stderr.
- All filesystem access is sandboxed to the workspace root, and writes are atomic.
- The license layer is a free-only stub today. Premium tools register through the
  same loader behind an entitlement check, which is the open-core seam.

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
else changes. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full workflow.

## Contributing & security

- [`CONTRIBUTING.md`](./CONTRIBUTING.md): dev setup, the plugin contract, and the
  Definition of Done.
- [`SECURITY.md`](./SECURITY.md): the sandbox and security model, and how to report
  a vulnerability privately.
- [`CHANGELOG.md`](./CHANGELOG.md): release history.

## License

[MIT](./LICENSE) (free tier). See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the architecture
brief and the open-core premium seam.
