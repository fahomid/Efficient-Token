/**
 * One-shot health probe: spawn the built server (`dist/index.js`) over a real MCP
 * stdio transport, call the `health` tool, and print its output. A protocol-level
 * check that the server starts, speaks MCP, exposes its tools, and is pointed at
 * the right workspace — with no model involved.
 *
 * Requires a prior `npm run build`. Run: `npm run health`.
 * Probe a specific project by setting EFFICIENT_TOKEN_ROOT to its path; it
 * defaults to the current working directory.
 *
 * Note: this starts a fresh server process, so the savings ledger reads zero.
 * It verifies liveness/config, not a live Claude session's accumulated savings
 * (those live in that session's own server process).
 */
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// callTool returns a union whose content items type `text` as unknown; pull it out defensively.
function resultText(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: unknown }> }).content ?? [];
  return content
    .filter((c) => c.type === "text")
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("\n");
}

async function main(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  const transport = new StdioClientTransport({
    command: process.execPath, // current node binary
    args: [path.resolve("dist/index.js")],
    env,
    stderr: "inherit",
  });
  const client = new Client({ name: "efficient-token-health", version: "0.0.0" });

  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const res = await client.callTool({ name: "health", arguments: {} });
    const text = resultText(res);
    console.log(text);
    console.log(`tools exposed: ${tools.length}`);
    if (res.isError === true || !text.includes("efficient-token: ok")) {
      process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(`health probe failed — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 1;
});
