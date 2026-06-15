# Contributing to efficient-token

Thanks for your interest. This project is **open-core**: the free tier is open
source under the [MIT license](./LICENSE). Contributions to the free tier are
welcome.

## Ground rules

The design rests on one principle and a short list of hard conventions. Read
[`ARCHITECTURE.md`](./ARCHITECTURE.md) before writing code; it is the authoritative brief.
The essentials:

- **Faithful on reasoning paths.** Anything the model will reason over (source
  code, document text) is returned losslessly, as real slices and real symbols.
  Savings come from returning *less*, never from summarizing or paraphrasing.
- **Deterministic, never a judgment call.** A tool detects and transforms
  deterministically. If a feature would require interpreting intent, that stays
  with the model; the server only supplies faithful material.
- **stdout is the MCP protocol stream.** Never `console.log`. All logging goes to
  stderr via the logger service.
- **ESM and NodeNext.** Local imports must carry a `.js` extension in TS source.
- **Plugins depend only on `CoreContext`.** Never import another plugin. Shared
  capability lives in core services.
- **Only the loader touches the SDK** and does tier and bundle gating.
- **All filesystem access goes through the path sandbox; writes are atomic.**
- **Tools never throw into the transport.** Wrap handlers and return the uniform
  `ok` / `fail` envelope.
- **Tool `description` text ships to the model every turn.** Keep it tight and say
  when to use the tool instead of a built-in. Check the cost with
  `npm run toolcost`.

## Development setup

```bash
npm install
npm run typecheck    # tsc --noEmit
npm run build        # emit dist/
npm test             # smoke + e2e (must print ALL PASS)
npm run dev          # run the server from source via tsx
```

| Script | What it does |
| --- | --- |
| `npm run build` | Compile `src/` → `dist/`. |
| `npm run typecheck` | Type-check without emitting. |
| `npm run smoke` | In-process self-test of every tool. |
| `npm run e2e` | Real stdio round-trip against the built server. |
| `npm run toolcost` | Report the fixed per-turn token cost of each tool. |
| `npm run discover` | Inspect a tree-sitter grammar's node types (for adding a language). |

## Adding a tool (the one-at-a-time workflow)

1. Create `src/plugins/<name>/index.ts` exporting a factory that returns a
   `Plugin`. Talk only to `ctx`; set the correct `tier` and `group`.
2. Add one entry to the `plugins` array in `src/index.ts`. That is the only edit
   outside the new folder.
3. Add a smoke check in `scripts/smoke.ts` and a README tool-table row.
4. Keep the description tight; confirm the cost with `npm run toolcost`.

Nothing else changes and nothing else can break. That is the point of the contract.

### Adding a language

Grammars are WASM (`tree-sitter-wasms`). Map the file extension in
`EXT_TO_GRAMMAR` (`src/services/ast.ts`) and, if needed, extend the
`DEFINITION_TYPES`, `KIND_OVERRIDES`, and `VALUE_DEFINITION_TYPES` tables. Do this
empirically, from real grammar output via `npm run discover`.

## Definition of Done

Implements the contract and depends on `ctx` only · correct `tier`/`group` ·
tight descriptions · uniform result envelope, never throws · faithful (no lossy
summarizing) · smoke test added · README tool-table entry · `npm test` is green.

## Pull requests

- Branch from `main`; keep PRs focused.
- Run `npm run typecheck && npm test` and make sure both are green.
- Update `CHANGELOG.md` under `## [Unreleased]`.
- Describe what changed and why; note any new env vars or behavior.

## Reporting bugs / security issues

Open a [GitHub issue](https://github.com/fahomid/Efficient-Token/issues) for
bugs. For anything security-sensitive, follow [`SECURITY.md`](./SECURITY.md)
instead of filing a public issue.
