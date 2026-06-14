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
      "tools/list returns the seven free tools",
      names.join(",") === "code_edit,code_outline,code_read,code_search,code_write,find_references,health",
      names.join(","),
    );
    const byName = new Map(tools.map((t) => [t.name, t]));
    check(
      "read tools annotated read-only",
      ["health", "code_outline", "code_read", "code_search", "find_references"].every(
        (n) => byName.get(n)?.annotations?.readOnlyHint === true && byName.get(n)?.annotations?.openWorldHint === false,
      ),
    );
    check(
      "write tools annotated destructive (not read-only)",
      ["code_edit", "code_write"].every(
        (n) => byName.get(n)?.annotations?.readOnlyHint === false && byName.get(n)?.annotations?.destructiveHint === true,
      ),
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
