/**
 * End-to-end integration test: spawn the BUILT server (`dist/index.js`) and
 * drive it over a real MCP stdio transport. Proves the protocol round-trips and
 * that stdout carries only JSON-RPC (a stray log would corrupt parsing here).
 *
 * Requires a prior `npm run build`. Run: `npm run e2e`.
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SAMPLE_TS = `export function add(a: number, b: number): number {
  return a + b;
}

export class Greeter {
  greet(): string {
    return "hi";
  }
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

function resultText(res: { content?: Array<{ type: string; text?: string }> }): string {
  return (res.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

async function main(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "efficient-token-e2e-"));
  await fsp.writeFile(path.join(root, "sample.ts"), SAMPLE_TS, "utf8");
  await fsp.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "e2e-fixture", version: "1.0.0", scripts: { ok: 'node -e "process.exit(0)"' } }, null, 2),
  );

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.EFFICIENT_TOKEN_ROOT = root;

  const transport = new StdioClientTransport({
    command: process.execPath, // current node binary
    args: [path.resolve("dist/index.js")],
    env,
    stderr: "inherit",
  });
  const client = new Client({ name: "efficient-token-e2e", version: "0.0.0" });

  try {
    await client.connect(transport);
    check("client connects over stdio", true);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    check(
      "tools/list returns the fifteen free tools",
      names.join(",") === "apply_patch,check_locate,code_check,code_context,code_edit,code_outline,code_read,code_search,code_write,diff_digest,find_references,grep_context,health,repo_map,review_branch",
      names.join(","),
    );
    const byName = new Map(tools.map((t) => [t.name, t]));
    check(
      "read tools annotated read-only",
      ["health", "code_outline", "code_read", "code_search", "find_references", "repo_map", "diff_digest", "grep_context", "code_context", "review_branch"].every(
        (n) => byName.get(n)?.annotations?.readOnlyHint === true && byName.get(n)?.annotations?.openWorldHint === false,
      ),
    );
    check(
      "write tools annotated destructive (not read-only)",
      ["code_edit", "code_write", "apply_patch"].every(
        (n) => byName.get(n)?.annotations?.readOnlyHint === false && byName.get(n)?.annotations?.destructiveHint === true,
      ),
    );
    check(
      "exec tools annotated non-read-only",
      ["code_check", "check_locate"].every((n) => byName.get(n)?.annotations?.readOnlyHint === false),
    );

    const health = await client.callTool({ name: "health", arguments: {} });
    check("health round-trips", resultText(health).includes("efficient-token: ok"));

    const outline = await client.callTool({
      name: "code_outline",
      arguments: { path: "sample.ts" },
    });
    check("code_outline round-trips", resultText(outline).includes("class Greeter"));

    const read = await client.callTool({
      name: "code_read",
      arguments: { path: "sample.ts", symbol: "add" },
    });
    const readTxt = resultText(read);
    check(
      "code_read symbol round-trips",
      readTxt.includes("function add") && readTxt.includes("return a + b;"),
    );

    // write -> read -> edit -> read round-trip over the wire
    const wrote = await client.callTool({
      name: "code_write",
      arguments: { path: "gen/hello.txt", content: "one\ntwo\n" },
    });
    check("code_write creates a file over the wire", !wrote.isError && resultText(wrote).includes("Created"));
    const readBack = await client.callTool({ name: "code_read", arguments: { path: "gen/hello.txt" } });
    check("written file reads back", resultText(readBack).includes("two"));
    const edited = await client.callTool({
      name: "code_edit",
      arguments: { path: "gen/hello.txt", oldString: "two", newString: "TWO" },
    });
    check("code_edit applies over the wire", !edited.isError && resultText(edited).includes("replacement"));
    const confirm = await client.callTool({ name: "code_read", arguments: { path: "gen/hello.txt" } });
    check("edit persisted", resultText(confirm).includes("TWO") && !resultText(confirm).includes("| two"));

    // syntax recovery guard over the wire: a brace-breaking edit is refused and rolled back
    await client.callTool({ name: "code_write", arguments: { path: "gen/g.ts", content: "export function g() {\n  return 1;\n}\n" } });
    const breakEdit = await client.callTool({ name: "code_edit", arguments: { path: "gen/g.ts", oldString: "  return 1;\n}", newString: "  return 1;" } });
    check("code_edit syntax guard rejects over the wire", breakEdit.isError === true && resultText(breakEdit).includes("syntax error"));
    const stillValid = await client.callTool({ name: "code_read", arguments: { path: "gen/g.ts", symbol: "g" } });
    check("file unchanged after guarded rejection", resultText(stillValid).includes("return 1;") && resultText(stillValid).includes("}"));

    // apply_patch: atomic multi-file batch over the wire
    await client.callTool({ name: "code_write", arguments: { path: "gen/p1.ts", content: "export const one = 1;\n" } });
    await client.callTool({ name: "code_write", arguments: { path: "gen/p2.ts", content: "export const two = 2;\n" } });
    const patched = await client.callTool({
      name: "apply_patch",
      arguments: { edits: [
        { path: "gen/p1.ts", oldString: "one = 1", newString: "one = 11" },
        { path: "gen/p2.ts", oldString: "two = 2", newString: "two = 22" },
      ] },
    });
    check("apply_patch applies a batch over the wire", !patched.isError && resultText(patched).includes("2 file(s)"));
    const p1 = await client.callTool({ name: "code_read", arguments: { path: "gen/p1.ts" } });
    const p2 = await client.callTool({ name: "code_read", arguments: { path: "gen/p2.ts" } });
    check("apply_patch batch persisted both files", resultText(p1).includes("one = 11") && resultText(p2).includes("two = 22"));
    const editEscape = await client.callTool({
      name: "code_edit",
      arguments: { path: "../../../etc/hosts", oldString: "a", newString: "b" },
    });
    check("code_edit blocks path traversal over the wire", editEscape.isError === true);

    const searched = await client.callTool({
      name: "code_search",
      arguments: { pattern: "function add", outputMode: "content" },
    });
    check("code_search finds over the wire", resultText(searched).includes("sample.ts:") && resultText(searched).includes("function add"));

    const refs = await client.callTool({ name: "find_references", arguments: { symbol: "add" } });
    const refsTxt = resultText(refs);
    check("find_references over the wire", !refs.isError && refsTxt.includes("Definitions of \"add\"") && refsTxt.includes("sample.ts:"));

    const gctx = await client.callTool({ name: "grep_context", arguments: { pattern: "return a \\+ b", path: "sample.ts" } });
    check("grep_context over the wire", !gctx.isError && resultText(gctx).includes("sample.ts › function add") && resultText(gctx).includes("›"));

    const cctx = await client.callTool({ name: "code_context", arguments: { symbol: "add" } });
    check("code_context over the wire", !cctx.isError && resultText(cctx).includes("code_context: add") && resultText(cctx).includes("Definition — function add"));

    const map = await client.callTool({ name: "repo_map", arguments: {} });
    const mapTxt = resultText(map);
    check("repo_map over the wire", !map.isError && mapTxt.includes("repo map —") && mapTxt.includes("sample.ts"));

    // The e2e workspace is a temp dir (not a git repo) — diff_digest must
    // respond gracefully over the wire rather than crash.
    const dd = await client.callTool({ name: "diff_digest", arguments: {} });
    check("diff_digest responds gracefully (non-repo) over the wire", dd.isError === true && resultText(dd).includes("not a git repository"));
    const rb = await client.callTool({ name: "review_branch", arguments: {} });
    check("review_branch responds gracefully (non-repo) over the wire", rb.isError === true && resultText(rb).includes("not a git repository"));

    const checked = await client.callTool({ name: "code_check", arguments: { script: "ok" } });
    check("code_check runs a script over the wire", !checked.isError && resultText(checked).includes("✓ ok: passed"));
    const located = await client.callTool({ name: "check_locate", arguments: { script: "ok" } });
    check("check_locate runs a script over the wire", !located.isError && resultText(located).includes("✓ ok: passed"));

    const escaped = await client.callTool({
      name: "code_read",
      arguments: { path: "../../../etc/hosts" },
    });
    check(
      "sandbox rejects path traversal over the wire",
      escaped.isError === true && resultText(escaped).includes("escapes workspace root"),
    );
  } finally {
    await client.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(`\n${failed === 0 ? "ALL PASS" : "SOME FAILED"} — ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  })
  .catch((err: unknown) => {
    console.error(`\nE2E CRASHED — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exitCode = 1;
  });
