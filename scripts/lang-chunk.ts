/**
 * Minimal worker for one chunk of the multi-language outline sweep, run as its own
 * short-lived process by smoke.ts. It imports ONLY AstService (not the rest of the
 * suite or any plugin), so its module graph and memory footprint are tiny: it loads
 * just this chunk's grammars into web-tree-sitter's WASM heap, then exits and frees
 * it. This keeps each process well under the memory ceiling that Node 24's V8 hits
 * when many grammars accumulate in one process.
 *
 * Usage: node --import tsx scripts/lang-chunk.ts <startIndex>
 * Prints `  PASS/FAIL  ...` lines, then a final `__LANG__ <passed> <failed>`.
 */
import { AstService } from "../src/services/ast.js";
import { createLogger } from "../src/services/logger.js";
import { LANG_CASES, LANG_CHUNK } from "./langcases.js";

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

async function main(): Promise<void> {
  const start = Number.parseInt(process.argv[2] ?? "0", 10);
  const ast = new AstService(createLogger());
  await ast.init();
  for (const { ext, code, expect } of LANG_CASES.slice(start, start + LANG_CHUNK)) {
    const out = await ast.outline(`sample.${ext}`, code);
    const names = new Set((out ?? []).map((s) => s.name));
    if (expect) {
      const missing = expect.filter((n) => !names.has(n));
      check(`lang ${ext} outlines [${expect.join(",")}]`, Array.isArray(out) && missing.length === 0, `missing [${missing.join(",")}], got [${[...names].join(",")}]`);
    } else {
      check(`lang ${ext} parses (Tier B)`, Array.isArray(out), `got ${out === undefined ? "undefined" : "array"}`);
    }
  }
  console.log(`__LANG__ ${passed} ${failed}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
