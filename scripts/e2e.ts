/**
 * End-to-end integration test: spawn the built server (`dist/index.js`) and
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
    path.join(root, "pixel.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
  );
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
      "tools/list returns the forty-five free tools",
      names.join(",") === "apply_patch,call_hierarchy,call_sites,change_coverage,check_locate,code_check,code_context,code_edit,code_outline,code_read,code_search,code_write,color_contrast,commit_log,conflict_digest,design_tokens,diff_digest,find_references,font_info,glob,grep_context,health,import_map,json_query,line_blame,marker_inventory,media_info,move_symbol,note_read,note_write,outline_diff,project_rename,read_at_rev,read_many,replace_symbol,repo_map,review_branch,svg_digest,symbol_find,symbol_history,test_run,token_usage,trace_locate,type_closure,view_image",
      names.join(","),
    );
    const byName = new Map(tools.map((t) => [t.name, t]));
    check(
      "read tools annotated read-only",
      ["health", "code_outline", "code_read", "code_search", "find_references", "repo_map", "diff_digest", "grep_context", "code_context", "review_branch", "glob", "symbol_find", "read_many", "json_query", "read_at_rev", "symbol_history", "conflict_digest", "change_coverage", "call_sites", "commit_log", "line_blame", "marker_inventory", "trace_locate", "import_map", "type_closure", "call_hierarchy", "outline_diff", "view_image", "media_info", "design_tokens", "color_contrast", "svg_digest", "font_info", "token_usage"].every(
        (n) => byName.get(n)?.annotations?.readOnlyHint === true && byName.get(n)?.annotations?.openWorldHint === false,
      ),
    );
    check(
      "write tools annotated destructive (not read-only)",
      ["code_edit", "code_write", "apply_patch", "replace_symbol", "move_symbol"].every(
        (n) => byName.get(n)?.annotations?.readOnlyHint === false && byName.get(n)?.annotations?.destructiveHint === true,
      ),
    );
    check(
      "exec tools annotated non-read-only",
      ["code_check", "check_locate", "test_run"].every((n) => byName.get(n)?.annotations?.readOnlyHint === false),
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
      arguments: { file_path: "sample.ts", symbol: "add" },
    });
    const readTxt = resultText(read);
    check(
      "code_read symbol round-trips",
      readTxt.includes("function add") && readTxt.includes("return a + b;"),
    );

    // write -> read -> edit -> read round-trip over the wire
    const wrote = await client.callTool({
      name: "code_write",
      arguments: { file_path: "gen/hello.txt", content: "one\ntwo\n" },
    });
    check("code_write creates a file over the wire", !wrote.isError && resultText(wrote).includes("Created"));
    const readBack = await client.callTool({ name: "code_read", arguments: { file_path:"gen/hello.txt" } });
    check("written file reads back", resultText(readBack).includes("two"));
    const edited = await client.callTool({
      name: "code_edit",
      arguments: { file_path: "gen/hello.txt", old_string: "two", new_string: "TWO" },
    });
    check("code_edit applies over the wire", !edited.isError && resultText(edited).includes("replacement"));
    const confirm = await client.callTool({ name: "code_read", arguments: { file_path: "gen/hello.txt" } });
    check("edit persisted", resultText(confirm).includes("TWO") && !resultText(confirm).includes("two"));

    // syntax recovery guard over the wire: a brace-breaking edit is refused and rolled back
    await client.callTool({ name: "code_write", arguments: { file_path:"gen/g.ts", content: "export function g() {\n  return 1;\n}\n" } });
    const breakEdit = await client.callTool({ name: "code_edit", arguments: { file_path: "gen/g.ts", old_string: "  return 1;\n}", new_string: "  return 1;" } });
    check("code_edit syntax guard rejects over the wire", breakEdit.isError === true && resultText(breakEdit).includes("syntax error"));
    const stillValid = await client.callTool({ name: "code_read", arguments: { file_path:"gen/g.ts", symbol: "g" } });
    check("file unchanged after guarded rejection", resultText(stillValid).includes("return 1;") && resultText(stillValid).includes("}"));

    // apply_patch: atomic multi-file batch over the wire
    await client.callTool({ name: "code_write", arguments: { file_path:"gen/p1.ts", content: "export const one = 1;\n" } });
    await client.callTool({ name: "code_write", arguments: { file_path:"gen/p2.ts", content: "export const two = 2;\n" } });
    const patched = await client.callTool({
      name: "apply_patch",
      arguments: { edits: [
        { file_path: "gen/p1.ts", old_string: "one = 1", new_string: "one = 11" },
        { file_path: "gen/p2.ts", old_string: "two = 2", new_string: "two = 22" },
      ] },
    });
    check("apply_patch applies a batch over the wire", !patched.isError && resultText(patched).includes("2 file(s)"));
    const p1 = await client.callTool({ name: "code_read", arguments: { file_path:"gen/p1.ts" } });
    const p2 = await client.callTool({ name: "code_read", arguments: { file_path:"gen/p2.ts" } });
    check("apply_patch batch persisted both files", resultText(p1).includes("one = 11") && resultText(p2).includes("two = 22"));
    const editEscape = await client.callTool({
      name: "code_edit",
      arguments: { file_path: "../../../etc/hosts", old_string: "a", new_string: "b" },
    });
    check("code_edit blocks path traversal over the wire", editEscape.isError === true);

    // replace_symbol: rewrite a whole definition by name over the wire
    const rsWire = await client.callTool({
      name: "replace_symbol",
      arguments: { path: "sample.ts", symbol: "add", newSource: "export function add(a: number, b: number): number {\n  return a + b + 1;\n}" },
    });
    check("replace_symbol rewrites a definition over the wire", !rsWire.isError && resultText(rsWire).includes("Replaced function add"));
    const rsConfirm = await client.callTool({ name: "code_read", arguments: { file_path:"sample.ts", symbol: "add" } });
    check("replace_symbol persisted", resultText(rsConfirm).includes("return a + b + 1;"));

    const searched = await client.callTool({
      name: "code_search",
      arguments: { pattern: "function add", output_mode: "content" },
    });
    check("code_search finds over the wire", resultText(searched).includes("sample.ts:") && resultText(searched).includes("function add"));

    const refs = await client.callTool({ name: "find_references", arguments: { symbol: "add" } });
    const refsTxt = resultText(refs);
    check("find_references over the wire", !refs.isError && refsTxt.includes("Definitions of \"add\"") && refsTxt.includes("sample.ts:"));

    const gctx = await client.callTool({ name: "grep_context", arguments: { pattern: "return a \\+ b", path: "sample.ts" } });
    check("grep_context over the wire", !gctx.isError && resultText(gctx).includes("sample.ts › function add") && resultText(gctx).includes("›"));

    const globbed = await client.callTool({ name: "glob", arguments: { pattern: "*.ts" } });
    check("glob over the wire", !globbed.isError && resultText(globbed).includes("sample.ts"));

    const symFound = await client.callTool({ name: "symbol_find", arguments: { name: "Greeter" } });
    check("symbol_find over the wire", !symFound.isError && resultText(symFound).includes("sample.ts:") && resultText(symFound).includes("class Greeter"));

    await client.callTool({ name: "code_write", arguments: { file_path:"gen/caller.ts", content: "export function caller() {\n  return add(1, 2) + add(3, 4);\n}\n" } });
    const callsRes = await client.callTool({ name: "call_sites", arguments: { symbol: "add", path: "gen" } });
    check("call_sites over the wire", !callsRes.isError && resultText(callsRes).includes("gen/caller.ts:2") && resultText(callsRes).includes("caller"));

    await client.callTool({ name: "code_write", arguments: { file_path:"gen/todo.ts", content: "// TODO: wire this up\nexport const z = 1;\n" } });
    const markers = await client.callTool({ name: "marker_inventory", arguments: { path: "gen" } });
    check("marker_inventory over the wire", !markers.isError && resultText(markers).includes("TODO (1)") && resultText(markers).includes("wire this up"));

    const traced = await client.callTool({ name: "trace_locate", arguments: { trace: "Error\n    at add (sample.ts:2:5)\n" } });
    check("trace_locate over the wire", !traced.isError && resultText(traced).includes("sample.ts:2") && resultText(traced).includes("return a + b"));

    await client.callTool({ name: "code_write", arguments: { file_path:"gen/dep.ts", content: "export const dep = 1;\n" } });
    await client.callTool({ name: "code_write", arguments: { file_path:"gen/user.ts", content: "import { dep } from './dep.js';\nexport const u = dep;\n" } });
    const imap = await client.callTool({ name: "import_map", arguments: { path: "gen/dep.ts", direction: "importers" } });
    check("import_map over the wire", !imap.isError && resultText(imap).includes("gen/user.ts:1"));

    await client.callTool({ name: "code_write", arguments: { file_path:"gen/types.ts", content: "export interface Inner { v: number; }\nexport interface Outer { inner: Inner; }\n" } });
    const tclo = await client.callTool({ name: "type_closure", arguments: { symbol: "Outer", path: "gen" } });
    check("type_closure over the wire", !tclo.isError && resultText(tclo).includes("interface Outer") && resultText(tclo).includes("interface Inner"));

    await client.callTool({ name: "code_write", arguments: { file_path:"gen/ch.ts", content: "export function leaf() { return 1; }\nexport function root() {\n  return leaf();\n}\n" } });
    const chy = await client.callTool({ name: "call_hierarchy", arguments: { symbol: "root", path: "gen" } });
    check("call_hierarchy over the wire", !chy.isError && resultText(chy).includes("callees (1)") && resultText(chy).includes("leaf"));

    await client.callTool({ name: "code_write", arguments: { file_path:"mv/src.ts", content: "export function widget() {\n  return 1;\n}\n" } });
    await client.callTool({ name: "code_write", arguments: { file_path:"mv/dst.ts", content: "export const k = 0;\n" } });
    const moved = await client.callTool({ name: "move_symbol", arguments: { symbol: "widget", from: "mv/src.ts", to: "mv/dst.ts" } });
    check("move_symbol over the wire", !moved.isError && resultText(moved).includes("Moved function widget"));
    const dstRead = await client.callTool({ name: "code_read", arguments: { file_path:"mv/dst.ts", symbol: "widget" } });
    check("move_symbol persisted", resultText(dstRead).includes("function widget"));

    const readMany = await client.callTool({ name: "read_many", arguments: { reads: [{ path: "sample.ts", symbol: "add" }, { path: "sample.ts", symbol: "Greeter" }] } });
    const rmt = resultText(readMany);
    check("read_many over the wire", !readMany.isError && rmt.includes("symbol=add") && rmt.includes("function add") && rmt.includes("symbol=Greeter") && rmt.includes("class Greeter"));

    const jq = await client.callTool({ name: "json_query", arguments: { path: "package.json", query: "scripts.ok" } });
    check("json_query slice over the wire", !jq.isError && resultText(jq).includes("process.exit"));
    const jqOv = await client.callTool({ name: "json_query", arguments: { path: "package.json" } });
    check("json_query overview over the wire", !jqOv.isError && resultText(jqOv).includes("scripts: object"));

    const cctx = await client.callTool({ name: "code_context", arguments: { symbol: "add" } });
    check("code_context over the wire", !cctx.isError && resultText(cctx).includes("code_context: add") && resultText(cctx).includes("Definition — function add"));

    const map = await client.callTool({ name: "repo_map", arguments: {} });
    const mapTxt = resultText(map);
    check("repo_map over the wire", !map.isError && mapTxt.includes("repo map —") && mapTxt.includes("sample.ts"));

    // The e2e workspace is a temp dir (not a git repo), so diff_digest should
    // respond gracefully over the wire rather than crash.
    const dd = await client.callTool({ name: "diff_digest", arguments: {} });
    check("diff_digest responds gracefully (non-repo) over the wire", dd.isError === true && resultText(dd).includes("not a git repository"));
    const rb = await client.callTool({ name: "review_branch", arguments: {} });
    check("review_branch responds gracefully (non-repo) over the wire", rb.isError === true && resultText(rb).includes("not a git repository"));
    const rar = await client.callTool({ name: "read_at_rev", arguments: { path: "sample.ts", ref: "HEAD" } });
    check("read_at_rev responds gracefully (non-repo) over the wire", rar.isError === true && resultText(rar).includes("not a git repository"));
    const sh = await client.callTool({ name: "symbol_history", arguments: { path: "sample.ts", symbol: "add" } });
    check("symbol_history responds gracefully (non-repo) over the wire", sh.isError === true && resultText(sh).includes("not a git repository"));
    const cd = await client.callTool({ name: "conflict_digest", arguments: {} });
    check("conflict_digest responds gracefully (non-repo) over the wire", cd.isError === true && resultText(cd).includes("not a git repository"));
    const chc = await client.callTool({ name: "change_coverage", arguments: {} });
    check("change_coverage responds gracefully (non-repo) over the wire", chc.isError === true && resultText(chc).includes("not a git repository"));
    const cl = await client.callTool({ name: "commit_log", arguments: {} });
    check("commit_log responds gracefully (non-repo) over the wire", cl.isError === true && resultText(cl).includes("not a git repository"));
    const lb = await client.callTool({ name: "line_blame", arguments: { path: "sample.ts" } });
    check("line_blame responds gracefully (non-repo) over the wire", lb.isError === true && resultText(lb).includes("not a git repository"));
    const od = await client.callTool({ name: "outline_diff", arguments: { ref: "HEAD" } });
    check("outline_diff responds gracefully (non-repo) over the wire", od.isError === true && resultText(od).includes("not a git repository"));

    const checked = await client.callTool({ name: "code_check", arguments: { script: "ok" } });
    check("code_check runs a script over the wire", !checked.isError && resultText(checked).includes("✓ ok: passed"));
    const located = await client.callTool({ name: "check_locate", arguments: { script: "ok" } });
    check("check_locate runs a script over the wire", !located.isError && resultText(located).includes("✓ ok: passed"));
    const tested = await client.callTool({ name: "test_run", arguments: { script: "ok", filter: "some test" } });
    check("test_run runs a filtered script over the wire", !tested.isError && resultText(tested).includes("passed"));
    const injected = await client.callTool({ name: "test_run", arguments: { script: "ok", filter: "x; echo HACKED" } });
    check("test_run rejects an injection filter over the wire", injected.isError === true && resultText(injected).includes("invalid filter"));

    await client.callTool({ name: "note_write", arguments: { name: "scratch", content: "remember this\n" } });
    const noteRead = await client.callTool({ name: "note_read", arguments: { name: "scratch" } });
    check("note write/read round-trips over the wire", !noteRead.isError && resultText(noteRead).includes("remember this"));

    await client.callTool({ name: "code_write", arguments: { file_path:"ren/r.ts", content: "export const foo = 1;\nexport const z = foo + foo;\n" } });
    const renamed = await client.callTool({ name: "project_rename", arguments: { oldName: "foo", newName: "bar", path: "ren" } });
    check("project_rename over the wire", !renamed.isError && resultText(renamed).includes("3 occurrence(s)"));
    const renRead = await client.callTool({ name: "code_read", arguments: { file_path:"ren/r.ts" } });
    check("project_rename persisted", resultText(renRead).includes("bar = 1") && resultText(renRead).includes("bar + bar") && !resultText(renRead).includes("foo"));

    const viewed = await client.callTool({ name: "view_image", arguments: { paths: ["pixel.png"] } });
    const viewedContent = (viewed.content ?? []) as Array<{ type: string; mimeType?: string; data?: string }>;
    check(
      "view_image returns an image block over the wire",
      !viewed.isError && viewedContent.some((c) => c.type === "image" && c.mimeType === "image/png" && typeof c.data === "string" && c.data.length > 0),
    );

    const minfo = await client.callTool({ name: "media_info", arguments: { paths: ["pixel.png"] } });
    check("media_info over the wire", !minfo.isError && resultText(minfo).includes("png 1x1"));

    await client.callTool({ name: "code_write", arguments: { file_path:"theme.css", content: ":root {\n  --color-bg: #ffffff;\n  --gap: 12px;\n}\n" } });
    const dtoks = await client.callTool({ name: "design_tokens", arguments: { paths: ["theme.css"] } });
    check("design_tokens over the wire", !dtoks.isError && resultText(dtoks).includes("--color-bg = #ffffff") && resultText(dtoks).includes("12px"));

    const contrast = await client.callTool({ name: "color_contrast", arguments: { color: "#000", against: "#fff" } });
    check("color_contrast over the wire", !contrast.isError && resultText(contrast).includes("21:1"));

    await client.callTool({ name: "code_write", arguments: { file_path:"logo.svg", content: '<svg viewBox="0 0 16 16"><path d="M1 1"/></svg>\n' } });
    const svgd = await client.callTool({ name: "svg_digest", arguments: { path: "logo.svg" } });
    check("svg_digest over the wire", !svgd.isError && resultText(svgd).includes("viewBox: 0 0 16 16") && resultText(svgd).includes("path×1"));

    await client.callTool({ name: "code_write", arguments: { file_path:"fonts.css", content: "@font-face { font-family: 'Roboto'; font-weight: 700; }\n" } });
    const finfo = await client.callTool({ name: "font_info", arguments: { paths: ["fonts.css"] } });
    check("font_info over the wire", !finfo.isError && resultText(finfo).includes('family "Roboto"') && resultText(finfo).includes("weight 700"));

    await client.callTool({ name: "code_write", arguments: { file_path:"vars.css", content: ":root { --a: 1px; }\n.x { width: var(--b); }\n" } });
    const tusage = await client.callTool({ name: "token_usage", arguments: { paths: ["vars.css"] } });
    check("token_usage over the wire", !tusage.isError && resultText(tusage).includes("--a") && resultText(tusage).includes("--b"));

    const escaped = await client.callTool({
      name: "code_read",
      arguments: { file_path: "../../../etc/hosts" },
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
